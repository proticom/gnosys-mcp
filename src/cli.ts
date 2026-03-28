#!/usr/bin/env node
/**
 * Gnosys CLI — Thin wrapper around the core modules.
 * Uses the resolver for layered multi-store support.
 */

import { Command } from "commander";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { readFileSync, existsSync, copyFileSync } from "fs";
import { GnosysResolver } from "./lib/resolver.js";
import { GnosysSearch } from "./lib/search.js";
import { GnosysTagRegistry } from "./lib/tags.js";
import { GnosysIngestion } from "./lib/ingest.js";
import { applyLens, applyCompoundLens, LensFilter } from "./lib/lensing.js";
import { getFileHistory, getFileAtCommit, rollbackToCommit, hasGitHistory, getFileDiff } from "./lib/history.js";
import { groupByPeriod, computeStats, TimePeriod } from "./lib/timeline.js";
import { buildLinkGraph, getBacklinks, getOutgoingLinks, formatGraphSummary } from "./lib/wikilinks.js";
import { bootstrap, discoverFiles } from "./lib/bootstrap.js";
import { performImport, formatImportSummary, estimateDuration } from "./lib/import.js";
import { loadConfig, generateConfigTemplate, GnosysConfig, DEFAULT_CONFIG, writeConfig, updateConfig, resolveTaskModel, ALL_PROVIDERS, LLMProviderName, getProviderModel } from "./lib/config.js";
import { GnosysEmbeddings } from "./lib/embeddings.js";
import { GnosysHybridSearch } from "./lib/hybridSearch.js";
import { GnosysAsk } from "./lib/ask.js";
import { getLLMProvider, isProviderAvailable, LLMProvider } from "./lib/llm.js";
import { GnosysDB } from "./lib/db.js";
import { migrate, formatMigrationReport } from "./lib/migrate.js";
import { createProjectIdentity, readProjectIdentity, findProjectIdentity, migrateProject } from "./lib/projectIdentity.js";
import { setPreference, getPreference, getAllPreferences, deletePreference } from "./lib/preferences.js";
import { syncRules, syncToTarget } from "./lib/rulesGen.js";

// Load API keys from ~/.config/gnosys/.env (same as MCP server)
// IMPORTANT: We use dotenv.parse() instead of dotenv.config() because
// dotenv v17+ writes injection notices to stdout, which corrupts
// --json output and piped usage. parse() is a pure function with no side effects.
const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
try {
  const envFile = readFileSync(path.join(home, ".config", "gnosys", ".env"), "utf8");
  const parsed = dotenv.parse(envFile);
  for (const [key, val] of Object.entries(parsed)) {
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env file not found — that's fine, env vars may be set elsewhere
}
// Also try .env from current directory as fallback
try {
  const localEnv = readFileSync(".env", "utf8");
  const localParsed = dotenv.parse(localEnv);
  for (const [key, val] of Object.entries(localParsed)) {
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // No local .env — fine
}

// Read version from package.json at build time
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));

const program = new Command();

async function getResolver(): Promise<GnosysResolver> {
  const resolver = new GnosysResolver();
  await resolver.resolve();
  return resolver;
}

/**
 * v3.0: Resolve projectId from nearest .gnosys/gnosys.json.
 * Used by CLI write commands to tag memories with the correct project.
 */
async function resolveProjectId(dir?: string): Promise<string | null> {
  const result = await findProjectIdentity(dir || process.cwd());
  return result?.identity.projectId || null;
}

/**
 * Output helper: if --json flag is set, output JSON; otherwise call the
 * human-readable formatter function.
 */
function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

program
  .name("gnosys")
  .description("Gnosys — Persistent memory for AI agents. Sandbox-first runtime, central SQLite brain, federated search, reflection API, process tracing, preferences, Dream Mode, Obsidian export. Also runs as a full MCP server.")
  .version(pkg.version)
  .hook("preAction", async () => {
    // Check if central DB was upgraded to a newer version on another machine
    try {
      const centralDb = GnosysDB.openCentral();
      if (centralDb.isAvailable()) {
        const dbVersion = centralDb.getMeta("app_version");
        if (dbVersion && dbVersion !== pkg.version) {
          const upgradedBy = centralDb.getMeta("upgraded_by") || "another machine";
          console.error(
            `\n⚠ Gnosys DB was upgraded to v${dbVersion} by ${upgradedBy}.` +
            `\n  You are running v${pkg.version}. Run: npm install -g gnosys && gnosys upgrade\n`
          );
        }
        centralDb.close();
      }
    } catch {
      // non-critical — don't block the command
    }
  });

// ─── gnosys read <path> ──────────────────────────────────────────────────
program
  .command("read <memoryPath>")
  .description(
    "Read a specific memory. Supports layer prefix (e.g., project:decisions/auth.md)"
  )
  .option("--json", "Output as JSON")
  .action(async (memoryPath: string, opts: { json?: boolean }) => {
    const resolver = await getResolver();
    const memory = await resolver.readMemory(memoryPath);
    if (!memory) {
      console.error(`Memory not found: ${memoryPath}`);
      process.exit(1);
    }
    const raw = await fs.readFile(memory.filePath, "utf-8");
    outputResult(!!opts.json, { path: memoryPath, source: memory.sourceLabel, content: raw }, () => {
      console.log(`[Source: ${memory.sourceLabel}]\n`);
      console.log(raw);
    });
  });

// ─── gnosys discover <query> ─────────────────────────────────────────────
program
  .command("discover <query>")
  .description("Discover relevant memories by keyword. Use --federated for tier-boosted cross-scope discovery.")
  .option("-n, --limit <number>", "Max results", "20")
  .option("--json", "Output as JSON")
  .option("--federated", "Use federated discovery with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated for multiple)")
  .option("-d, --directory <dir>", "Project directory for context")
  .action(async (query: string, opts: { limit: string; json?: boolean; federated?: boolean; scope?: string; directory?: string }) => {
    // Federated discover path
    if (opts.federated || opts.scope) {
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

        const { federatedDiscover, detectCurrentProject } = await import("./lib/federated.js");
        const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
        const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
        const results = federatedDiscover(centralDb, query, {
          limit: parseInt(opts.limit, 10),
          projectId,
          scopeFilter,
        });

        outputResult(!!opts.json, { query, projectId, count: results.length, results }, () => {
          if (results.length === 0) { console.log(`No memories found for "${query}".`); return; }
          for (const [i, r] of results.entries()) {
            const proj = r.projectName ? ` [${r.projectName}]` : "";
            console.log(`${i + 1}. ${r.title} (${r.category})${proj}`);
            console.log(`   scope: ${r.scope} | score: ${r.score.toFixed(4)}`);
          }
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        centralDb?.close();
      }
      return;
    }

    // Legacy file-based discover path
    const resolver = await getResolver();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No Gnosys stores found.");
      process.exit(1);
    }

    const search = new GnosysSearch(stores[0].path);
    search.clearIndex();
    for (const s of stores) {
      await search.addStoreMemories(s.store, s.label);
    }

    const results = search.discover(query, parseInt(opts.limit));
    if (results.length === 0) {
      outputResult(!!opts.json, { query, results: [] }, () => {
        console.log(`No memories found for "${query}". Try gnosys search for full-text.`);
      });
      search.close();
      return;
    }

    outputResult(!!opts.json, { query, count: results.length, results }, () => {
      console.log(`Found ${results.length} relevant memories for "${query}":\n`);
      for (const r of results) {
        console.log(`  ${r.title}`);
        console.log(`  ${r.relative_path}`);
        if (r.relevance) console.log(`  Relevance: ${r.relevance}`);
        console.log();
      }
    });
    search.close();
  });

// ─── gnosys search <query> ───────────────────────────────────────────────
program
  .command("search <query>")
  .description("Search memories by keyword. Use --federated for tier-boosted cross-scope search.")
  .option("-n, --limit <number>", "Max results", "20")
  .option("--json", "Output as JSON")
  .option("--federated", "Use federated search with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated for multiple)")
  .option("-d, --directory <dir>", "Project directory for context")
  .action(async (query: string, opts: { limit: string; json?: boolean; federated?: boolean; scope?: string; directory?: string }) => {
    // Federated search path — uses central DB with tier boosting
    if (opts.federated || opts.scope) {
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) { console.error("Central DB not available. Run 'gnosys migrate --to-central' first."); process.exit(1); }

        const { federatedSearch, detectCurrentProject } = await import("./lib/federated.js");
        const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
        const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
        const results = federatedSearch(centralDb, query, {
          limit: parseInt(opts.limit, 10),
          projectId,
          scopeFilter,
        });

        outputResult(!!opts.json, { query, projectId, count: results.length, results }, () => {
          if (results.length === 0) { console.log(`No results for "${query}".`); return; }
          const ctx = projectId ? `Context: project ${projectId}` : "No project detected";
          console.log(ctx);
          for (const [i, r] of results.entries()) {
            const proj = r.projectName ? ` [${r.projectName}]` : "";
            console.log(`\n${i + 1}. ${r.title} (${r.category})${proj}`);
            console.log(`   scope: ${r.scope} | score: ${r.score.toFixed(4)} | boosts: ${r.boosts.join(", ")}`);
            if (r.snippet) console.log(`   ${r.snippet.substring(0, 120)}`);
          }
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        centralDb?.close();
      }
      return;
    }

    // Legacy file-based search path
    const resolver = await getResolver();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No Gnosys stores found.");
      process.exit(1);
    }

    const search = new GnosysSearch(stores[0].path);
    search.clearIndex();
    for (const s of stores) {
      await search.addStoreMemories(s.store, s.label);
    }

    const results = search.search(query, parseInt(opts.limit));
    if (results.length === 0) {
      outputResult(!!opts.json, { query, results: [] }, () => {
        console.log(`No results for "${query}".`);
      });
      search.close();
      return;
    }

    outputResult(!!opts.json, { query, count: results.length, results }, () => {
      console.log(`Found ${results.length} results for "${query}":\n`);
      for (const r of results) {
        console.log(`  ${r.title}`);
        console.log(`  ${r.relative_path}`);
        console.log(
          `  ${r.snippet.replace(/>>>/g, "").replace(/<<</g, "")}`
        );
        console.log();
      }
    });
    search.close();
  });

// ─── gnosys list ─────────────────────────────────────────────────────────
program
  .command("list")
  .description("List all memories across all stores")
  .option("-c, --category <category>", "Filter by category")
  .option("-t, --tag <tag>", "Filter by tag")
  .option("-s, --store <store>", "Filter by store layer")
  .option("--json", "Output as JSON")
  .action(
    async (opts: { category?: string; tag?: string; store?: string; json?: boolean }) => {
      const resolver = await getResolver();
      let memories = await resolver.getAllMemories();

      if (opts.store) {
        memories = memories.filter(
          (m) =>
            m.sourceLayer === opts.store || m.sourceLabel === opts.store
        );
      }
      if (opts.category) {
        memories = memories.filter(
          (m) => m.frontmatter.category === opts.category
        );
      }
      if (opts.tag) {
        memories = memories.filter((m) => {
          const tags = Array.isArray(m.frontmatter.tags)
            ? m.frontmatter.tags
            : Object.values(m.frontmatter.tags).flat();
          return tags.includes(opts.tag!);
        });
      }

      outputResult(!!opts.json, {
        count: memories.length,
        memories: memories.map((m) => ({
          id: m.frontmatter.id,
          title: m.frontmatter.title,
          category: m.frontmatter.category,
          status: m.frontmatter.status,
          source: m.sourceLabel,
          path: `${m.sourceLabel}:${m.relativePath}`,
        })),
      }, () => {
        console.log(`${memories.length} memories:\n`);
        for (const m of memories) {
          console.log(
            `  [${m.sourceLabel}] [${m.frontmatter.status}] ${m.frontmatter.title}`
          );
          console.log(`    ${m.sourceLabel}:${m.relativePath}`);
          console.log();
        }
      });
    }
  );

// ─── gnosys add <input> ──────────────────────────────────────────────────
program
  .command("add <input>")
  .description("Add a new memory (uses LLM to structure raw input)")
  .option(
    "-a, --author <author>",
    "Author (human|ai|human+ai)",
    "human"
  )
  .option(
    "--authority <authority>",
    "Authority level (declared|observed|imported|inferred)",
    "declared"
  )
  .option(
    "-s, --store <store>",
    "Target store (project|personal|global)",
    undefined
  )
  .action(
    async (
      input: string,
      opts: { author: string; authority: string; store?: string }
    ) => {
      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget(
        (opts.store as any) || undefined
      );
      if (!writeTarget) {
        console.error(
          "No writable store found. Create a .gnosys/ directory or set GNOSYS_PERSONAL."
        );
        process.exit(1);
      }

      // Check if input is a file path — if so, route through multimodal ingestion
      if (existsSync(input)) {
        const { ingestFile } = await import("./lib/multimodalIngest.js");
        const storePath = writeTarget.store.getStorePath();
        console.log(`Detected file: ${input}`);
        console.log("Ingesting via multimodal pipeline...");

        const result = await ingestFile({
          filePath: path.resolve(input),
          storePath,
          mode: "llm",
          author: opts.author as "human" | "ai" | "human+ai",
          authority: opts.authority as "declared" | "observed" | "imported" | "inferred",
          onProgress: (p) => {
            console.log(`  [${p.current}/${p.total}] ${p.title || "Processing..."}`);
          },
        });

        console.log(`\nFile type: ${result.fileType}`);
        console.log(`Memories created: ${result.memories.length}`);
        console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);

        for (const mem of result.memories) {
          console.log(`  ${mem.id}: ${mem.title}`);
        }

        if (result.errors.length > 0) {
          console.error(`\nErrors (${result.errors.length}):`);
          for (const err of result.errors) {
            console.error(`  Chunk ${err.chunk}: ${err.error}`);
          }
        }

        return;
      }

      const tagRegistry = new GnosysTagRegistry(
        writeTarget.store.getStorePath()
      );
      await tagRegistry.load();
      const ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);

      if (!ingestion.isLLMAvailable) {
        console.error(
          "Error: No LLM provider available. Add an API key to ~/.config/gnosys/.env or use a local model: gnosys config set provider ollama"
        );
        process.exit(1);
      }

      console.log("Structuring memory via LLM...");
      const result = await ingestion.ingest(input);

      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        const projectId = await resolveProjectId();
        const id = centralDb.getNextId(result.category, projectId || undefined);
        const today = new Date().toISOString().split("T")[0];
        const now = new Date().toISOString();
        const content = `# ${result.title}\n\n${result.content}`;

        const tags = result.tags;
        const tagsJson = Array.isArray(tags)
          ? JSON.stringify(tags)
          : JSON.stringify(Object.values(tags).flat());

        centralDb.insertMemory({
          id,
          title: result.title,
          category: result.category,
          content,
          summary: null,
          tags: tagsJson,
          relevance: result.relevance,
          author: opts.author,
          authority: opts.authority,
          confidence: result.confidence,
          reinforcement_count: 0,
          content_hash: "",
          status: "active",
          tier: "active",
          supersedes: null,
          superseded_by: null,
          last_reinforced: null,
          created: now,
          modified: now,
          embedding: null,
          source_path: null,
          project_id: projectId,
          scope: "project",
        });

        console.log(`\nMemory added to [${writeTarget.label}]: ${result.title}`);
        console.log(`ID: ${id}`);
        console.log(`Category: ${result.category}`);
        console.log(`Confidence: ${result.confidence}`);
      } finally {
        centralDb?.close();
      }

      if (result.proposedNewTags && result.proposedNewTags.length > 0) {
        console.log("\nProposed new tags (not yet in registry):");
        for (const t of result.proposedNewTags) {
          console.log(`  ${t.category}:${t.tag}`);
        }
      }
    }
  );

// ─── gnosys setup ───────────────────────────────────────────────────────
program
  .command("setup")
  .description("Interactive setup wizard — configure LLM provider, API key, model, and IDE integration in one step")
  .option("--non-interactive", "Skip prompts, use defaults (for CI/scripting)")
  .action(async (opts: { nonInteractive?: boolean }) => {
    const { runSetup } = await import("./lib/setup.js");
    await runSetup({
      directory: process.cwd(),
      nonInteractive: opts.nonInteractive,
    });
  });

// ─── gnosys init ─────────────────────────────────────────────────────────
program
  .command("init [ide]")
  .description("Initialize Gnosys in the current directory. Optionally specify IDE: cursor, claude, or codex to force IDE setup.")
  .option("-d, --directory <dir>", "Target directory (default: cwd)")
  .option("-n, --name <name>", "Project name (default: directory basename)")
  .action(async (ide: string | undefined, opts: { directory?: string; name?: string }) => {
    const targetDir = opts.directory
      ? path.resolve(opts.directory)
      : process.cwd();
    const storePath = path.join(targetDir, ".gnosys");

    // Check if already exists — re-sync identity instead of failing
    let isResync = false;
    try {
      await fs.stat(storePath);
      isResync = true;
    } catch {
      // Good — fresh init
    }

    if (!isResync) {
      // Create directory structure (DB is sole source of truth — no category folders or changelog)
      await fs.mkdir(storePath, { recursive: true });
      await fs.mkdir(path.join(storePath, ".config"), { recursive: true });

      const defaultRegistry = {
        domain: [
          "architecture", "api", "auth", "database", "devops",
          "frontend", "backend", "testing", "security", "performance",
        ],
        type: [
          "decision", "concept", "convention", "requirement",
          "observation", "fact", "question",
        ],
        concern: ["dx", "scalability", "maintainability", "reliability"],
        status_tag: ["draft", "stable", "deprecated", "experimental"],
      };
      await fs.writeFile(
        path.join(storePath, ".config", "tags.json"),
        JSON.stringify(defaultRegistry, null, 2),
        "utf-8"
      );

      // Write default gnosys.json config (LLM settings)
      await fs.writeFile(
        path.join(storePath, ".config", "gnosys-config.json"),
        generateConfigTemplate() + "\n",
        "utf-8"
      );

      // v5.0: Create attachments directory and empty manifest
      await fs.mkdir(path.join(storePath, "attachments"), { recursive: true });
      await fs.writeFile(
        path.join(storePath, "attachments", "attachments.json"),
        JSON.stringify({ attachments: [] }, null, 2) + "\n",
        "utf-8"
      );

      // Create .gitignore inside .gnosys to exclude large binary attachments
      const storeGitignore = "# Large binary attachments (tracked via manifest, not git)\nattachments/\n";
      await fs.writeFile(
        path.join(storePath, ".gitignore"),
        storeGitignore,
        "utf-8"
      );
    }

    // v3.0: Create/update project identity and register in central DB
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) centralDb = null;
    } catch {
      centralDb = null;
    }

    const identity = await createProjectIdentity(targetDir, {
      projectName: opts.name,
      centralDb: centralDb || undefined,
    });

    // Register in file-based project registry so resolver can find it
    const tempResolver = new GnosysResolver();
    await tempResolver.registerProject(targetDir);

    // Add .gnosys/ to project's .gitignore (runs on both init and re-sync)
    try {
      const projectGitignore = path.join(targetDir, ".gitignore");
      let gitignoreContent = "";
      try {
        gitignoreContent = await fs.readFile(projectGitignore, "utf-8");
      } catch {
        // No .gitignore yet
      }
      if (!gitignoreContent.includes(".gnosys")) {
        const entry = "\n# Gnosys memory store\n.gnosys/\n";
        await fs.writeFile(projectGitignore, gitignoreContent + entry, "utf-8");
      }
    } catch {
      // Non-critical
    }

    if (centralDb) centralDb.close();

    const action = isResync ? "re-synced" : "initialized";
    console.log(`Gnosys store ${action} at ${storePath}`);
    console.log(`\nProject Identity:`);
    console.log(`  ID:        ${identity.projectId}`);
    console.log(`  Name:      ${identity.projectName}`);
    console.log(`  Directory: ${identity.workingDirectory}`);
    console.log(`  Agent:     ${identity.agentRulesTarget || "none detected"}`);
    console.log(`  Central DB: ${centralDb ? "registered ✓" : "not available"}`);

    if (!isResync) {
      console.log(`\nCreated:`);
      console.log(`  gnosys.json   (project identity)`);
      console.log(`  .config/      (internal config)`);
      console.log(`  tags.json     (tag registry)`);
    }

    // Configure IDE hooks for automatic memory recall
    const { configureIdeHooks } = await import("./lib/projectIdentity.js");
    const hookResult = await configureIdeHooks(targetDir);
    if (hookResult.configured) {
      console.log(`\nIDE hooks (${hookResult.ide}):`);
      console.log(`  ${hookResult.details}`);
      console.log(`  File: ${hookResult.filePath}`);
    } else {
      console.log(`\nIDE hooks: ${hookResult.details}`);
    }

    // If a specific IDE was requested, force-create its config
    if (ide) {
      const validIdes = ["cursor", "claude", "codex"];
      const normalizedIde = ide.toLowerCase();
      if (!validIdes.includes(normalizedIde)) {
        console.log(`\nUnknown IDE: "${ide}". Valid options: ${validIdes.join(", ")}`);
      } else {
        const { configureCursor, configureClaudeCode, configureCodex } = await import("./lib/projectIdentity.js");

        let result;
        switch (normalizedIde) {
          case "cursor":
            result = await configureCursor(targetDir);
            break;
          case "claude":
            result = await configureClaudeCode(targetDir);
            break;
          case "codex":
            result = await configureCodex(targetDir);
            break;
        }

        if (result?.configured) {
          console.log(`\nIDE setup (${result.ide}):`);
          console.log(`  ${result.details}`);
          console.log(`  File: ${result.filePath}`);
        }

        // Also set up MCP config for the IDE
        const { setupIDE } = await import("./lib/setup.js");
        const mcp = await setupIDE(normalizedIde, targetDir);
        if (mcp.success) {
          console.log(`  MCP: ${mcp.message}`);
        }

        // Update agentRulesTarget in gnosys.json
        const identityPath = path.join(storePath, "gnosys.json");
        try {
          const identityContent = await fs.readFile(identityPath, "utf-8");
          const identity = JSON.parse(identityContent);
          const targetMap: Record<string, string> = {
            cursor: ".cursor/rules/gnosys.mdc",
            claude: "CLAUDE.md",
            codex: "CODEX.md",
          };
          identity.agentRulesTarget = targetMap[normalizedIde] || null;
          await fs.writeFile(identityPath, JSON.stringify(identity, null, 2) + "\n", "utf-8");
          console.log(`  Config: agentRulesTarget → ${identity.agentRulesTarget}`);
        } catch {
          // Non-critical
        }
      }
    }

    console.log(`\nStart adding memories with: gnosys add "your knowledge here"`);
  });

// ─── gnosys migrate ─────────────────────────────────────────────────────
program
  .command("migrate")
  .description("Interactively migrate a .gnosys/ store to a new directory. Moves files, updates project name/paths, syncs to central DB, and cleans up.")
  .option("--from <dir>", "Source directory containing .gnosys/ (skips prompt)")
  .option("--to <dir>", "Target directory to move .gnosys/ into (skips prompt)")
  .option("--name <name>", "New project name (skips prompt, default: basename of target)")
  .option("--yes", "Skip all confirmation prompts (non-interactive mode)")
  .action(async (opts: { from?: string; to?: string; name?: string; yes?: boolean }) => {
    const { createInterface } = await import("readline/promises");
    const rl = opts.yes ? null : createInterface({ input: process.stdin, output: process.stdout });

    const ask = async (question: string, defaultValue?: string): Promise<string> => {
      if (!rl) return defaultValue || "";
      const suffix = defaultValue ? ` (${defaultValue})` : "";
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      return answer || defaultValue || "";
    };

    try {
      console.log("\n── Gnosys Project Migration ──\n");

      // 1. Resolve source
      let sourceDir: string;
      if (opts.from) {
        sourceDir = path.resolve(opts.from);
      } else {
        // Try auto-detect first
        const found = await findProjectIdentity(process.cwd());
        const defaultSource = found ? found.projectRoot : "";
        const sourceInput = await ask("Source directory (contains .gnosys/)", defaultSource);
        if (!sourceInput) {
          console.error("No source directory provided.");
          rl?.close();
          process.exit(1);
        }
        sourceDir = path.resolve(sourceInput);
      }

      // Verify source has .gnosys/
      const storePath = path.join(sourceDir, ".gnosys");
      try {
        await fs.stat(storePath);
      } catch {
        console.error(`No .gnosys/ directory found at ${sourceDir}`);
        rl?.close();
        process.exit(1);
      }

      // Read identity (may not exist for pre-v3 stores)
      const identity = await readProjectIdentity(sourceDir);

      // Count memory files
      const { glob } = await import("glob");
      const memFiles = await glob("**/*.md", {
        cwd: storePath,
        ignore: ["**/CHANGELOG.md", "**/MANIFEST.md", "**/.git/**", "**/.obsidian/**"],
      });

      console.log("\nSource project:");
      if (identity) {
        console.log(`  Name:      ${identity.projectName}`);
        console.log(`  ID:        ${identity.projectId}`);
      } else {
        console.log(`  Name:      (unregistered — pre-v3 store)`);
      }
      console.log(`  Directory: ${sourceDir}`);
      console.log(`  Memories:  ${memFiles.length} markdown files`);

      // 2. Resolve target
      let targetDir: string;
      if (opts.to) {
        targetDir = path.resolve(opts.to);
      } else {
        const targetInput = await ask("\nTarget directory (where .gnosys/ should live)");
        if (!targetInput) {
          console.error("No target directory provided.");
          rl?.close();
          process.exit(1);
        }
        targetDir = path.resolve(targetInput);
      }

      // 3. Resolve name
      const defaultName = opts.name || path.basename(targetDir);
      const newName = opts.yes
        ? defaultName
        : await ask("Project name", defaultName);

      // 4. Ask about sync and cleanup
      let doSync = true;
      let doDelete = true;
      if (!opts.yes) {
        const syncAnswer = await ask("\nSync memories to central DB?", "Y");
        doSync = syncAnswer.toLowerCase() !== "n" && syncAnswer.toLowerCase() !== "no";

        const deleteAnswer = await ask("Delete old .gnosys/ after migration?", "Y");
        doDelete = deleteAnswer.toLowerCase() !== "n" && deleteAnswer.toLowerCase() !== "no";
      }

      // 5. Show summary and confirm
      console.log("\n── Migration Summary ──");
      console.log(`  From:       ${sourceDir}/.gnosys/`);
      console.log(`  To:         ${targetDir}/.gnosys/`);
      console.log(`  Name:       ${identity?.projectName || "(new)"} → ${newName}`);
      console.log(`  Memories:   ${memFiles.length} files`);
      console.log(`  Sync to DB: ${doSync ? "yes" : "no"}`);
      console.log(`  Delete old: ${doDelete ? "yes" : "no"}`);

      if (!opts.yes) {
        const confirm = await ask("\nProceed?", "Y");
        if (confirm.toLowerCase() === "n" || confirm.toLowerCase() === "no") {
          console.log("Aborted.");
          rl?.close();
          return;
        }
      }

      rl?.close();

      // 6. Open central DB
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) centralDb = null;
      } catch {
        centralDb = null;
      }

      // 7. Run migration
      console.log("\nMigrating...");
      const result = await migrateProject({
        sourcePath: sourceDir,
        targetPath: targetDir,
        newName,
        deleteSource: doDelete,
        centralDb: centralDb || undefined,
      });

      console.log(`  Copied ${result.memoryFileCount} memory files`);
      console.log(`  Project: ${result.newIdentity.projectName} (${result.newIdentity.projectId})`);
      console.log(`  Path:    ${result.newIdentity.workingDirectory}`);
      console.log(`  Central DB: ${centralDb ? "updated ✓" : "not available"}`);

      // 8. Sync memories to central DB
      if (doSync && centralDb) {
        console.log("\nSyncing memories to central DB...");
        const matter = (await import("gray-matter")).default;
        const { syncMemoryToDb } = await import("./lib/dbWrite.js");
        const newStorePath = path.join(targetDir, ".gnosys");

        const mdFiles = await glob("**/*.md", {
          cwd: newStorePath,
          ignore: ["**/CHANGELOG.md", "**/MANIFEST.md", "**/.git/**", "**/.obsidian/**"],
        });

        let synced = 0;
        for (const file of mdFiles) {
          try {
            const filePath = path.join(newStorePath, file);
            const raw = await fs.readFile(filePath, "utf-8");
            const parsed = matter(raw);
            if (parsed.data?.id) {
              syncMemoryToDb(
                centralDb,
                parsed.data as import("./lib/store.js").MemoryFrontmatter,
                parsed.content,
                filePath,
                result.newIdentity.projectId,
                "project"
              );
              synced++;
            }
          } catch {
            // Skip files that fail to parse
          }
        }

        console.log(`  Synced ${synced} memories to central DB`);
      }

      if (centralDb) centralDb.close();

      if (doDelete) {
        console.log(`\nOld .gnosys/ at ${sourceDir} removed.`);
      }

      console.log(`\nMigration complete! Run 'gnosys projects' to verify.`);
    } catch (err: unknown) {
      rl?.close();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nMigration failed: ${msg}`);
      process.exit(1);
    }
  });

// ─── gnosys stale ───────────────────────────────────────────────────────
program
  .command("stale")
  .description("Find memories not modified within a given number of days")
  .option("-d, --days <number>", "Days threshold", "90")
  .option("-n, --limit <number>", "Max results", "20")
  .action(async (opts: { days: string; limit: string }) => {
    const resolver = await getResolver();
    const threshold = parseInt(opts.days);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - threshold);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const allMemories = await resolver.getAllMemories();
    const stale = allMemories
      .filter((m) => {
        const lastTouched = (m.frontmatter as any).last_reviewed || m.frontmatter.modified;
        return lastTouched && lastTouched < cutoffStr;
      })
      .sort((a, b) => {
        const aDate = (a.frontmatter as any).last_reviewed || a.frontmatter.modified;
        const bDate = (b.frontmatter as any).last_reviewed || b.frontmatter.modified;
        return (aDate || "").localeCompare(bDate || "");
      })
      .slice(0, parseInt(opts.limit));

    if (stale.length === 0) {
      console.log(`No memories older than ${threshold} days.`);
      return;
    }

    console.log(`${stale.length} memories not touched in ${threshold}+ days:\n`);
    for (const m of stale) {
      const lr = (m.frontmatter as any).last_reviewed;
      console.log(`  ${m.frontmatter.title}`);
      console.log(`  ${m.sourceLabel}:${m.relativePath}`);
      console.log(`  Modified: ${m.frontmatter.modified}${lr ? `, Reviewed: ${lr}` : ""}`);
      console.log();
    }
  });

// ─── gnosys tags ─────────────────────────────────────────────────────────
program
  .command("tags")
  .description("List all tags in the registry")
  .action(async () => {
    const resolver = await getResolver();
    const writeTarget = resolver.getWriteTarget();
    if (!writeTarget) {
      console.error("No store found.");
      process.exit(1);
    }
    const tagRegistry = new GnosysTagRegistry(
      writeTarget.store.getStorePath()
    );
    await tagRegistry.load();
    const registry = tagRegistry.getRegistry();

    for (const [category, tags] of Object.entries(registry)) {
      console.log(`\n${category}:`);
      console.log(`  ${tags.sort().join(", ")}`);
    }
  });

// ─── gnosys update <path> ────────────────────────────────────────────────
program
  .command("update <memoryPath>")
  .description("Update an existing memory's frontmatter and/or content")
  .option("--title <title>", "New title")
  .option("--status <status>", "New status (active|archived|superseded)")
  .option("--confidence <n>", "New confidence (0-1)")
  .option("--relevance <keywords>", "Updated relevance keyword cloud")
  .option("--supersedes <id>", "ID of memory this supersedes")
  .option("--superseded-by <id>", "ID of memory that supersedes this one")
  .option("--content <content>", "New markdown content (replaces body)")
  .action(
    async (
      memPath: string,
      opts: {
        title?: string;
        status?: string;
        confidence?: string;
        relevance?: string;
        supersedes?: string;
        supersededBy?: string;
        content?: string;
      }
    ) => {
      const resolver = await getResolver();
      const memory = await resolver.readMemory(memPath);
      if (!memory) {
        console.error(`Memory not found: ${memPath}`);
        process.exit(1);
      }

      const sourceStore = resolver
        .getStores()
        .find((s) => s.label === memory.sourceLabel);
      if (!sourceStore?.writable) {
        console.error(`Cannot update: store [${memory.sourceLabel}] is read-only.`);
        process.exit(1);
      }

      const updates: Record<string, any> = {};
      if (opts.title !== undefined) updates.title = opts.title;
      if (opts.status !== undefined) updates.status = opts.status;
      if (opts.confidence !== undefined) updates.confidence = parseFloat(opts.confidence);
      if (opts.relevance !== undefined) updates.relevance = opts.relevance;
      if (opts.supersedes !== undefined) updates.supersedes = opts.supersedes;
      if (opts.supersededBy !== undefined) updates.superseded_by = opts.supersededBy;

      const fullContent = opts.content
        ? `# ${opts.title || memory.frontmatter.title}\n\n${opts.content}`
        : undefined;

      const memoryId = memory.frontmatter.id;
      if (!memoryId) {
        console.error(`Memory has no ID: ${memPath}`);
        process.exit(1);
      }

      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        const { syncUpdateToDb } = await import("./lib/dbWrite.js");
        syncUpdateToDb(centralDb, memoryId, updates as any, fullContent);

        // Supersession cross-linking
        if (opts.supersedes && memoryId) {
          const allMemories = await resolver.getAllMemories();
          const supersededMemory = allMemories.find(
            (m) => m.frontmatter.id === opts.supersedes
          );
          if (supersededMemory) {
            syncUpdateToDb(
              centralDb,
              supersededMemory.frontmatter.id,
              { superseded_by: memoryId, status: "superseded" } as any
            );
            console.log(`Cross-linked: ${supersededMemory.frontmatter.title} marked as superseded.`);
          }
        }
      } finally {
        centralDb?.close();
      }

      const changedFields = Object.keys(updates);
      if (opts.content) changedFields.push("content");

      console.log(`Memory updated: ${opts.title || memory.frontmatter.title}`);
      console.log(`ID: ${memoryId}`);
      console.log(`Changed: ${changedFields.join(", ")}`);
    }
  );

// ─── gnosys reinforce <memoryId> ────────────────────────────────────────
program
  .command("reinforce <memoryId>")
  .description("Signal whether a memory was useful, not relevant, or outdated")
  .requiredOption(
    "--signal <signal>",
    "Reinforcement signal (useful|not_relevant|outdated)"
  )
  .option("--context <context>", "Why this signal was given")
  .action(
    async (
      memoryId: string,
      opts: { signal: string; context?: string }
    ) => {
      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget();
      if (!writeTarget) {
        console.error("No writable store found.");
        process.exit(1);
      }

      // Log reinforcement
      const logDir = path.join(writeTarget.store.getStorePath(), ".config");
      await fs.mkdir(logDir, { recursive: true });
      const logPath = path.join(logDir, "reinforcement.log");
      const entry = JSON.stringify({
        memory_id: memoryId,
        signal: opts.signal,
        context: opts.context,
        timestamp: new Date().toISOString(),
      });
      await fs.appendFile(logPath, entry + "\n", "utf-8");

      // If 'useful', update the memory's modified date (reset decay)
      if (opts.signal === "useful") {
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          const { syncUpdateToDb } = await import("./lib/dbWrite.js");
          syncUpdateToDb(centralDb, memoryId, {
            modified: new Date().toISOString().split("T")[0],
          } as any);
        } finally {
          centralDb?.close();
        }
      }

      const messages: Record<string, string> = {
        useful: `Memory ${memoryId} reinforced. Decay clock reset.`,
        not_relevant: `Routing feedback logged for ${memoryId}. Memory unchanged.`,
        outdated: `Memory ${memoryId} flagged for review as outdated.`,
      };
      console.log(messages[opts.signal] || `Signal '${opts.signal}' logged for ${memoryId}.`);
    }
  );

// ─── gnosys add-structured ──────────────────────────────────────────────
program
  .command("add-structured")
  .description("Add a memory with structured input (no LLM needed)")
  .requiredOption("--title <title>", "Memory title")
  .requiredOption("--category <category>", "Category directory name")
  .requiredOption("--content <content>", "Memory content as markdown")
  .option("--tags <json>", "Tags as JSON object", "{}")
  .option("--relevance <keywords>", "Keyword cloud for discovery search", "")
  .option("-a, --author <author>", "Author", "human")
  .option("--authority <authority>", "Authority level", "declared")
  .option("--confidence <n>", "Confidence 0-1", "0.8")
  .option("-s, --store <store>", "Target store", undefined)
  .option("--user", "Store as user-scoped memory (scope: user)")
  .option("--global", "Store as global-scoped memory (scope: global)")
  .action(
    async (opts: {
      title: string;
      category: string;
      content: string;
      tags: string;
      relevance: string;
      author: string;
      authority: string;
      confidence: string;
      store?: string;
      user?: boolean;
      global?: boolean;
    }) => {
      // ─── Phase 9b: --user / --global route through central DB ─────
      if (opts.user || opts.global) {
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          if (!centralDb.isAvailable()) {
            console.error("Central DB not available.");
            process.exit(1);
          }
          const scope = opts.global ? "global" : "user";
          const now = new Date().toISOString();
          const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const projectId = opts.global ? null : await resolveProjectId();

          centralDb.insertMemory({
            id,
            title: opts.title,
            category: opts.category,
            content: `# ${opts.title}\n\n${opts.content}`,
            summary: null,
            tags: opts.tags,
            relevance: opts.relevance || opts.content.slice(0, 200),
            author: opts.author,
            authority: opts.authority,
            confidence: parseFloat(opts.confidence),
            reinforcement_count: 0,
            content_hash: "",
            status: "active",
            tier: "active",
            supersedes: null,
            superseded_by: null,
            last_reinforced: null,
            created: now,
            modified: now,
            embedding: null,
            source_path: null,
            project_id: projectId,
            scope,
          });

          console.log(`Memory added (scope: ${scope}): ${opts.title}`);
          console.log(`ID: ${id}`);
          return;
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        } finally {
          centralDb?.close();
        }
      }

      // ─── DB-only write ────────────────────────────────────────────
      let tags: Record<string, string[]>;
      try {
        tags = JSON.parse(opts.tags);
      } catch {
        console.error("Invalid --tags JSON. Example: '{\"domain\":[\"auth\"],\"type\":[\"decision\"]}'");
        process.exit(1);
      }

      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        const projectId = await resolveProjectId();
        const id = centralDb.getNextId(opts.category, projectId || undefined);
        const now = new Date().toISOString();
        const content = `# ${opts.title}\n\n${opts.content}`;

        const tagsJson = Array.isArray(tags)
          ? JSON.stringify(tags)
          : JSON.stringify(Object.values(tags).flat());

        centralDb.insertMemory({
          id,
          title: opts.title,
          category: opts.category,
          content,
          summary: null,
          tags: tagsJson,
          relevance: opts.relevance || opts.content.slice(0, 200),
          author: opts.author,
          authority: opts.authority,
          confidence: parseFloat(opts.confidence),
          reinforcement_count: 0,
          content_hash: "",
          status: "active",
          tier: "active",
          supersedes: null,
          superseded_by: null,
          last_reinforced: null,
          created: now,
          modified: now,
          embedding: null,
          source_path: null,
          project_id: projectId,
          scope: "project",
        });

        console.log(`Memory added: ${opts.title}`);
        console.log(`ID: ${id}`);
      } finally {
        centralDb?.close();
      }
    }
  );

// ─── gnosys ingest <file> ─────────────────────────────────────────────────
program
  .command("ingest <fileOrGlob>")
  .description("Ingest a file (PDF, DOCX, TXT, MD) into Gnosys memory. Extracts text, splits into chunks, and creates atomic memories.")
  .option("--mode <mode>", "Ingestion mode: llm or structured", "llm")
  .option("-s, --store <store>", "Target store: project, personal, global")
  .option("-a, --author <author>", "Author", "human")
  .option("--authority <authority>", "Authority level", "imported")
  .option("--dry-run", "Preview what would be created without writing")
  .option("--list-attachments", "List all stored attachments")
  .option("-d, --directory <dir>", "Project directory")
  .action(async (fileOrGlob: string, opts: {
    mode: string;
    store?: string;
    author: string;
    authority: string;
    dryRun?: boolean;
    listAttachments?: boolean;
    directory?: string;
  }) => {
    // List attachments mode
    if (opts.listAttachments) {
      const { listAttachments } = await import("./lib/attachments.js");
      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget((opts.store as any) || undefined);
      if (!writeTarget) {
        console.error("No writable store found.");
        process.exit(1);
      }
      const attachments = await listAttachments(writeTarget.store.getStorePath());
      if (attachments.length === 0) {
        console.log("No attachments found.");
        return;
      }
      console.log(`Found ${attachments.length} attachment(s):\n`);
      for (const a of attachments) {
        const sizeMb = (a.sizeBytes / (1024 * 1024)).toFixed(2);
        console.log(`  ${a.originalName} (${sizeMb}MB, ${a.extension})`);
        console.log(`    UUID: ${a.uuid}`);
        console.log(`    Hash: ${a.contentHash.slice(0, 16)}...`);
        console.log(`    Memories: ${a.memoryIds.length > 0 ? a.memoryIds.join(", ") : "none"}`);
        console.log(`    Created: ${a.createdAt}\n`);
      }
      return;
    }

    // Resolve the file path
    const resolvedPath = path.resolve(opts.directory || process.cwd(), fileOrGlob);

    // Check the file exists
    try {
      await fs.access(resolvedPath);
    } catch {
      console.error(`File not found: ${resolvedPath}`);
      process.exit(1);
    }

    // Resolve the store
    const resolver = await getResolver();
    const writeTarget = resolver.getWriteTarget((opts.store as any) || undefined);
    if (!writeTarget) {
      console.error("No writable store found. Create a .gnosys/ directory or set GNOSYS_PERSONAL.");
      process.exit(1);
    }

    const storePath = writeTarget.store.getStorePath();

    // Run ingestion
    const { ingestFile } = await import("./lib/multimodalIngest.js");
    console.log(`Ingesting: ${path.basename(resolvedPath)}`);
    if (opts.dryRun) {
      console.log("(dry run — no files will be written)\n");
    }

    try {
      const result = await ingestFile({
        filePath: resolvedPath,
        storePath,
        mode: opts.mode as "llm" | "structured",
        store: (opts.store as any) || undefined,
        author: opts.author as "human" | "ai" | "human+ai",
        authority: opts.authority as "declared" | "observed" | "imported" | "inferred",
        dryRun: opts.dryRun,
        projectRoot: opts.directory,
        onProgress: (p) => {
          process.stdout.write(`\r  Processing chunk ${p.current}/${p.total}...`);
        },
      });

      // Clear the progress line
      if (result.memories.length > 0) {
        process.stdout.write("\r" + " ".repeat(60) + "\r");
      }

      // Print results
      console.log(`\nFile type: ${result.fileType}`);
      console.log(`Attachment: ${result.attachment.originalName} (${result.attachment.uuid.slice(0, 8)}...)`);
      console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
      console.log(`Memories created: ${result.memories.length}`);

      if (result.memories.length > 0) {
        console.log("\nMemories:");
        for (const m of result.memories) {
          const extra = m.page ? ` [page ${m.page}]` : "";
          console.log(`  ${m.id}: ${m.title}${extra}`);
          console.log(`    Path: ${m.path}`);
        }
      }

      if (result.errors.length > 0) {
        console.log(`\nErrors (${result.errors.length}):`);
        for (const e of result.errors) {
          console.log(`  Chunk ${e.chunk}: ${e.error}`);
        }
      }
    } catch (err) {
      console.error(`\nIngestion failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// ─── gnosys tags-add ────────────────────────────────────────────────────
program
  .command("tags-add")
  .description("Add a new tag to the registry")
  .requiredOption("--category <category>", "Tag category (domain, type, concern, status_tag)")
  .requiredOption("--tag <tag>", "The new tag to add")
  .action(async (opts: { category: string; tag: string }) => {
    const resolver = await getResolver();
    const writeTarget = resolver.getWriteTarget();
    if (!writeTarget) {
      console.error("No store found.");
      process.exit(1);
    }
    const tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
    await tagRegistry.load();
    const added = await tagRegistry.addTag(opts.category, opts.tag);
    if (added) {
      console.log(`Tag '${opts.tag}' added to category '${opts.category}'.`);
    } else {
      console.log(`Tag '${opts.tag}' already exists in '${opts.category}'.`);
    }
  });

// ─── gnosys commit-context <context> ─────────────────────────────────────
program
  .command("commit-context <context>")
  .description("Pre-compaction sweep: extract atomic memories from a context string, check novelty, commit novel ones")
  .option("--dry-run", "Show what would be committed without writing")
  .option("-s, --store <store>", "Target store (project|personal|global)", undefined)
  .action(async (context: string, opts: { dryRun?: boolean; store?: string }) => {
    const resolver = await getResolver();
    const writeTarget = resolver.getWriteTarget(
      (opts.store as any) || undefined
    );
    if (!writeTarget) {
      console.error("No writable store found.");
      process.exit(1);
    }

    const tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
    await tagRegistry.load();
    const ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);

    if (!ingestion.isLLMAvailable) {
      console.error("Error: No LLM provider available. Add an API key to ~/.config/gnosys/.env or use a local model: gnosys config set provider ollama");
      process.exit(1);
    }

    // Build search index
    const stores = resolver.getStores();
    const search = new GnosysSearch(stores[0].path);
    search.clearIndex();
    for (const s of stores) {
      await search.addStoreMemories(s.store, s.label);
    }

    // Step 1: Extract candidates via LLM abstraction
    console.log("Extracting knowledge candidates from context...");

    // Load config for the write target store
    const ccConfig = await loadConfig(writeTarget.store.getStorePath());
    let extractProvider: LLMProvider;
    try {
      extractProvider = getLLMProvider(ccConfig, "structuring");
    } catch (err) {
      console.error(`LLM not available: ${err instanceof Error ? err.message : String(err)}`);
      search.close();
      process.exit(1);
    }

    const extractText = await extractProvider.generate(
      `Extract atomic knowledge items from this context:\n\n${context}`,
      {
        system: `You extract atomic knowledge items from conversations. Each item should be ONE decision, fact, insight, or observation — not compound.

Output a JSON array of objects, each with:
- summary: One-sentence description of the knowledge
- type: "decision" | "insight" | "fact" | "observation" | "requirement"
- search_terms: 3-5 keywords someone would search for to find if this already exists

Be selective. Only extract things worth remembering long-term. Skip small talk, debugging steps, and transient details. Focus on decisions made, architecture choices, requirements established, and insights gained.

Output ONLY the JSON array, no markdown fences.`,
        maxTokens: 4000,
      }
    );

    let candidates: Array<{ summary: string; type: string; search_terms: string[] }>;
    try {
      const jsonMatch =
        extractText.match(/```json\s*([\s\S]*?)```/) ||
        extractText.match(/```\s*([\s\S]*?)```/) || [null, extractText];
      candidates = JSON.parse(jsonMatch[1] || extractText);
    } catch {
      console.error("Failed to extract candidates — LLM output was not valid JSON.");
      search.close();
      process.exit(1);
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      console.log("No extractable knowledge found in the provided context.");
      search.close();
      return;
    }

    console.log(`Found ${candidates.length} candidates. Checking novelty...\n`);

    // Step 2: Check novelty and commit
    let added = 0;
    let skipped = 0;

    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      const projectId = await resolveProjectId();

      for (const candidate of candidates) {
        const searchTerms = candidate.search_terms.join(" ");
        const existing = search.discover(searchTerms, 3);

        if (existing.length > 0) {
          console.log(`  ⏭ SKIP: "${candidate.summary}"`);
          console.log(`    Overlaps with: ${existing[0].title}`);
          skipped++;
        } else if (opts.dryRun) {
          console.log(`  ➕ WOULD ADD: "${candidate.summary}" [${candidate.type}]`);
          added++;
        } else {
          try {
            const result = await ingestion.ingest(candidate.summary);
            const id = centralDb.getNextId(result.category, projectId || undefined);
            const now = new Date().toISOString();
            const content = `# ${result.title}\n\n${result.content}`;

            const resultTags = result.tags;
            const tagsJson = Array.isArray(resultTags)
              ? JSON.stringify(resultTags)
              : JSON.stringify(Object.values(resultTags).flat());

            centralDb.insertMemory({
              id,
              title: result.title,
              category: result.category,
              content,
              summary: null,
              tags: tagsJson,
              relevance: result.relevance,
              author: "ai",
              authority: "observed",
              confidence: result.confidence,
              reinforcement_count: 0,
              content_hash: "",
              status: "active",
              tier: "active",
              supersedes: null,
              superseded_by: null,
              last_reinforced: null,
              created: now,
              modified: now,
              embedding: null,
              source_path: null,
              project_id: projectId,
              scope: "project",
            });

            console.log(`  ➕ ADDED: "${result.title}"`);
            console.log(`    ID: ${id}`);
            added++;
          } catch (err) {
            console.error(`  ❌ FAILED: "${candidate.summary}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        console.log();
      }
    } finally {
      centralDb?.close();
    }

    search.close();

    const mode = opts.dryRun ? "DRY RUN" : "COMMITTED";
    console.log(`\n${mode}: ${candidates.length} candidates, ${added} ${opts.dryRun ? "would be added" : "added"}, ${skipped} duplicates skipped.`);
  });

// ─── gnosys lens ────────────────────────────────────────────────────────
program
  .command("lens")
  .description("Filtered view of memories. Combine criteria to focus on what matters.")
  .option("-c, --category <category>", "Filter by category")
  .option("-t, --tag <tags...>", "Filter by tag(s)")
  .option("--match <mode>", "Tag match mode: any (default) or all", "any")
  .option("--status <statuses...>", "Filter by status (active, archived, superseded)")
  .option("--author <authors...>", "Filter by author (human, ai, human+ai)")
  .option("--authority <authorities...>", "Filter by authority (declared, observed, imported, inferred)")
  .option("--min-confidence <n>", "Minimum confidence (0-1)")
  .option("--max-confidence <n>", "Maximum confidence (0-1)")
  .option("--created-after <date>", "Created after ISO date")
  .option("--created-before <date>", "Created before ISO date")
  .option("--modified-after <date>", "Modified after ISO date")
  .option("--modified-before <date>", "Modified before ISO date")
  .option("--or", "Combine filters with OR instead of AND (default: AND)")
  .action(
    async (opts: {
      category?: string;
      tag?: string[];
      match: string;
      status?: string[];
      author?: string[];
      authority?: string[];
      minConfidence?: string;
      maxConfidence?: string;
      createdAfter?: string;
      createdBefore?: string;
      modifiedAfter?: string;
      modifiedBefore?: string;
      or?: boolean;
    }) => {
      const resolver = await getResolver();
      const allMemories = await resolver.getAllMemories();

      const lens: LensFilter = {};
      if (opts.category) lens.category = opts.category;
      if (opts.tag) { lens.tags = opts.tag; lens.tagMatchMode = opts.match as "any" | "all"; }
      if (opts.status) lens.status = opts.status as any;
      if (opts.author) lens.author = opts.author as any;
      if (opts.authority) lens.authority = opts.authority as any;
      if (opts.minConfidence) lens.minConfidence = parseFloat(opts.minConfidence);
      if (opts.maxConfidence) lens.maxConfidence = parseFloat(opts.maxConfidence);
      if (opts.createdAfter) lens.createdAfter = opts.createdAfter;
      if (opts.createdBefore) lens.createdBefore = opts.createdBefore;
      if (opts.modifiedAfter) lens.modifiedAfter = opts.modifiedAfter;
      if (opts.modifiedBefore) lens.modifiedBefore = opts.modifiedBefore;

      const result = applyLens(allMemories, lens);

      if (result.length === 0) {
        console.log("No memories match the lens filter.");
        return;
      }

      console.log(`${result.length} memories match:\n`);
      for (const m of result) {
        const src = (m as any).sourceLabel || "";
        console.log(`  [${m.frontmatter.status}] ${m.frontmatter.title} (${m.frontmatter.confidence})`);
        console.log(`    ${src ? src + ":" : ""}${m.relativePath}`);
        console.log();
      }
    }
  );

// ─── gnosys history <path> ───────────────────────────────────────────────
program
  .command("history <memoryPath>")
  .description("Show version history for a memory (git-backed)")
  .option("-n, --limit <number>", "Max entries", "20")
  .option("--diff <hash>", "Show diff from this commit to current")
  .action(async (memPath: string, opts: { limit: string; diff?: string }) => {
    const resolver = await getResolver();
    const memory = await resolver.readMemory(memPath);
    if (!memory) {
      console.error(`Memory not found: ${memPath}`);
      process.exit(1);
    }

    const sourceStore = resolver.getStores().find((s) => s.label === memory.sourceLabel);
    if (!sourceStore) {
      console.error("Could not locate source store.");
      process.exit(1);
    }

    if (!hasGitHistory(sourceStore.path)) {
      console.error("No git history available for this store.");
      process.exit(1);
    }

    if (opts.diff) {
      const diff = getFileDiff(sourceStore.path, memory.relativePath, opts.diff, "HEAD");
      if (!diff) {
        console.error("Could not generate diff.");
        process.exit(1);
      }
      console.log(diff);
      return;
    }

    const history = getFileHistory(sourceStore.path, memory.relativePath, parseInt(opts.limit));
    if (history.length === 0) {
      console.log("No history found for this memory.");
      return;
    }

    console.log(`History for ${memory.frontmatter.title}:\n`);
    for (const entry of history) {
      console.log(`  ${entry.commitHash.substring(0, 7)}  ${entry.date}  ${entry.message}`);
    }
  });

// ─── gnosys rollback <path> <hash> ──────────────────────────────────────
program
  .command("rollback <memoryPath> <commitHash>")
  .description("Rollback a memory to its state at a specific commit")
  .action(async (memPath: string, commitHash: string) => {
    const resolver = await getResolver();
    const memory = await resolver.readMemory(memPath);
    if (!memory) {
      console.error(`Memory not found: ${memPath}`);
      process.exit(1);
    }

    const sourceStore = resolver.getStores().find((s) => s.label === memory.sourceLabel);
    if (!sourceStore?.writable) {
      console.error("Cannot rollback: store is read-only.");
      process.exit(1);
    }

    const success = rollbackToCommit(sourceStore.path, memory.relativePath, commitHash);
    if (success) {
      console.log(`Rolled back ${memory.frontmatter.title} to commit ${commitHash.substring(0, 7)}.`);
    } else {
      console.error(`Rollback failed. Check that the commit hash is valid.`);
      process.exit(1);
    }
  });

// ─── gnosys timeline ────────────────────────────────────────────────────
program
  .command("timeline")
  .description("Show when memories were created and modified over time")
  .option("-p, --period <period>", "Group by: day, week, month (default), year", "month")
  .action(async (opts: { period: string }) => {
    const resolver = await getResolver();
    const allMemories = await resolver.getAllMemories();

    if (allMemories.length === 0) {
      console.log("No memories found.");
      return;
    }

    const entries = groupByPeriod(allMemories, opts.period as TimePeriod);

    console.log(`Knowledge Timeline (by ${opts.period}):\n`);
    for (const entry of entries) {
      const parts = [];
      if (entry.created > 0) parts.push(`${entry.created} created`);
      if (entry.modified > 0) parts.push(`${entry.modified} modified`);
      console.log(`  ${entry.period}: ${parts.join(", ")}`);
      if (entry.titles.length > 0 && entry.titles.length <= 5) {
        for (const t of entry.titles) {
          console.log(`    + ${t}`);
        }
      }
    }
  });

// ─── gnosys stats ───────────────────────────────────────────────────────
program
  .command("stats")
  .description("Show summary statistics for the memory store")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const resolver = await getResolver();
    const allMemories = await resolver.getAllMemories();

    if (allMemories.length === 0) {
      outputResult(!!opts.json, { totalCount: 0 }, () => {
        console.log("No memories found.");
      });
      return;
    }

    const stats = computeStats(allMemories);

    outputResult(!!opts.json, stats, () => {
      console.log(`Gnosys Store Statistics:\n`);
      console.log(`  Total memories: ${stats.totalCount}`);
      console.log(`  Average confidence: ${stats.averageConfidence}`);
      console.log(`  Date range: ${stats.oldestCreated} → ${stats.newestCreated}`);
      console.log(`  Last modified: ${stats.lastModified}`);

      console.log(`\n  By category:`);
      for (const [cat, count] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${cat}: ${count}`);
      }

      console.log(`\n  By status:`);
      for (const [st, count] of Object.entries(stats.byStatus)) {
        console.log(`    ${st}: ${count}`);
      }

      console.log(`\n  By author:`);
      for (const [author, count] of Object.entries(stats.byAuthor)) {
        console.log(`    ${author}: ${count}`);
      }
    });
  });

// ─── gnosys links <path> ─────────────────────────────────────────────────
program
  .command("links <memoryPath>")
  .description("Show wikilinks for a memory — both outgoing [[links]] and backlinks from other memories")
  .action(async (memPath: string) => {
    const resolver = await getResolver();
    const memory = await resolver.readMemory(memPath);
    if (!memory) {
      console.error(`Memory not found: ${memPath}`);
      process.exit(1);
    }

    const allMemories = await resolver.getAllMemories();
    const outgoing = getOutgoingLinks(allMemories, memory.relativePath);
    const backlinks = getBacklinks(allMemories, memory.relativePath);

    console.log(`Links for ${memory.frontmatter.title}:\n`);

    if (outgoing.length > 0) {
      console.log(`  Outgoing (${outgoing.length}):`);
      for (const link of outgoing) {
        const display = link.displayText ? ` (${link.displayText})` : "";
        console.log(`    → [[${link.target}]]${display}`);
      }
    } else {
      console.log("  No outgoing links.");
    }

    console.log();

    if (backlinks.length > 0) {
      console.log(`  Backlinks (${backlinks.length}):`);
      for (const link of backlinks) {
        console.log(`    ← ${link.sourceTitle} (${link.sourcePath})`);
      }
    } else {
      console.log("  No backlinks.");
    }
  });

// ─── gnosys graph ───────────────────────────────────────────────────────
program
  .command("graph")
  .description("Show the full cross-reference graph across all memories")
  .action(async () => {
    const resolver = await getResolver();
    const allMemories = await resolver.getAllMemories();

    if (allMemories.length === 0) {
      console.log("No memories found.");
      return;
    }

    const graph = buildLinkGraph(allMemories);
    console.log(formatGraphSummary(graph));
  });

// ─── gnosys bootstrap <sourceDir> ────────────────────────────────────────
program
  .command("bootstrap <sourceDir>")
  .description("Batch-import existing documents into the memory store")
  .option("-p, --pattern <patterns...>", "File patterns to match (default: **/*.md)")
  .option("--skip-existing", "Skip files whose titles already exist in the store")
  .option("-c, --category <category>", "Default category (default: imported)", "imported")
  .option("-a, --author <author>", "Default author", "human")
  .option("--authority <authority>", "Default authority", "imported")
  .option("--confidence <n>", "Default confidence (0-1)", "0.7")
  .option("--preserve-frontmatter", "Preserve existing YAML frontmatter if present")
  .option("--dry-run", "Show what would be imported without writing")
  .option("-s, --store <store>", "Target store (project|personal|global)", undefined)
  .action(
    async (
      sourceDir: string,
      opts: {
        pattern?: string[];
        skipExisting?: boolean;
        category: string;
        author: string;
        authority: string;
        confidence: string;
        preserveFrontmatter?: boolean;
        dryRun?: boolean;
        store?: string;
      }
    ) => {
      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget(
        (opts.store as any) || undefined
      );
      if (!writeTarget) {
        console.error("No writable store found.");
        process.exit(1);
      }

      // Show what we'll scan
      const files = await discoverFiles(sourceDir, opts.pattern);
      console.log(`Found ${files.length} files in ${sourceDir}\n`);

      if (files.length === 0) {
        console.log("Nothing to import.");
        return;
      }

      const result = await bootstrap(writeTarget.store, {
        sourceDir,
        patterns: opts.pattern,
        skipExisting: opts.skipExisting,
        defaultCategory: opts.category,
        defaultAuthor: opts.author as any,
        defaultAuthority: opts.authority as any,
        defaultConfidence: parseFloat(opts.confidence),
        preserveFrontmatter: opts.preserveFrontmatter,
        dryRun: opts.dryRun,
      });

      const mode = opts.dryRun ? "DRY RUN" : "COMPLETE";
      console.log(`\nBootstrap ${mode}:`);
      console.log(`  Scanned: ${result.totalScanned}`);
      console.log(`  ${opts.dryRun ? "Would import" : "Imported"}: ${result.imported.length}`);
      console.log(`  Skipped: ${result.skipped.length}`);
      console.log(`  Failed: ${result.failed.length}`);

      if (result.imported.length > 0) {
        console.log(`\n${opts.dryRun ? "Would import" : "Imported"}:`);
        for (const f of result.imported) {
          console.log(`  + ${f}`);
        }
      }

      if (result.skipped.length > 0) {
        console.log(`\nSkipped (already exist):`);
        for (const f of result.skipped) {
          console.log(`  ⏭ ${f}`);
        }
      }

      if (result.failed.length > 0) {
        console.log(`\nFailed:`);
        for (const f of result.failed) {
          console.log(`  ❌ ${f.path}: ${f.error}`);
        }
      }
    }
  );

// ─── gnosys import <file> ────────────────────────────────────────────────
program
  .command("import <fileOrUrl>")
  .description(
    "Bulk import structured data (CSV, JSON, JSONL) into Gnosys memories"
  )
  .requiredOption(
    "--format <format>",
    "Data format: csv, json, jsonl"
  )
  .requiredOption(
    "--mapping <json>",
    'Field mapping as JSON: \'{"source_field":"gnosys_field"}\'. Valid targets: title, category, content, tags, relevance'
  )
  .option("--mode <mode>", "Processing mode: llm or structured", "structured")
  .option("--limit <n>", "Max records to import", parseInt)
  .option("--offset <n>", "Skip first N records", parseInt)
  .option("--skip-existing", "Skip records whose titles already exist")
  .option("--batch-commit", "Single git commit for all imports (default)", true)
  .option("--no-batch-commit", "Commit each record individually")
  .option("--concurrency <n>", "Parallel LLM calls (default: 5)", parseInt)
  .option("--dry-run", "Preview without writing")
  .option(
    "--store <store>",
    "Target store: project, personal, global",
    "project"
  )
  .action(
    async (
      fileOrUrl: string,
      opts: {
        format: string;
        mapping: string;
        mode: string;
        limit?: number;
        offset?: number;
        skipExisting?: boolean;
        batchCommit: boolean;
        concurrency?: number;
        dryRun?: boolean;
        store: string;
      }
    ) => {
      // Parse mapping JSON
      let mapping: Record<string, string>;
      try {
        mapping = JSON.parse(opts.mapping);
      } catch {
        console.error(
          "Error: --mapping must be valid JSON. Example: '{\"name\":\"title\",\"group\":\"category\"}'"
        );
        process.exit(1);
      }

      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget(
        opts.store as "project" | "personal" | "global"
      );
      if (!writeTarget) {
        console.error("No writable store found.");
        process.exit(1);
      }

      const tagRegistry = new GnosysTagRegistry(
        writeTarget.store.getStorePath()
      );
      await tagRegistry.load();
      const ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);

      const format = opts.format as "csv" | "json" | "jsonl";
      const mode = opts.mode as "llm" | "structured";
      const concurrency = opts.concurrency || 5;

      // Show estimate for LLM mode
      if (mode === "llm") {
        console.error(
          `Mode: LLM (concurrency: ${concurrency})`
        );
      } else {
        console.error("Mode: structured (no LLM calls)");
      }

      if (opts.dryRun) {
        console.error("DRY RUN — no files will be written\n");
      }

      // Progress tracking
      let lastLine = "";
      const onProgress = (p: {
        processed: number;
        total: number;
        current: string;
        stage: string;
      }) => {
        const pct = p.total > 0 ? Math.round((p.processed / p.total) * 100) : 0;
        const bar =
          "█".repeat(Math.floor(pct / 5)) +
          "░".repeat(20 - Math.floor(pct / 5));
        const line = `[${bar}] ${p.processed}/${p.total} | ${p.current.substring(0, 40)}`;
        if (line !== lastLine) {
          process.stderr.write(`\r${line}`);
          lastLine = line;
        }
      };

      try {
        const result = await performImport(writeTarget.store, ingestion, {
          format,
          data: fileOrUrl,
          mapping,
          mode,
          limit: opts.limit,
          offset: opts.offset,
          dryRun: opts.dryRun,
          skipExisting: opts.skipExisting,
          batchCommit: opts.batchCommit,
          concurrency,
          onProgress,
        });

        // Clear progress line
        process.stderr.write("\r" + " ".repeat(80) + "\r");

        // Reindex search after import
        if (!opts.dryRun && result.imported.length > 0) {
          const search = new (await import("./lib/search.js")).GnosysSearch(writeTarget.store.getStorePath());
          for (const s of resolver.getStores()) {
            await search.addStoreMemories(s.store, s.label);
          }
        }

        console.log(
          (opts.dryRun ? "DRY RUN — " : "✓ ") +
            formatImportSummary(result)
        );
      } catch (err) {
        console.error(
          `\nImport failed: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    }
  );

// ─── gnosys reindex ──────────────────────────────────────────────────────
program
  .command("reindex")
  .description(
    "Rebuild all semantic embeddings from every memory file. Downloads the model (~80 MB) on first run."
  )
  .action(async () => {
    const resolver = await getResolver();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No stores found. Run gnosys init first.");
      process.exit(1);
    }

    const storePath = stores[0].path;
    const search = new GnosysSearch(storePath);
    search.clearIndex();
    for (const s of stores) {
      await search.addStoreMemories(s.store, s.label);
    }

    const embeddings = new GnosysEmbeddings(storePath);
    const hybridSearch = new GnosysHybridSearch(search, embeddings, resolver, storePath);

    console.log("Building semantic embeddings (downloading model on first run)...");
    const count = await hybridSearch.reindex((current, total, filePath) => {
      process.stdout.write(`\r  Indexing: ${current}/${total} — ${filePath.substring(0, 60)}`);
    });
    console.log(`\n\nReindex complete: ${count} memories embedded.`);
    console.log("Hybrid and semantic search are now available.");
    search.close();
    embeddings.close();
  });

// ─── gnosys hybrid-search <query> ───────────────────────────────────────
program
  .command("hybrid-search <query>")
  .description("Search using hybrid keyword + semantic fusion (RRF). Use --federated for cross-scope.")
  .option("-l, --limit <n>", "Max results", "15")
  .option("-m, --mode <mode>", "Search mode: keyword | semantic | hybrid", "hybrid")
  .option("--json", "Output as JSON")
  .option("--federated", "Use federated search with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated)")
  .option("-d, --directory <dir>", "Project directory for context")
  .action(async (query: string, opts: { limit: string; mode: string; json?: boolean; federated?: boolean; scope?: string; directory?: string }) => {
    // Federated path — uses central DB
    if (opts.federated || opts.scope) {
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

        const { federatedSearch, detectCurrentProject } = await import("./lib/federated.js");
        const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
        const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
        const results = federatedSearch(centralDb, query, {
          limit: parseInt(opts.limit, 10),
          projectId,
          scopeFilter,
        });

        outputResult(!!opts.json, { query, projectId, mode: "federated", count: results.length, results }, () => {
          if (results.length === 0) { console.log(`No results for "${query}".`); return; }
          console.log(`Found ${results.length} results for "${query}" (mode: federated):\n`);
          for (const [i, r] of results.entries()) {
            const proj = r.projectName ? ` [${r.projectName}]` : "";
            console.log(`${i + 1}. ${r.title} (${r.category})${proj}`);
            console.log(`   scope: ${r.scope} | score: ${r.score.toFixed(4)} | boosts: ${r.boosts.join(", ")}`);
            if (r.snippet) console.log(`   ${r.snippet.substring(0, 120)}`);
          }
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        centralDb?.close();
      }
      return;
    }

    // Legacy file-based hybrid search
    const resolver = await getResolver();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No stores found.");
      process.exit(1);
    }

    const storePath = stores[0].path;
    const search = new GnosysSearch(storePath);
    search.clearIndex();
    for (const s of stores) {
      await search.addStoreMemories(s.store, s.label);
    }

    const embeddings = new GnosysEmbeddings(storePath);
    const hybridSearch = new GnosysHybridSearch(search, embeddings, resolver, storePath);

    const mode = opts.mode as "keyword" | "semantic" | "hybrid";
    const results = await hybridSearch.hybridSearch(query, parseInt(opts.limit), mode);

    if (results.length === 0) {
      outputResult(!!opts.json, { query, mode, results: [] }, () => {
        console.log(`No results for "${query}". Try gnosys reindex to build embeddings.`);
      });
    } else {
      outputResult(!!opts.json, { query, mode, count: results.length, results }, () => {
        console.log(`Found ${results.length} results for "${query}" (mode: ${mode}):\n`);
        for (const r of results) {
          console.log(`  ${r.title}`);
          console.log(`    Path: ${r.relativePath}`);
          console.log(`    Score: ${r.score.toFixed(4)} (via: ${r.sources.join("+")})`);
          console.log(`    ${r.snippet.substring(0, 120)}...\n`);
        }
      });

      // Reinforce used memories (best-effort)
      const writeTarget = resolver.getWriteTarget();
      if (writeTarget) {
        const { GnosysMaintenanceEngine } = await import("./lib/maintenance.js");
        await GnosysMaintenanceEngine.reinforceBatch(
          writeTarget.store,
          results.map((r) => r.relativePath)
        ).catch(() => {});
      }
    }
    search.close();
    embeddings.close();
  });

// ─── gnosys semantic-search <query> ─────────────────────────────────────
program
  .command("semantic-search <query>")
  .description("Search using semantic similarity only (requires embeddings)")
  .option("-l, --limit <n>", "Max results", "15")
  .action(async (query: string, opts: { limit: string }) => {
    const resolver = await getResolver();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No stores found.");
      process.exit(1);
    }

    const storePath = stores[0].path;
    const search = new GnosysSearch(storePath);
    search.clearIndex();
    for (const s of stores) {
      await search.addStoreMemories(s.store, s.label);
    }

    const embeddings = new GnosysEmbeddings(storePath);
    const hybridSearch = new GnosysHybridSearch(search, embeddings, resolver, storePath);

    const results = await hybridSearch.hybridSearch(query, parseInt(opts.limit), "semantic");

    if (results.length === 0) {
      console.log(`No semantic results for "${query}". Run gnosys reindex first.`);
    } else {
      console.log(`Found ${results.length} semantic results for "${query}":\n`);
      for (const r of results) {
        console.log(`  ${r.title}`);
        console.log(`    Path: ${r.relativePath}`);
        console.log(`    Similarity: ${r.score.toFixed(4)}`);
        console.log(`    ${r.snippet.substring(0, 120)}...\n`);
      }
    }
    search.close();
    embeddings.close();
  });

// ─── gnosys ask <question> ──────────────────────────────────────────────
program
  .command("ask <question>")
  .description(
    "Ask a natural-language question and get a synthesized answer with citations. Use --federated for cross-scope."
  )
  .option("-l, --limit <n>", "Max memories to retrieve", "15")
  .option("-m, --mode <mode>", "Search mode: keyword | semantic | hybrid", "hybrid")
  .option("--no-stream", "Disable streaming output")
  .option("--federated", "Use federated search with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated)")
  .option("-d, --directory <dir>", "Project directory for context")
  .action(async (question: string, opts: { limit: string; mode: string; stream: boolean; federated?: boolean; scope?: string; directory?: string }) => {
    const resolver = await getResolver();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No stores found. Run gnosys init first.");
      process.exit(1);
    }

    const storePath = stores[0].path;
    let cliConfig: GnosysConfig;
    try {
      cliConfig = await loadConfig(storePath);
    } catch {
      cliConfig = (await import("./lib/config.js")).DEFAULT_CONFIG;
    }

    const search = new GnosysSearch(storePath);
    search.clearIndex();
    for (const s of stores) {
      await search.addStoreMemories(s.store, s.label);
    }

    const embeddings = new GnosysEmbeddings(storePath);
    const hybridSearch = new GnosysHybridSearch(search, embeddings, resolver, storePath);
    const ask = new GnosysAsk(hybridSearch, cliConfig, resolver, storePath);

    if (!ask.isLLMAvailable) {
      console.error("No LLM provider available. Set ANTHROPIC_API_KEY or switch to Ollama: gnosys config set provider ollama");
      process.exit(1);
    }

    // If --federated, pre-retrieve from central DB and inject as context
    let federatedContext: string | undefined;
    if (opts.federated || opts.scope) {
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (centralDb?.isAvailable()) {
          const { federatedSearch: fSearch, detectCurrentProject } = await import("./lib/federated.js");
          const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
          const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
          const fResults = fSearch(centralDb, question, {
            limit: parseInt(opts.limit, 10),
            projectId,
            scopeFilter,
          });
          if (fResults.length > 0) {
            federatedContext = fResults.map(r => {
              const mem = centralDb!.getMemory(r.id);
              return `## ${r.title} [scope:${r.scope}, score:${r.score.toFixed(3)}]\n${mem?.content || r.snippet}`;
            }).join("\n\n");
            console.error(`[federated] Found ${fResults.length} cross-scope memories as additional context`);
          }
        }
      } catch { /* Central DB not available — fall through to normal ask */ }
      finally { centralDb?.close(); }
    }

    const mode = opts.mode as "keyword" | "semantic" | "hybrid";
    const useStream = opts.stream !== false;

    try {
      const result = await ask.ask(question, {
        limit: parseInt(opts.limit),
        mode,
        stream: useStream,
        additionalContext: federatedContext,
        callbacks: useStream
          ? {
              onToken: (token) => process.stdout.write(token),
              onSearchComplete: (count, searchMode) => {
                console.log(`\n Found ${count} relevant memories (${searchMode} search)\n`);
              },
              onDeepQuery: (refined) => {
                console.log(`\n Deep query: searching for "${refined}"...\n`);
              },
            }
          : undefined,
      });

      if (!useStream) {
        console.log(result.answer);
      }

      // Print sources
      if (result.sources.length > 0) {
        console.log("\n\n--- Sources ---");
        for (const s of result.sources) {
          console.log(`  [[${s.relativePath.split("/").pop()}]] — ${s.title}`);
        }

        // Reinforce used memories (best-effort)
        const writeTarget = resolver.getWriteTarget();
        if (writeTarget) {
          const { GnosysMaintenanceEngine } = await import("./lib/maintenance.js");
          await GnosysMaintenanceEngine.reinforceBatch(
            writeTarget.store,
            result.sources.map((s) => s.relativePath)
          ).catch(() => {});
        }
      }

      if (result.deepQueryUsed) {
        console.log("\n(Deep query was used — a follow-up search expanded the context)");
      }
    } catch (err) {
      console.error(`Ask failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    search.close();
    embeddings.close();
  });

// ─── gnosys stores ───────────────────────────────────────────────────────
program
  .command("stores")
  .description("Show all active stores, their layers, paths, and permissions")
  .action(async () => {
    const resolver = await getResolver();
    console.log(resolver.getSummary());
  });

// ─── gnosys config ──────────────────────────────────────────────────────
const configCmd = program
  .command("config")
  .description("View and manage LLM provider configuration");

configCmd
  .command("show")
  .description("Show current LLM configuration")
  .action(async () => {
    const resolver = await getResolver();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No stores found. Run gnosys init first.");
      process.exit(1);
    }

    const cfg = await loadConfig(stores[0].path);

    console.log("System of Cognition (SOC) — LLM Configuration:");
    console.log(`  Default provider: ${cfg.llm.defaultProvider}`);
    console.log("");
    console.log("  Providers:");
    console.log(`    Anthropic:  model=${cfg.llm.anthropic.model}, apiKey=${cfg.llm.anthropic.apiKey ? "config" : (process.env.ANTHROPIC_API_KEY ? "env" : "—")}`);
    console.log(`    Ollama:     model=${cfg.llm.ollama.model}, url=${cfg.llm.ollama.baseUrl}`);
    console.log(`    Groq:       model=${cfg.llm.groq.model}, apiKey=${cfg.llm.groq.apiKey ? "config" : (process.env.GROQ_API_KEY ? "env" : "—")}`);
    console.log(`    OpenAI:     model=${cfg.llm.openai.model}, apiKey=${cfg.llm.openai.apiKey ? "config" : (process.env.OPENAI_API_KEY ? "env" : "—")}, url=${cfg.llm.openai.baseUrl}`);
    console.log(`    LM Studio:  model=${cfg.llm.lmstudio.model}, url=${cfg.llm.lmstudio.baseUrl}`);
    console.log(`    xAI:        model=${cfg.llm.xai.model}, apiKey=${cfg.llm.xai.apiKey ? "config" : (process.env.XAI_API_KEY ? "env" : "—")}`);
    console.log(`    Mistral:    model=${cfg.llm.mistral.model}, apiKey=${cfg.llm.mistral.apiKey ? "config" : (process.env.MISTRAL_API_KEY ? "env" : "—")}`);
    if (cfg.llm.custom) {
      console.log(`    Custom:     model=${cfg.llm.custom.model}, url=${cfg.llm.custom.baseUrl}, apiKey=${cfg.llm.custom.apiKey ? "config" : (process.env.GNOSYS_LLM_API_KEY ? "env" : "—")}`);
    }
    console.log("");

    const structuring = resolveTaskModel(cfg, "structuring");
    const synthesis = resolveTaskModel(cfg, "synthesis");
    console.log("  Task Routing:");
    console.log(`    Structuring: ${structuring.provider}/${structuring.model}${cfg.taskModels?.structuring ? " (override)" : " (default)"}`);
    console.log(`    Synthesis:   ${synthesis.provider}/${synthesis.model}${cfg.taskModels?.synthesis ? " (override)" : " (default)"}`);
  });

configCmd
  .command("set <key> <value> [extra...]")
  .description("Set a config value. Keys: provider, model, ollama-url, groq-model, openai-model, lmstudio-url, task <task> <provider> <model>")
  .action(async (key: string, value: string, extra: string[]) => {
    const resolver = await getResolver();
    const writeTarget = resolver.getWriteTarget();
    if (!writeTarget) {
      console.error("No writable store found.");
      process.exit(1);
    }

    const storePath = writeTarget.store.getStorePath();
    const cfg = await loadConfig(storePath);
    const validProviders = ALL_PROVIDERS.join(", ");

    switch (key) {
      case "provider":
        if (!ALL_PROVIDERS.includes(value as LLMProviderName)) {
          console.error(`Invalid provider: "${value}". Supported: ${validProviders}`);
          process.exit(1);
        }
        cfg.llm.defaultProvider = value as LLMProviderName;
        console.log(`Default provider set to: ${value}`);
        break;

      case "model": {
        // Set model for current default provider
        const p = cfg.llm.defaultProvider;
        if (p === "anthropic") cfg.llm.anthropic.model = value;
        else if (p === "ollama") cfg.llm.ollama.model = value;
        else if (p === "groq") cfg.llm.groq.model = value;
        else if (p === "openai") cfg.llm.openai.model = value;
        else if (p === "lmstudio") cfg.llm.lmstudio.model = value;
        else if (p === "xai") cfg.llm.xai.model = value;
        else if (p === "mistral") cfg.llm.mistral.model = value;
        else if (p === "custom") {
          if (!cfg.llm.custom) cfg.llm.custom = { model: value, baseUrl: "" };
          else cfg.llm.custom.model = value;
        }
        console.log(`Model set to: ${value} (for ${p})`);
        break;
      }

      case "task": {
        // gnosys config set task <taskName> <provider> <model>
        const taskName = value as "structuring" | "synthesis";
        const taskProvider = extra[0] as LLMProviderName;
        const taskModel = extra[1];
        if (!taskName || !taskProvider || !taskModel) {
          console.error("Usage: gnosys config set task <structuring|synthesis> <provider> <model>");
          process.exit(1);
        }
        if (taskName !== "structuring" && taskName !== "synthesis") {
          console.error(`Invalid task: "${taskName}". Valid: structuring, synthesis`);
          process.exit(1);
        }
        if (!ALL_PROVIDERS.includes(taskProvider)) {
          console.error(`Invalid provider: "${taskProvider}". Supported: ${validProviders}`);
          process.exit(1);
        }
        if (!cfg.taskModels) cfg.taskModels = {};
        (cfg.taskModels as Record<string, { provider: LLMProviderName; model: string }>)[taskName] = { provider: taskProvider, model: taskModel };
        console.log(`Task "${taskName}" routed to: ${taskProvider}/${taskModel}`);
        break;
      }

      case "ollama-url":
        cfg.llm.ollama.baseUrl = value;
        console.log(`Ollama base URL set to: ${value}`);
        break;

      case "ollama-model":
        cfg.llm.ollama.model = value;
        console.log(`Ollama model set to: ${value}`);
        break;

      case "anthropic-model":
        cfg.llm.anthropic.model = value;
        console.log(`Anthropic model set to: ${value}`);
        break;

      case "groq-model":
        cfg.llm.groq.model = value;
        console.log(`Groq model set to: ${value}`);
        break;

      case "openai-model":
        cfg.llm.openai.model = value;
        console.log(`OpenAI model set to: ${value}`);
        break;

      case "openai-url":
        cfg.llm.openai.baseUrl = value;
        console.log(`OpenAI base URL set to: ${value}`);
        break;

      case "lmstudio-url":
        cfg.llm.lmstudio.baseUrl = value;
        console.log(`LM Studio base URL set to: ${value}`);
        break;

      case "lmstudio-model":
        cfg.llm.lmstudio.model = value;
        console.log(`LM Studio model set to: ${value}`);
        break;

      case "xai-model":
        cfg.llm.xai.model = value;
        console.log(`xAI model set to: ${value}`);
        break;

      case "mistral-model":
        cfg.llm.mistral.model = value;
        console.log(`Mistral model set to: ${value}`);
        break;

      case "custom-url":
        if (!cfg.llm.custom) cfg.llm.custom = { model: "", baseUrl: value };
        else cfg.llm.custom.baseUrl = value;
        console.log(`Custom provider base URL set to: ${value}`);
        break;

      case "custom-model":
        if (!cfg.llm.custom) cfg.llm.custom = { model: value, baseUrl: "" };
        else cfg.llm.custom.model = value;
        console.log(`Custom provider model set to: ${value}`);
        break;

      case "custom-key":
        if (!cfg.llm.custom) cfg.llm.custom = { model: "", baseUrl: "", apiKey: value };
        else cfg.llm.custom.apiKey = value;
        console.log(`Custom provider API key set.`);
        break;

      case "recall": {
        // gnosys config set recall <field> <value>
        // Supported: recall aggressive true/false, recall maxMemories <n>, recall minRelevance <n>
        const recallField = value;
        const recallValue = extra[0];
        if (!recallField || !recallValue) {
          console.error("Usage: gnosys config set recall <aggressive|maxMemories|minRelevance> <value>");
          process.exit(1);
        }
        if (!cfg.recall) cfg.recall = { aggressive: true, maxMemories: 8, minRelevance: 0.4 };
        switch (recallField) {
          case "aggressive":
            if (recallValue !== "true" && recallValue !== "false") {
              console.error(`Invalid value: "${recallValue}". Use "true" or "false".`);
              process.exit(1);
            }
            cfg.recall.aggressive = recallValue === "true";
            console.log(`Recall aggressive mode: ${cfg.recall.aggressive ? "enabled" : "disabled"}`);
            break;
          case "maxMemories": {
            const n = parseInt(recallValue, 10);
            if (isNaN(n) || n < 1 || n > 20) {
              console.error("maxMemories must be between 1 and 20");
              process.exit(1);
            }
            cfg.recall.maxMemories = n;
            console.log(`Recall maxMemories set to: ${n}`);
            break;
          }
          case "minRelevance": {
            const f = parseFloat(recallValue);
            if (isNaN(f) || f < 0 || f > 1) {
              console.error("minRelevance must be between 0 and 1");
              process.exit(1);
            }
            cfg.recall.minRelevance = f;
            console.log(`Recall minRelevance set to: ${f}`);
            break;
          }
          default:
            console.error(`Unknown recall field: "${recallField}". Valid: aggressive, maxMemories, minRelevance`);
            process.exit(1);
        }
        break;
      }

      default:
        console.error(`Unknown config key: "${key}". Valid: provider, model, task, ollama-url, ollama-model, anthropic-model, groq-model, openai-model, openai-url, lmstudio-url, lmstudio-model, recall`);
        process.exit(1);
    }

    await writeConfig(storePath, cfg);
    console.log("Configuration saved to gnosys.json");
  });

configCmd
  .command("init")
  .description("Generate a default gnosys.json with LLM settings")
  .action(async () => {
    const resolver = await getResolver();
    const writeTarget = resolver.getWriteTarget();
    if (!writeTarget) {
      console.error("No writable store found.");
      process.exit(1);
    }

    const storePath = writeTarget.store.getStorePath();
    const configPath = path.join(storePath, "gnosys.json");

    try {
      await fs.access(configPath);
      console.error("gnosys.json already exists. Use 'gnosys config set' to modify.");
      process.exit(1);
    } catch {
      // File doesn't exist — good
    }

    await fs.writeFile(configPath, generateConfigTemplate() + "\n", "utf-8");
    console.log(`Created ${configPath}`);
  });

// ─── gnosys reindex-graph ───────────────────────────────────────────────
program
  .command("reindex-graph")
  .description("Build or rebuild the wikilink graph (.gnosys/graph.json)")
  .action(async () => {
    const { reindexGraph, formatGraphStats } = await import("./lib/graph.js");

    const resolver = await getResolver();
    const stores = resolver.getStores();

    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run gnosys init first.");
      process.exit(1);
    }

    const stats = await reindexGraph(resolver, (msg) => console.log(msg));
    console.log("");
    console.log(formatGraphStats(stats));
  });

// ─── gnosys dashboard ───────────────────────────────────────────────────
program
  .command("dashboard")
  .description("Show system dashboard: memory count, health, graph stats, LLM status")
  .option("--json", "Output as JSON instead of pretty table")
  .action(async (opts: { json?: boolean }) => {
    const { collectDashboardData, formatDashboard, formatDashboardJSON } = await import("./lib/dashboard.js");

    const resolver = await getResolver();
    const stores = resolver.getStores();

    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run gnosys init first.");
      process.exit(1);
    }

    const cfg = await loadConfig(stores[0].path);

    // v2.0: Try to open GnosysDB for dashboard stats
    let dashDb: import("./lib/db.js").GnosysDB | undefined;
    try {
      const { GnosysDB: DbClass } = await import("./lib/db.js");
      const db = new DbClass(stores[0].path);
      if (db.isAvailable() && db.isMigrated()) {
        dashDb = db;
      }
    } catch {
      // GnosysDB not available — legacy dashboard only
    }

    const data = await collectDashboardData(resolver, cfg, pkg.version, dashDb);

    if (opts.json) {
      console.log(formatDashboardJSON(data));
    } else {
      console.log(formatDashboard(data));
    }
  });

// ─── gnosys maintain ─────────────────────────────────────────────────────
program
  .command("maintain")
  .description("Run vault maintenance: detect duplicates, apply confidence decay, consolidate similar memories")
  .option("--dry-run", "Show what would change without modifying anything")
  .option("--auto-apply", "Automatically apply all changes (no prompts)")
  .action(async (opts: { dryRun?: boolean; autoApply?: boolean }) => {
    const { GnosysMaintenanceEngine, formatMaintenanceReport } = await import("./lib/maintenance.js");

    const resolver = await getResolver();
    const stores = resolver.getStores();

    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run gnosys init first.");
      process.exit(1);
    }

    const cfg = await loadConfig(stores[0].path);

    const engine = new GnosysMaintenanceEngine(resolver, cfg);
    const report = await engine.maintain({
      dryRun: opts.dryRun,
      autoApply: opts.autoApply,
      onLog: (level, message) => {
        if (level === "warn") {
          console.error(`⚠ ${message}`);
        } else if (level === "action") {
          console.log(`→ ${message}`);
        } else {
          console.log(message);
        }
      },
      onProgress: (step, current, total) => {
        process.stdout.write(`\r[${current}/${total}] ${step}...`);
        if (current === total) process.stdout.write("\n");
      },
    });

    console.log("");
    console.log(formatMaintenanceReport(report));
  });

// ─── gnosys dearchive ───────────────────────────────────────────────────
program
  .command("dearchive <query>")
  .description("Force-dearchive memories matching a query from archive.db back to active")
  .option("--limit <n>", "Max memories to dearchive", "5")
  .action(async (query: string, opts: { limit: string }) => {
    const { GnosysArchive } = await import("./lib/archive.js");

    const resolver = await getResolver();
    const stores = resolver.getStores();

    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run gnosys init first.");
      process.exit(1);
    }

    const writeTarget = resolver.getWriteTarget();
    if (!writeTarget) {
      console.error("No writable store found.");
      process.exit(1);
    }

    const archive = new GnosysArchive(writeTarget.path);
    if (!archive.isAvailable()) {
      console.error("Archive not available. Is better-sqlite3 installed?");
      process.exit(1);
    }

    const results = archive.searchArchive(query, parseInt(opts.limit));
    if (results.length === 0) {
      console.log(`No archived memories found matching "${query}".`);
      archive.close();
      return;
    }

    console.log(`Found ${results.length} archived memories matching "${query}":\n`);
    for (const r of results) {
      console.log(`  • ${r.title} (${r.id})`);
    }
    console.log("");

    // Dearchive all found
    const ids = results.map((r) => r.id);
    const restored = await archive.dearchiveBatch(ids, writeTarget.store);
    archive.close();

    console.log(`Dearchived ${restored.length} memories back to active:`);
    for (const rp of restored) {
      console.log(`  → ${rp}`);
    }
  });

// NOTE: gnosys migrate is defined below (near the end) with --to-central support

// ─── gnosys upgrade ─────────────────────────────────────────────────────
program
  .command("upgrade")
  .description("Re-initialize all registered projects after a Gnosys version upgrade. Updates agent rules, project registry, and stamps the central DB with the current version.")
  .action(async () => {
    const currentVersion = pkg.version;
    console.log(`Gnosys v${currentVersion} — upgrading registered projects...\n`);

    // 1. Read registered projects from file registry AND central DB
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const registryPath = path.join(home, ".config", "gnosys", "projects.json");
    let fileProjects: string[] = [];
    try {
      fileProjects = JSON.parse(await fs.readFile(registryPath, "utf-8"));
    } catch {
      // No file registry yet
    }

    // Also check central DB for projects not in the file registry
    let dbProjects: string[] = [];
    try {
      const centralDb = GnosysDB.openCentral();
      if (centralDb.isAvailable()) {
        const allProjects = centralDb.getAllProjects();
        dbProjects = allProjects.map((p) => p.working_directory);
        centralDb.close();
      }
    } catch {
      // non-critical
    }

    // Merge: deduplicate by resolved path
    const seen = new Set<string>();
    const projects: string[] = [];
    for (const p of [...fileProjects, ...dbProjects]) {
      const resolved = path.resolve(p);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        projects.push(resolved);
      }
    }

    if (projects.length === 0) {
      console.log("No registered projects found. Run 'gnosys init' in each project first.");
      return;
    }

    // Sync the merged list back to file registry
    try {
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(registryPath, JSON.stringify(projects, null, 2), "utf-8");
    } catch {
      // non-critical
    }

    // 2. Iterate and upgrade each project that exists on this machine
    const upgraded: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const projectDir of projects) {
      const storePath = path.join(projectDir, ".gnosys");
      try {
        await fs.stat(storePath);
      } catch {
        skipped.push(projectDir);
        continue;
      }

      try {
        // Re-create project identity (re-syncs with central DB)
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          if (!centralDb.isAvailable()) centralDb = null;
        } catch {
          centralDb = null;
        }

        await createProjectIdentity(projectDir, { centralDb: centralDb || undefined });

        // Re-register in file-based registry (idempotent)
        const tempResolver = new GnosysResolver();
        await tempResolver.registerProject(projectDir);

        // Re-generate agent rules for all detected IDEs
        if (centralDb) {
          const { syncToTarget } = await import("./lib/rulesGen.js");
          const { readProjectIdentity } = await import("./lib/projectIdentity.js");
          const identity = await readProjectIdentity(projectDir);
          const projectId = identity?.projectId || null;

          try {
            await syncToTarget(centralDb, projectDir, "all", projectId);
          } catch {
            // Some projects may not have IDE configs — that's ok
          }

          centralDb.close();
        }

        // Configure IDE hooks for automatic memory recall
        const { configureIdeHooks } = await import("./lib/projectIdentity.js");
        await configureIdeHooks(projectDir);

        upgraded.push(projectDir);
      } catch (err) {
        failed.push(`${projectDir} (${(err as Error).message})`);
      }
    }

    // 3. Update global agent rules
    try {
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) centralDb = null;
      } catch {
        centralDb = null;
      }
      if (centralDb) {
        const { syncToTarget } = await import("./lib/rulesGen.js");
        await syncToTarget(centralDb, process.cwd(), "global", null);
        centralDb.close();
        console.log(`  ✓ Global agent rules updated (~/.claude/CLAUDE.md)`);
      }
    } catch {
      console.log(`  ⚠ Could not update global agent rules`);
    }

    // 4. Stamp the central DB with current version and machine info
    try {
      const centralDb = GnosysDB.openCentral();
      if (centralDb.isAvailable()) {
        const hostname = os.hostname();
        centralDb.setMeta("app_version", currentVersion);
        centralDb.setMeta("last_upgrade", new Date().toISOString());
        centralDb.setMeta("upgraded_by", hostname);

        // Track all machines that have accessed this DB
        let machines: Record<string, { version: string; lastSeen: string }> = {};
        try {
          const raw = centralDb.getMeta("machines");
          if (raw) machines = JSON.parse(raw);
        } catch { /* fresh start */ }
        machines[hostname] = { version: currentVersion, lastSeen: new Date().toISOString() };
        centralDb.setMeta("machines", JSON.stringify(machines));

        centralDb.close();
      }
    } catch {
      // non-critical
    }

    // 5. Report
    console.log("");
    if (upgraded.length > 0) {
      console.log(`Upgraded (${upgraded.length}):`);
      for (const p of upgraded) console.log(`  ✓ ${path.basename(p)} — ${p}`);
    }
    if (skipped.length > 0) {
      console.log(`\nSkipped — not on this machine (${skipped.length}):`);
      for (const p of skipped) console.log(`  ○ ${path.basename(p)} — ${p}`);
    }
    if (failed.length > 0) {
      console.log(`\nFailed (${failed.length}):`);
      for (const f of failed) console.log(`  ✗ ${f}`);
    }
    console.log(`\nDone. Central DB stamped with v${currentVersion}.`);

    // Show machine status from shared DB
    try {
      const centralDb = GnosysDB.openCentral();
      if (centralDb.isAvailable()) {
        const raw = centralDb.getMeta("machines");
        if (raw) {
          const machines = JSON.parse(raw) as Record<string, { version: string; lastSeen: string }>;
          const entries = Object.entries(machines);
          if (entries.length > 1) {
            console.log(`\nConnected machines:`);
            for (const [host, info] of entries) {
              const isCurrent = host === os.hostname();
              const status = info.version === currentVersion ? "✓" : `⚠ v${info.version}`;
              console.log(`  ${status} ${host}${isCurrent ? " (this machine)" : ""} — last seen ${info.lastSeen.split("T")[0]}`);
            }
            const behind = entries.filter(([, info]) => info.version !== currentVersion);
            if (behind.length > 0) {
              console.log(`\n  ${behind.length} machine(s) need upgrading. Run 'npm install -g gnosys && gnosys upgrade' on each.`);
            }
          }
        }
        centralDb.close();
      }
    } catch {
      // non-critical
    }

    if (skipped.length > 0) {
      console.log(`\nNote: ${skipped.length} project(s) not found on this machine.`);
      console.log(`If they exist on another machine, run 'gnosys upgrade' there too.`);
    }
  });

// ─── gnosys doctor ──────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check system health: stores, LLM connectivity, embeddings, archive")
  .action(async () => {
    const resolver = await getResolver();
    const stores = resolver.getStores();

    console.log("Gnosys Doctor");
    console.log("=============\n");

    // Check gnosys.db (v2.0 agent-native store)
    if (stores.length > 0) {
      console.log("Agent-Native Store (gnosys.db):");
      try {
        const db = new GnosysDB(stores[0].path);
        if (db.isAvailable() && db.isMigrated()) {
          const counts = db.getMemoryCount();
          console.log(`  Status: ✓ migrated (schema v${db.getSchemaVersion()})`);
          console.log(`  Active: ${counts.active} | Archived: ${counts.archived} | Total: ${counts.total}`);
        } else if (db.isAvailable()) {
          console.log("  Status: ✗ not migrated (run gnosys migrate)");
        } else {
          console.log("  Status: — not available (better-sqlite3 not installed)");
        }
        db.close();
      } catch {
        console.log("  Status: — not initialized");
      }
      console.log("");
    }

    // Check stores
    console.log("Stores:");
    if (stores.length === 0) {
      console.log("  No stores found. Run gnosys init first.");
    } else {
      for (const s of stores) {
        const memories = await s.store.getAllMemories();
        console.log(`  ${s.label}: ${memories.length} memories (${s.path})`);
      }
    }
    console.log("");

    // Check archive
    if (stores.length > 0) {
      console.log("Archive (Two-Tier Memory):");
      try {
        const { GnosysArchive } = await import("./lib/archive.js");
        const archive = new GnosysArchive(stores[0].path);
        if (archive.isAvailable()) {
          const stats = archive.getStats();
          console.log(`  Archived memories: ${stats.totalArchived}`);
          if (stats.totalArchived > 0) {
            console.log(`  Archive DB size: ${stats.dbSizeMB.toFixed(2)} MB`);
            console.log(`  Oldest archived: ${stats.oldestArchived}`);
            console.log(`  Newest archived: ${stats.newestArchived}`);
          }
          archive.close();
        } else {
          console.log("  Not available (better-sqlite3 not installed)");
        }
      } catch {
        console.log("  Not initialized");
      }
      console.log("");
    }

    // Check config — SOC routing + recall
    const cfg = stores.length > 0 ? await loadConfig(stores[0].path) : DEFAULT_CONFIG;

    console.log("Recall (Automatic Memory Injection):");
    const recallMode = cfg.recall?.aggressive !== false ? "aggressive" : "filtered";
    console.log(`  Mode: ${recallMode}`);
    console.log(`  Max memories per turn: ${cfg.recall?.maxMemories ?? 8}`);
    console.log(`  Min relevance: ${cfg.recall?.minRelevance ?? 0.4}`);
    console.log("");

    console.log("System of Cognition (SOC):");
    console.log(`  Default provider: ${cfg.llm.defaultProvider}`);

    const structuring = resolveTaskModel(cfg, "structuring");
    const synthesis = resolveTaskModel(cfg, "synthesis");
    console.log(`  Structuring → ${structuring.provider}/${structuring.model}`);
    console.log(`  Synthesis   → ${synthesis.provider}/${synthesis.model}`);
    console.log("");

    // Check all LLM providers
    console.log("LLM Connectivity:");

    for (const providerName of ALL_PROVIDERS) {
      const status = isProviderAvailable(cfg, providerName);
      if (!status.available) {
        console.log(`  ${providerName}: — ${status.error}`);
        continue;
      }
      try {
        const provider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: providerName } });
        await provider.testConnection();
        const model = getProviderModel(cfg, providerName);
        console.log(`  ${providerName}: ✓ connected (${model})`);
      } catch (err) {
        console.log(`  ${providerName}: ✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log("");

    // Check embeddings
    if (stores.length > 0) {
      console.log("Embeddings:");
      const embeddings = new GnosysEmbeddings(stores[0].path);
      try {
        const stats = embeddings.getStats();
        if (stats.count > 0) {
          console.log(`  Index: ${stats.count} embeddings (${stats.dbSizeMB.toFixed(1)} MB)`);
        } else {
          console.log("  Index: empty (run gnosys reindex to build)");
        }
      } catch {
        console.log("  Index: not initialized (run gnosys reindex to build)");
      }

      // Maintenance health
      console.log("");
      console.log("Maintenance Health:");
      try {
        const { GnosysMaintenanceEngine } = await import("./lib/maintenance.js");
        const engine = new GnosysMaintenanceEngine(resolver, cfg);
        const health = await engine.getHealthReport();
        console.log(`  Active memories: ${health.totalActive}`);
        console.log(`  Stale (confidence < 0.3): ${health.staleCount}`);
        console.log(`  Average confidence: ${health.avgConfidence.toFixed(3)} (decayed: ${health.avgDecayedConfidence.toFixed(3)})`);
        console.log(`  Never reinforced: ${health.neverReinforced}`);
        console.log(`  Total reinforcements: ${health.totalReinforcements}`);
      } catch (err) {
        console.log(`  Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

// ─── gnosys check ─────────────────────────────────────────────────────────
program
  .command("check")
  .description("Test LLM connectivity for all 5 task configurations (structuring, synthesis, vision, transcription, dream)")
  .option("-d, --directory <dir>", "Project directory (default: cwd)")
  .action(async (opts: { directory?: string }) => {
    const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();
    const storePath = path.join(projectDir, ".gnosys");
    const cfg = await loadConfig(storePath);

    const GREEN = "\x1b[32m";
    const RED = "\x1b[31m";
    const YELLOW = "\x1b[33m";
    const DIM = "\x1b[2m";
    const BOLD = "\x1b[1m";
    const RESET = "\x1b[0m";
    const CHECK = `${GREEN}✓${RESET}`;
    const CROSS = `${RED}✗${RESET}`;
    const WARN = `${YELLOW}⚠${RESET}`;

    console.log(`\n${BOLD}Gnosys LLM Check${RESET}\n`);

    // Define the 5 tasks and how to resolve each
    interface TaskCheck {
      name: string;
      description: string;
      resolve: () => { provider: string; model: string };
      needsKey?: boolean;
    }

    const tasks: TaskCheck[] = [
      {
        name: "structuring",
        description: "adding memories, tagging",
        resolve: () => resolveTaskModel(cfg, "structuring"),
      },
      {
        name: "synthesis",
        description: "Q&A answers (gnosys ask)",
        resolve: () => resolveTaskModel(cfg, "synthesis"),
      },
      {
        name: "vision",
        description: "images, PDFs",
        resolve: () => resolveTaskModel(cfg, "vision"),
      },
      {
        name: "transcription",
        description: "audio files",
        resolve: () => resolveTaskModel(cfg, "transcription"),
      },
      {
        name: "dream",
        description: "overnight consolidation",
        resolve: () => ({
          provider: cfg.dream?.provider || "ollama",
          model: cfg.dream?.model || "llama3.2",
        }),
      },
    ];

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const task of tasks) {
      const { provider, model } = task.resolve();
      const label = `${task.name.padEnd(16)} ${DIM}${provider} / ${model}${RESET}`;
      const desc = `${DIM}(${task.description})${RESET}`;

      // Special handling for dream — check if enabled
      if (task.name === "dream" && !cfg.dream?.enabled) {
        console.log(`  ${WARN} ${label}  disabled  ${desc}`);
        skipped++;
        continue;
      }

      // Check provider availability (API key, etc.)
      const availability = isProviderAvailable(cfg, provider as LLMProviderName);
      if (!availability.available) {
        console.log(`  ${CROSS} ${label}  ${RED}${availability.error}${RESET}  ${desc}`);
        failed++;
        continue;
      }

      // Test actual connection with timing
      const start = Date.now();
      try {
        const llmProvider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: provider as LLMProviderName } });
        await llmProvider.testConnection();
        const ms = Date.now() - start;
        console.log(`  ${CHECK} ${label}  ${GREEN}${ms}ms${RESET}  ${desc}`);
        passed++;
      } catch (err) {
        const ms = Date.now() - start;
        const errMsg = err instanceof Error ? err.message : String(err);
        // Truncate long error messages
        const shortErr = errMsg.length > 60 ? errMsg.slice(0, 57) + "..." : errMsg;
        console.log(`  ${CROSS} ${label}  ${RED}${shortErr}${RESET} (${ms}ms)  ${desc}`);
        failed++;
      }
    }

    console.log();
    const total = passed + failed + skipped;
    if (failed === 0) {
      console.log(`${CHECK} All ${passed}/${total} tasks connected.`);
    } else {
      console.log(`${passed}/${total} connected, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}.`);
      console.log(`\n${DIM}Fix: Run 'gnosys setup' to configure providers and API keys.${RESET}`);
    }
    console.log();
  });

// ─── gnosys dream ────────────────────────────────────────────────────────
program
  .command("dream")
  .description("Run a Dream Mode cycle — idle-time consolidation (decay, summaries, self-critique, relationships)")
  .option("--max-runtime <minutes>", "Max runtime in minutes (default: 30)")
  .option("--no-critique", "Skip self-critique phase")
  .option("--no-summaries", "Skip summary generation")
  .option("--no-relationships", "Skip relationship discovery")
  .option("--json", "Output raw JSON report")
  .action(async (opts: { maxRuntime?: string; critique?: boolean; summaries?: boolean; relationships?: boolean; json?: boolean }) => {
    const resolver = new GnosysResolver();
    await resolver.resolve();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run 'gnosys init' first.");
      process.exit(1);
    }

    const { GnosysDB: DbClass } = await import("./lib/db.js");
    const { GnosysDreamEngine, formatDreamReport } = await import("./lib/dream.js");

    const storePath = stores[0].path;
    const cfg = await loadConfig(storePath);
    const db = new DbClass(storePath);

    if (!db.isAvailable() || !db.isMigrated()) {
      console.error("Dream Mode requires gnosys.db (v2.0). Run 'gnosys migrate' first.");
      process.exit(1);
    }

    const dreamConfig = {
      enabled: true,
      idleMinutes: 0,
      maxRuntimeMinutes: opts.maxRuntime ? parseInt(opts.maxRuntime, 10) : 30,
      selfCritique: opts.critique !== false,
      generateSummaries: opts.summaries !== false,
      discoverRelationships: opts.relationships !== false,
      minMemories: 1,
      provider: cfg.dream?.provider || ("ollama" as const),
      model: cfg.dream?.model,
    };

    console.error("Starting Dream Mode cycle...");
    const engine = new GnosysDreamEngine(db, cfg, dreamConfig);
    const report = await engine.dream((phase, detail) => {
      console.error(`  [${phase}] ${detail}`);
    });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDreamReport(report));
    }

    db.close();
  });

// ─── gnosys export ───────────────────────────────────────────────────────
program
  .command("export")
  .description("Export gnosys.db to Obsidian-compatible vault (one-way)")
  .requiredOption("--to <dir>", "Target directory for export")
  .option("--all", "Export all memories (active + archived)")
  .option("--overwrite", "Overwrite existing files")
  .option("--no-summaries", "Skip category summaries")
  .option("--no-reviews", "Skip review suggestions")
  .option("--no-graph", "Skip relationship graph")
  .option("--json", "Output raw JSON report")
  .action(async (opts: { to: string; all?: boolean; overwrite?: boolean; summaries?: boolean; reviews?: boolean; graph?: boolean; json?: boolean }) => {
    const resolver = new GnosysResolver();
    await resolver.resolve();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run 'gnosys init' first.");
      process.exit(1);
    }

    const { GnosysDB: DbClass } = await import("./lib/db.js");
    const { GnosysExporter, formatExportReport } = await import("./lib/export.js");

    const storePath = stores[0].path;
    const db = new DbClass(storePath);

    if (!db.isAvailable() || !db.isMigrated()) {
      console.error("Export requires gnosys.db (v2.0). Run 'gnosys migrate' first.");
      process.exit(1);
    }

    const targetDir = path.resolve(opts.to);
    console.error(`Exporting to: ${targetDir}`);

    const exporter = new GnosysExporter(db);
    const report = await exporter.export({
      targetDir,
      activeOnly: !opts.all,
      includeSummaries: opts.summaries !== false,
      includeReviews: opts.reviews !== false,
      includeGraph: opts.graph !== false,
      overwrite: opts.overwrite || false,
      onProgress: (current, total, file) => {
        if (current % 10 === 0 || current === total) {
          console.error(`  [${current}/${total}] ${file}`);
        }
      },
    });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatExportReport(report));
    }

    db.close();
  });

// ─── gnosys serve ────────────────────────────────────────────────────────
program
  .command("serve")
  .description("Start the MCP server (stdio mode)")
  .option("--with-maintenance", "Run maintenance every 6 hours in background")
  .action(async (opts: { withMaintenance?: boolean }) => {
    if (opts.withMaintenance) {
      // Start background maintenance loop
      const SIX_HOURS = 6 * 60 * 60 * 1000;
      const runMaintenance = async () => {
        try {
          const { GnosysMaintenanceEngine } = await import("./lib/maintenance.js");
          const resolver = new (await import("./lib/resolver.js")).GnosysResolver();
          await resolver.resolve();
          const stores = resolver.getStores();
          if (stores.length > 0) {
            const cfg = await loadConfig(stores[0].path);
            const engine = new GnosysMaintenanceEngine(resolver, cfg);
            const report = await engine.maintain({ autoApply: true });
            console.error(`[maintenance] Completed: ${report.actions.length} action(s), ${report.duplicates.length} duplicate(s), ${report.staleMemories.length} stale`);
          }
        } catch (err) {
          console.error(`[maintenance] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      // Run immediately on start, then every 6 hours
      setTimeout(runMaintenance, 30000); // 30s after server start
      setInterval(runMaintenance, SIX_HOURS);
      console.error("[maintenance] Background maintenance enabled (every 6 hours)");
    }

    await import("./index.js");
  });

// ─── gnosys recall ───────────────────────────────────────────────────────
program
  .command("recall <query>")
  .description("Always-on memory recall — injects most relevant memories as context. Use --federated for cross-scope.")
  .option("--limit <n>", "Max memories to return (default from config)")
  .option("--aggressive", "Force aggressive mode (inject even medium-relevance memories)")
  .option("--no-aggressive", "Force filtered mode (hard cutoff at minRelevance)")
  .option("--trace-id <id>", "Trace ID for audit correlation")
  .option("--json", "Output raw JSON instead of formatted text")
  .option("--host", "Output in host-friendly <gnosys-recall> format (default for MCP)")
  .option("--federated", "Use federated search with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated)")
  .option("-d, --directory <dir>", "Project directory for context")
  .action(async (query: string, opts: { limit?: string; aggressive?: boolean; traceId?: string; json?: boolean; host?: boolean; federated?: boolean; scope?: string; directory?: string }) => {
    // Federated recall path — returns tier-boosted results from central DB
    if (opts.federated || opts.scope) {
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

        const { federatedSearch, detectCurrentProject } = await import("./lib/federated.js");
        const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
        const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
        const limit = opts.limit ? parseInt(opts.limit, 10) : 10;
        const results = federatedSearch(centralDb, query, { limit, projectId, scopeFilter });

        // Format as recall-like output with scope info
        const recallResult = {
          query,
          projectId,
          mode: "federated",
          count: results.length,
          memories: results.map(r => ({
            id: r.id,
            title: r.title,
            category: r.category,
            scope: r.scope,
            score: r.score,
            boosts: r.boosts,
            snippet: r.snippet,
            projectName: r.projectName,
          })),
        };

        if (opts.json) {
          console.log(JSON.stringify(recallResult, null, 2));
        } else if (opts.host) {
          const lines = [`<gnosys-recall query="${query}" mode="federated" count="${results.length}">`];
          for (const r of results) {
            lines.push(`  <memory id="${r.id}" scope="${r.scope}" score="${r.score.toFixed(4)}">`);
            lines.push(`    ${r.title}: ${r.snippet?.substring(0, 200) || ""}`);
            lines.push(`  </memory>`);
          }
          lines.push(`</gnosys-recall>`);
          console.log(lines.join("\n"));
        } else {
          if (results.length === 0) { console.log(`No memories found for "${query}".`); }
          else {
            console.log(`Recall: ${results.length} memories for "${query}" (federated)\n`);
            for (const r of results) {
              const proj = r.projectName ? ` [${r.projectName}]` : "";
              console.log(`  ${r.title}${proj} (${r.scope}, ${r.score.toFixed(4)})`);
              if (r.snippet) console.log(`    ${r.snippet.substring(0, 100)}`);
            }
          }
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        centralDb?.close();
      }
      return;
    }

    // Legacy file-based recall
    const resolver = new GnosysResolver();
    await resolver.resolve();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run 'gnosys init' first.");
      process.exit(1);
    }

    const { recall, formatRecall, formatRecallCLI } = await import("./lib/recall.js");
    const { initAudit, closeAudit } = await import("./lib/audit.js");

    const storePath = stores[0].path;
    initAudit(storePath);

    // Load config for recall settings
    const cfg = await loadConfig(storePath);
    const recallConfig = {
      ...cfg.recall,
      ...(opts.aggressive !== undefined ? { aggressive: opts.aggressive } : {}),
    };

    // Build search index
    const search = new GnosysSearch(storePath);
    await search.addStoreMemories(stores[0].store);

    const result = await recall(query, {
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      search,
      resolver,
      storePath,
      traceId: opts.traceId,
      recallConfig,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (opts.host) {
      console.log(formatRecall(result));
    } else {
      console.log(formatRecallCLI(result));
    }

    closeAudit();
  });

// ─── gnosys audit ────────────────────────────────────────────────────────
program
  .command("audit")
  .description("View the structured audit trail of memory operations")
  .option("--days <n>", "Show entries from the last N days", "7")
  .option("--operation <op>", "Filter by operation type (read, write, recall, etc.)")
  .option("--limit <n>", "Max entries to show")
  .option("--json", "Output raw JSON instead of formatted timeline")
  .action(async (opts: { days: string; operation?: string; limit?: string; json?: boolean }) => {
    const resolver = new GnosysResolver();
    await resolver.resolve();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run 'gnosys init' first.");
      process.exit(1);
    }

    const { readAuditLog, formatAuditTimeline } = await import("./lib/audit.js");
    const storePath = stores[0].path;

    const entries = readAuditLog(storePath, {
      days: parseInt(opts.days, 10),
      operation: opts.operation as import("./lib/audit.js").AuditOperation | undefined,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(formatAuditTimeline(entries));
    }
  });

// ─── gnosys backup ──────────────────────────────────────────────────────
program
  .command("backup")
  .description("Create a backup of the central Gnosys database and config")
  .option("-o, --output <dir>", "Backup output directory (default: ~/.gnosys/)")
  .option("--to <dir>", "Alias for --output")
  .option("--json", "Output as JSON")
  .action(async (opts: { output?: string; to?: string; json?: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      const outputDir = opts.to || opts.output;
      const backupPath = await centralDb.backup(outputDir);
      const counts = centralDb.getMemoryCount();
      const projectCount = centralDb.getAllProjects().length;

      // Copy sandbox log if it exists
      const centralDir = GnosysDB.getCentralDbDir();
      const copiedFiles: string[] = [backupPath];
      const backupDir = path.dirname(backupPath);
      const sandboxLog = path.join(centralDir, "sandbox", "sandbox.log");
      if (existsSync(sandboxLog)) {
        const logDest = path.join(backupDir, "sandbox.log.bak");
        copyFileSync(sandboxLog, logDest);
        copiedFiles.push(logDest);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true, backupPath, memories: counts.total,
          active: counts.active, archived: counts.archived,
          projects: projectCount, files: copiedFiles,
        }));
      } else {
        console.log(`Backup created: ${backupPath}`);
        console.log(`  Memories: ${counts.total} (${counts.active} active, ${counts.archived} archived)`);
        console.log(`  Projects: ${projectCount}`);
        if (copiedFiles.length > 1) console.log(`  Additional files: ${copiedFiles.length - 1}`);
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Backup failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys restore ─────────────────────────────────────────────────────
program
  .command("restore <backupFile>")
  .description("Restore the central Gnosys database from a backup")
  .option("--from <file>", "Alias: backup file to restore from")
  .option("--json", "Output as JSON")
  .action(async (backupFile: string, opts: { from?: string; json?: boolean }) => {
    const resolved = path.resolve(opts.from || backupFile);
    try {
      const db = GnosysDB.restore(resolved);
      const counts = db.getMemoryCount();
      const projectCount = db.getAllProjects().length;

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true, source: resolved, memories: counts.total,
          active: counts.active, archived: counts.archived, projects: projectCount,
        }));
      } else {
        console.log(`Database restored from ${resolved}`);
        console.log(`  Memories: ${counts.total} (${counts.active} active, ${counts.archived} archived)`);
        console.log(`  Projects: ${projectCount}`);
      }
      db.close();
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

// ─── gnosys migrate-db ──────────────────────────────────────────────────
program
  .command("migrate-db")
  .description("Legacy data migration. Use --to-central to move per-project stores into the central DB.")
  .option("--to-central", "Migrate all discovered per-project stores into ~/.gnosys/gnosys.db")
  .option("-v, --verbose", "Verbose output")
  .action(async (opts: { toCentral?: boolean; verbose?: boolean }) => {
    if (!opts.toCentral) {
      // Legacy v1→v2 migration (existing behavior)
      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget();
      if (!writeTarget) {
        console.error("No writable store found. Run 'gnosys init' first.");
        process.exit(1);
      }
      const stats = await migrate(writeTarget.store.getStorePath(), { verbose: opts.verbose });
      console.log(formatMigrationReport(stats));
      return;
    }

    // v3.0: Migrate per-project stores into central DB
    console.log("Migrating per-project stores to central DB (~/.gnosys/gnosys.db)...\n");

    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }
    } catch (err) {
      console.error(`Cannot open central DB: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // Discover all registered project stores
    const resolver = await getResolver();
    const detectedStores = await resolver.detectAllStores();
    const projectDirs = detectedStores
      .filter(s => s.hasGnosys)
      .map(s => s.path);

    if (projectDirs.length === 0) {
      console.log("No per-project stores found to migrate.");
      centralDb.close();
      return;
    }

    console.log(`Found ${projectDirs.length} project store(s) to migrate:\n`);

    let totalMemories = 0;
    let totalProjects = 0;

    for (const projectDir of projectDirs) {
      const storePath = path.join(projectDir, ".gnosys");
      const log = opts.verbose ? console.log : () => {};

      try {
        // Create project identity if it doesn't exist
        const identity = await createProjectIdentity(projectDir, {
          centralDb: centralDb!,
        });

        log(`  [${identity.projectName}] ID: ${identity.projectId}`);

        // Open per-project DB and import memories
        const projectDb = new GnosysDB(storePath);
        if (!projectDb.isAvailable() || !projectDb.isMigrated()) {
          log(`  [${identity.projectName}] No migrated gnosys.db — skipping`);
          continue;
        }

        const memories = projectDb.getAllMemories();
        let count = 0;
        centralDb!.transaction(() => {
          for (const mem of memories) {
            centralDb!.insertMemory({
              ...mem,
              project_id: identity.projectId,
              scope: "project",
            });
            count++;
          }
        });

        projectDb.close();
        totalMemories += count;
        totalProjects++;
        console.log(`  ✓ ${identity.projectName}: ${count} memories migrated`);
      } catch (err) {
        console.error(`  ✗ ${projectDir}: ${err instanceof Error ? err.message : err}`);
      }
    }

    centralDb!.close();

    console.log(`\n╔════════════════════════════════════════╗`);
    console.log(`║  Central Migration Complete            ║`);
    console.log(`╚════════════════════════════════════════╝`);
    console.log(`  Projects migrated: ${totalProjects}`);
    console.log(`  Memories imported:  ${totalMemories}`);
    console.log(`\n  Per-project gnosys.db files are untouched.`);
    console.log(`  Central DB: ${GnosysDB.getCentralDbPath()}`);
  });

// ─── gnosys projects ────────────────────────────────────────────────────
program
  .command("projects")
  .description("List all registered projects in the central DB")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      const projects = centralDb.getAllProjects();
      if (projects.length === 0) {
        console.log("No projects registered. Run 'gnosys init' in a project directory.");
        centralDb.close();
        return;
      }

      const projectData = projects.map((p) => ({
        ...p,
        memoryCount: centralDb!.getMemoriesByProject(p.id).length,
      }));

      outputResult(!!opts.json, { count: projects.length, projects: projectData }, () => {
        console.log(`${projects.length} registered project(s):\n`);
        for (const p of projectData) {
          console.log(`  ${p.name}`);
          console.log(`    ID:        ${p.id}`);
          console.log(`    Directory: ${p.working_directory}`);
          console.log(`    Memories:  ${p.memoryCount}`);
          console.log(`    Created:   ${p.created}`);
          console.log();
        }
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys pref ─────────────────────────────────────────────────────────
const prefCmd = program
  .command("pref")
  .description("Manage user preferences (stored in central DB, scope='user')");

prefCmd
  .command("set <key> <value>")
  .description("Set a user preference. Key should be kebab-case (e.g. 'commit-convention').")
  .option("-t, --title <title>", "Human-readable title")
  .option("--tags <tags>", "Comma-separated tags")
  .action(async (key: string, value: string, opts: { title?: string; tags?: string }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()) : undefined;
      const pref = setPreference(centralDb, key, value, { title: opts.title, tags });
      console.log(`Preference set: ${pref.title}`);
      console.log(`  Key:   ${pref.key}`);
      console.log(`  Value: ${pref.value}`);
      console.log(`\nRun 'gnosys sync' to update agent rules files.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

prefCmd
  .command("get [key]")
  .description("Get a preference by key, or list all preferences if no key given.")
  .option("--json", "Output as JSON")
  .action(async (key: string | undefined, opts: { json?: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      if (key) {
        const pref = getPreference(centralDb, key);
        if (!pref) {
          console.log(`No preference found for key "${key}".`);
          return;
        }
        outputResult(!!opts.json, pref, () => {
          console.log(`${pref.title} (${pref.key})\n`);
          console.log(pref.value);
          console.log(`\nConfidence: ${pref.confidence}`);
          console.log(`Modified: ${pref.modified}`);
        });
      } else {
        const prefs = getAllPreferences(centralDb);
        if (prefs.length === 0) {
          outputResult(!!opts.json, { preferences: [] }, () => {
            console.log("No preferences set. Use 'gnosys pref set <key> <value>' to add some.");
          });
          return;
        }
        outputResult(!!opts.json, { count: prefs.length, preferences: prefs }, () => {
          console.log(`${prefs.length} user preference(s):\n`);
          for (const p of prefs) {
            console.log(`  ${p.title} (${p.key})`);
            console.log(`    ${p.value.split("\n")[0]}`);
            console.log();
          }
        });
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

prefCmd
  .command("delete <key>")
  .description("Delete a user preference.")
  .action(async (key: string) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      const deleted = deletePreference(centralDb, key);
      if (!deleted) {
        console.log(`No preference found for key "${key}".`);
        return;
      }
      console.log(`Preference "${key}" deleted.`);
      console.log(`Run 'gnosys sync' to update agent rules files.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys sync ─────────────────────────────────────────────────────────
program
  .command("sync")
  .description("Regenerate agent rules files from user preferences and project conventions. Injects GNOSYS:START/GNOSYS:END block.")
  .option("-d, --directory <dir>", "Project directory (default: cwd)")
  .option("-t, --target <target>", "Target: claude, cursor, codex, all, or global (default: auto-detect)")
  .option("--global", "Sync to global ~/.claude/CLAUDE.md")
  .action(async (opts: { directory?: string; target?: string; global?: boolean }) => {
    const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();
    const target = opts.global ? "global" : (opts.target || null);

    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      // For --global, we don't need project identity
      if (target === "global") {
        const results = await syncToTarget(centralDb, projectDir, "global", null);
        for (const result of results) {
          const action = result.created ? "Created" : "Updated";
          console.log(`${action} global rules: ${result.filePath}`);
          console.log(`  Preferences injected: ${result.prefCount}`);
        }
        console.log(`\nContent is inside <!-- GNOSYS:START --> / <!-- GNOSYS:END --> markers.`);
        console.log(`User content outside these markers is preserved.`);
        return;
      }

      // Read project identity
      const identity = await readProjectIdentity(projectDir);
      if (!identity) {
        console.error("No project identity found. Run 'gnosys init' first.");
        process.exit(1);
      }

      // Use explicit target, or fall back to auto-detected, or "all"
      const resolvedTarget = target || identity.agentRulesTarget || "all";

      const results = await syncToTarget(
        centralDb,
        projectDir,
        resolvedTarget,
        identity.projectId
      );

      if (results.length === 0) {
        console.error("No targets found. Create a CLAUDE.md, .cursor/, or .codex/ directory first.");
        process.exit(1);
      }

      for (const result of results) {
        const action = result.created ? "Created" : "Updated";
        console.log(`${action} rules file: ${result.filePath}`);
        console.log(`  Preferences injected: ${result.prefCount}`);
        console.log(`  Project conventions:  ${result.conventionCount}`);
      }
      console.log(`\nContent is inside <!-- GNOSYS:START --> / <!-- GNOSYS:END --> markers.`);
      console.log(`User content outside these markers is preserved.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys fsearch (federated search) ───────────────────────────────────
program
  .command("fsearch <query>")
  .description("Federated search across all scopes with tier boosting (project > user > global)")
  .option("-l, --limit <n>", "Max results", "20")
  .option("-d, --directory <dir>", "Project directory for context")
  .option("--no-global", "Exclude global-scope memories")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated)")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: { limit: string; directory?: string; global: boolean; scope?: string; json: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const { federatedSearch, detectCurrentProject } = await import("./lib/federated.js");
      const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
      const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
      const results = federatedSearch(centralDb, query, {
        limit: parseInt(opts.limit, 10),
        projectId,
        includeGlobal: opts.global,
        scopeFilter,
      });

      if (opts.json) {
        console.log(JSON.stringify({ query, projectId, count: results.length, results }, null, 2));
      } else {
        if (results.length === 0) { console.log(`No results for "${query}".`); return; }
        const ctx = projectId ? `Context: project ${projectId}` : "No project detected";
        console.log(ctx);
        for (const [i, r] of results.entries()) {
          const proj = r.projectName ? ` [${r.projectName}]` : "";
          console.log(`\n${i + 1}. ${r.title} (${r.category})${proj}`);
          console.log(`   scope: ${r.scope} | score: ${r.score.toFixed(4)} | boosts: ${r.boosts.join(", ")}`);
          if (r.snippet) console.log(`   ${r.snippet.substring(0, 120)}`);
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys ambiguity ────────────────────────────────────────────────────
program
  .command("ambiguity <query>")
  .description("Check if a query matches memories in multiple projects")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: { json: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const { detectAmbiguity } = await import("./lib/federated.js");
      const ambiguity = detectAmbiguity(centralDb, query);

      if (opts.json) {
        console.log(JSON.stringify({ query, ambiguous: !!ambiguity, ...(ambiguity || {}) }, null, 2));
      } else if (!ambiguity) {
        console.log(`No ambiguity for "${query}" — matches at most one project.`);
      } else {
        console.log(ambiguity.message);
        for (const c of ambiguity.candidates) {
          console.log(`\n  ${c.projectName} (${c.projectId})`);
          console.log(`    Dir: ${c.workingDirectory}`);
          console.log(`    Matching memories: ${c.memoryCount}`);
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys briefing ─────────────────────────────────────────────────────
program
  .command("briefing")
  .description("Generate project briefing — memory state summary, categories, recent activity, top tags")
  .option("-p, --project <id>", "Project ID (auto-detects if omitted)")
  .option("-a, --all", "Generate briefings for all projects")
  .option("-d, --directory <dir>", "Project directory for auto-detection")
  .option("--json", "Output as JSON")
  .action(async (opts: { project?: string; all?: boolean; directory?: string; json: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const { generateBriefing, generateAllBriefings, detectCurrentProject } = await import("./lib/federated.js");

      if (opts.all) {
        const briefings = generateAllBriefings(centralDb);
        if (opts.json) {
          console.log(JSON.stringify({ count: briefings.length, briefings }, null, 2));
        } else {
          if (briefings.length === 0) { console.log("No projects registered."); return; }
          for (const b of briefings) {
            console.log(`\n## ${b.projectName}`);
            console.log(b.summary);
          }
        }
        return;
      }

      let pid = opts.project || null;
      if (!pid) pid = await detectCurrentProject(centralDb, opts.directory || undefined);
      if (!pid) { console.error("No project specified and none detected."); process.exit(1); }

      const briefing = generateBriefing(centralDb, pid);
      if (!briefing) { console.error(`Project not found: ${pid}`); process.exit(1); }

      if (opts.json) {
        console.log(JSON.stringify(briefing, null, 2));
      } else {
        console.log(`# Briefing: ${briefing.projectName}`);
        console.log(`Directory: ${briefing.workingDirectory}`);
        console.log(`Active memories: ${briefing.activeMemories} / ${briefing.totalMemories}`);
        console.log(`\nCategories:`);
        for (const [cat, count] of Object.entries(briefing.categories).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${cat}: ${count}`);
        }
        console.log(`\nRecent activity (7d):`);
        if (briefing.recentActivity.length === 0) { console.log("  None"); }
        for (const r of briefing.recentActivity) {
          console.log(`  - ${r.title} (${r.modified})`);
        }
        console.log(`\nTop tags: ${briefing.topTags.slice(0, 10).map((t) => `${t.tag}(${t.count})`).join(", ") || "None"}`);
        console.log(`\n${briefing.summary}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys working-set ──────────────────────────────────────────────────
program
  .command("working-set")
  .description("Show the implicit working set — recently modified memories for the current project")
  .option("-d, --directory <dir>", "Project directory")
  .option("-w, --window <hours>", "Lookback window in hours", "24")
  .option("--json", "Output as JSON")
  .action(async (opts: { directory?: string; window: string; json: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const { getWorkingSet, formatWorkingSet, detectCurrentProject } = await import("./lib/federated.js");
      const pid = await detectCurrentProject(centralDb, opts.directory || undefined);
      if (!pid) { console.error("No project detected."); process.exit(1); }

      const windowHours = parseInt(opts.window, 10);
      const workingSet = getWorkingSet(centralDb, pid, { windowHours });

      if (opts.json) {
        console.log(JSON.stringify({
          projectId: pid,
          windowHours,
          count: workingSet.length,
          memories: workingSet.map((m) => ({ id: m.id, title: m.title, category: m.category, modified: m.modified })),
        }, null, 2));
      } else {
        console.log(formatWorkingSet(workingSet));
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys sandbox start|stop|status ─────────────────────────────────────

const sandboxCmd = program
  .command("sandbox")
  .description("Manage the Gnosys sandbox background process");

sandboxCmd
  .command("start")
  .description("Start the Gnosys sandbox background process")
  .option("--persistent", "Keep running across reboots (future use)")
  .option("--db-path <path>", "Custom database directory")
  .option("--json", "Output as JSON")
  .action(async (opts: { persistent?: boolean; dbPath?: string; json?: boolean }) => {
    try {
      const { startSandbox } = await import("./sandbox/manager.js");
      const pid = await startSandbox({
        persistent: opts.persistent,
        dbPath: opts.dbPath,
        wait: true,
      });
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, pid }));
      } else {
        console.log(`Gnosys sandbox running (pid: ${pid})`);
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Failed to start sandbox: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

sandboxCmd
  .command("stop")
  .description("Stop the Gnosys sandbox background process")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    try {
      const { stopSandbox } = await import("./sandbox/manager.js");
      const wasRunning = await stopSandbox();
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, wasRunning }));
      } else {
        console.log(wasRunning ? "Sandbox stopped." : "Sandbox was not running.");
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Failed to stop sandbox: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

sandboxCmd
  .command("status")
  .description("Check if the Gnosys sandbox is running")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    try {
      const { sandboxStatus } = await import("./sandbox/manager.js");
      const status = await sandboxStatus();
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
      } else if (status.running) {
        console.log(`Sandbox running (pid: ${status.pid}, socket: ${status.socketPath})`);
      } else {
        console.log("Sandbox is not running. Start with: gnosys sandbox start");
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// ─── gnosys helper generate ───────────────────────────────────────────────

const helperCmd = program
  .command("helper")
  .description("Manage the Gnosys helper library for agent integration");

helperCmd
  .command("generate")
  .description("Generate a gnosys-helper.ts file in the current directory (or specified directory)")
  .option("-d, --directory <dir>", "Target directory (default: cwd)")
  .option("--json", "Output as JSON")
  .action(async (opts: { directory?: string; json?: boolean }) => {
    try {
      const { generateHelper } = await import("./sandbox/helper-template.js");
      const targetDir = opts.directory || process.cwd();
      const outputPath = await generateHelper(targetDir);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, path: outputPath }));
      } else {
        console.log(`Generated: ${outputPath}`);
        console.log();
        console.log("Usage in your agent/script:");
        console.log('  import { gnosys } from "./gnosys-helper";');
        console.log('  await gnosys.add("We use conventional commits");');
        console.log('  const ctx = await gnosys.recall("auth decisions");');
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Failed to generate helper: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

// ─── Phase 10: gnosys trace ─────────────────────────────────────────────

program
  .command("trace <directory>")
  .description("Trace a codebase and store procedural 'how' memories with call-chain relationships")
  .option("--max-files <n>", "Maximum number of source files to scan", "500")
  .option("--project-id <id>", "Project ID to associate memories with")
  .option("--json", "Output as JSON")
  .action(async (directory: string, opts: { maxFiles?: string; projectId?: string; json?: boolean }) => {
    try {
      const { traceCodebase } = await import("./lib/trace.js");
      const { GnosysDB } = await import("./lib/db.js");

      const dbDir = GnosysDB.getCentralDbDir();
      const db = new GnosysDB(dbDir);

      if (!db.isAvailable()) {
        console.error("Error: GnosysDB not available. Is better-sqlite3 installed?");
        process.exit(1);
      }

      const result = traceCodebase(db, directory, {
        projectId: opts.projectId,
        maxFiles: opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined,
      });

      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Trace complete:`);
        console.log(`  Files scanned:        ${result.filesScanned}`);
        console.log(`  Functions found:       ${result.functionsFound}`);
        console.log(`  Memories created:      ${result.memoriesCreated}`);
        console.log(`  Relationships created: ${result.relationshipsCreated}`);
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Trace failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

// ─── Phase 10: gnosys reflect ───────────────────────────────────────────

program
  .command("reflect <outcome>")
  .description("Reflect on an outcome to update memory confidence and create relationships")
  .option("--memory-ids <ids>", "Comma-separated list of memory IDs to relate to")
  .option("--failure", "Mark this as a failure (default: success)")
  .option("--notes <text>", "Additional notes about the outcome")
  .option("--confidence-delta <n>", "Custom confidence delta (e.g. 0.1 or -0.2)")
  .option("--json", "Output as JSON")
  .action(async (outcome: string, opts: { memoryIds?: string; failure?: boolean; notes?: string; confidenceDelta?: string; json?: boolean }) => {
    try {
      const { GnosysDB } = await import("./lib/db.js");
      const { handleRequest } = await import("./sandbox/server.js");

      const dbDir = GnosysDB.getCentralDbDir();
      const db = new GnosysDB(dbDir);

      if (!db.isAvailable()) {
        console.error("Error: GnosysDB not available. Is better-sqlite3 installed?");
        process.exit(1);
      }

      const params: Record<string, any> = {
        outcome,
        success: !opts.failure,
      };
      if (opts.memoryIds) params.memory_ids = opts.memoryIds.split(",").map((s) => s.trim());
      if (opts.notes) params.notes = opts.notes;
      if (opts.confidenceDelta) params.confidence_delta = parseFloat(opts.confidenceDelta);

      const res = handleRequest(db, {
        id: "cli-reflect",
        method: "reflect",
        params,
      });

      db.close();

      if (!res.ok) {
        console.error(`Reflect failed: ${res.error}`);
        process.exit(1);
      }

      const result = res.result as any;
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Reflection recorded:`);
        console.log(`  ID:                    ${result.reflection_id}`);
        console.log(`  Outcome:               ${result.outcome}`);
        console.log(`  Memories updated:      ${result.memories_updated.length}`);
        console.log(`  Relationships created: ${result.relationships_created}`);
        console.log(`  Confidence delta:      ${result.confidence_delta > 0 ? "+" : ""}${result.confidence_delta.toFixed(2)}`);
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Reflect failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

// ─── Phase 10: gnosys traverse ──────────────────────────────────────────

program
  .command("traverse <memoryId>")
  .description("Traverse relationship chains starting from a memory (BFS, depth-limited)")
  .option("-d, --depth <n>", "Maximum traversal depth (default: 3, max: 10)", "3")
  .option("--rel-types <types>", "Comma-separated relationship types to follow (e.g. leads_to,requires)")
  .option("--json", "Output as JSON")
  .action(async (memoryId: string, opts: { depth?: string; relTypes?: string; json?: boolean }) => {
    try {
      const { GnosysDB } = await import("./lib/db.js");
      const { handleRequest } = await import("./sandbox/server.js");

      const dbDir = GnosysDB.getCentralDbDir();
      const db = new GnosysDB(dbDir);

      if (!db.isAvailable()) {
        console.error("Error: GnosysDB not available. Is better-sqlite3 installed?");
        process.exit(1);
      }

      const params: Record<string, any> = {
        id: memoryId,
        depth: opts.depth ? parseInt(opts.depth, 10) : 3,
      };
      if (opts.relTypes) params.rel_types = opts.relTypes.split(",").map((s) => s.trim());

      const res = handleRequest(db, {
        id: "cli-traverse",
        method: "traverse",
        params,
      });

      db.close();

      if (!res.ok) {
        console.error(`Traverse failed: ${res.error}`);
        process.exit(1);
      }

      const result = res.result as any;
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Traversal from ${memoryId} (depth: ${result.depth}):`);
        console.log(`  Total nodes: ${result.total}\n`);
        for (const node of result.nodes) {
          const indent = "  ".repeat(node.depth + 1);
          const via = node.via_rel ? ` ← [${node.via_rel}] from ${node.via_from}` : " (root)";
          console.log(`${indent}${node.id}: ${node.title} (conf: ${node.confidence.toFixed(2)})${via}`);
        }
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Traverse failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

// ─── gnosys web init|ingest|build-index|build|add|remove|update|status ──

async function getWebStorePath(): Promise<string> {
  const resolver = await getResolver();
  const stores = resolver.getStores();
  return stores.length > 0 ? stores[0].path : path.join(process.cwd(), ".gnosys");
}

const webCmd = program
  .command("web")
  .description("Web Knowledge Base — generate searchable knowledge from websites");

webCmd
  .command("init")
  .description("Interactive setup for web knowledge base")
  .option("--source <type>", "Source type: sitemap, directory, urls", "sitemap")
  .option("--output <dir>", "Output directory for knowledge files", "./knowledge")
  .option("--no-config", "Skip gnosys.json modification")
  .option("--non-interactive", "Skip prompts, use defaults")
  .option("--json", "Output as JSON")
  .action(async (opts: { source: string; output: string; config: boolean; nonInteractive?: boolean; json?: boolean }) => {
    try {
      const { mkdirSync } = await import("fs");
      const { loadConfig, updateConfig, resolveTaskModel } = await import("./lib/config.js");
      const { createInterface } = await import("readline/promises");
      const storePath = await getWebStorePath();

      const DIM = "\x1b[2m";
      const BOLD = "\x1b[1m";
      const CYAN = "\x1b[36m";
      const GREEN = "\x1b[32m";
      const RESET = "\x1b[0m";
      const CHECK = `${GREEN}\u2713${RESET}`;

      let sitemapUrl = "";
      let outputDir = opts.output;
      let llmEnrich = true;
      let envVarName = "ANTHROPIC_API_KEY";

      // Detect current agent config for provider info
      let agentProvider = "anthropic";
      let agentModel = "";
      try {
        const cfg = await loadConfig(storePath);
        agentProvider = cfg.llm.defaultProvider;
        const taskModel = resolveTaskModel(cfg, "structuring");
        agentModel = taskModel.model;
      } catch { /* no config yet */ }

      // Map provider to env var name
      const providerEnvVars: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        groq: "GROQ_API_KEY",
        xai: "XAI_API_KEY",
        mistral: "MISTRAL_API_KEY",
        ollama: "",
        lmstudio: "",
        custom: "GNOSYS_LLM_API_KEY",
      };

      if (!opts.nonInteractive && !opts.json && process.stdout.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });

        try {
          console.log();
          console.log(`${BOLD}Web Knowledge Base Setup${RESET}`);
          console.log();
          console.log(`${DIM}This sets up a /knowledge/ directory in your project.`);
          console.log(`Gnosys crawls your site, converts pages to markdown, and`);
          console.log(`builds a search index. Everything deploys with your app.`);
          console.log();
          console.log(`No API keys are stored in your project. The LLM key is`);
          console.log(`read from an environment variable at build time.${RESET}`);
          console.log();

          // Step 1: Sitemap URL
          console.log(`${BOLD}Step 1/3${RESET} ${DIM}\u2014${RESET} Content source`);
          console.log();
          console.log(`${DIM}  \u2022 Deployed site:  https://yoursite.com/sitemap.xml`);
          console.log(`  \u2022 Local dev:      http://localhost:3000/sitemap.xml`);
          console.log(`  \u2022 Not ready yet:  press Enter (add later in gnosys.json)${RESET}`);
          console.log();
          const urlAnswer = await rl.question("Sitemap URL: ");
          sitemapUrl = urlAnswer.trim();
          console.log();

          // Step 2: LLM enrichment
          console.log(`${BOLD}Step 2/3${RESET} ${DIM}\u2014${RESET} LLM enrichment`);
          console.log();
          console.log(`${DIM}LLM enrichment generates better tags, keyword clouds, and`);
          console.log(`frontmatter for each page. Without it, Gnosys uses TF-IDF`);
          console.log(`keyword extraction (free, no API key needed, decent quality).${RESET}`);
          console.log();

          if (agentModel && providerEnvVars[agentProvider]) {
            console.log(`${DIM}Your agent setup uses ${agentProvider}/${agentModel} for structuring.${RESET}`);
          }
          console.log();

          const enrichAnswer = await rl.question("Enable LLM enrichment? [Y/n] ");
          llmEnrich = !enrichAnswer.trim().toLowerCase().startsWith("n");
          console.log();

          // Step 3: CI/CD env var
          if (llmEnrich) {
            console.log(`${BOLD}Step 3/3${RESET} ${DIM}\u2014${RESET} CI/CD environment variable`);
            console.log();
            console.log(`${DIM}In CI/CD (GitHub Actions, Vercel, Netlify), the LLM API key`);
            console.log(`is read from an environment variable. No keys are stored in`);
            console.log(`your project or committed to git.${RESET}`);
            console.log();

            const defaultEnv = providerEnvVars[agentProvider] || "ANTHROPIC_API_KEY";
            const envAnswer = await rl.question(`Env var name for API key (${defaultEnv}): `);
            envVarName = envAnswer.trim() || defaultEnv;
          } else {
            console.log(`${DIM}Step 3/3 \u2014 Skipped (no LLM = no API key needed)${RESET}`);
            envVarName = "";
          }
          console.log();

          // Output dir
          const dirAnswer = await rl.question(`Output directory (${opts.output}): `);
          outputDir = dirAnswer.trim() || opts.output;

          rl.close();
        } catch {
          rl.close();
        }
      }

      // Create output directory
      mkdirSync(outputDir, { recursive: true });

      // Update gnosys.json with web config
      if (opts.config) {
        try {
          const config = await loadConfig(storePath);
          if (!config.web) {
            await updateConfig(storePath, {
              web: {
                source: opts.source as "sitemap" | "directory" | "urls",
                ...(sitemapUrl ? { sitemapUrl } : {}),
                outputDir,
                exclude: ["/api", "/admin", "/_next"],
                categories: {
                  "/blog/*": "blog",
                  "/services/*": "services",
                  "/products/*": "products",
                  "/about*": "company",
                },
                llmEnrich,
                prune: false,
              },
            });
          }
        } catch {
          // No gnosys.json yet — run gnosys init first
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, outputDir, source: opts.source, sitemapUrl: sitemapUrl || null, llmEnrich, envVarName: envVarName || null }));
      } else {
        console.log(`${CHECK} Created ${outputDir}/`);
        console.log(`${CHECK} Updated gnosys.json with web config`);
        if (sitemapUrl) {
          console.log(`${CHECK} Sitemap: ${sitemapUrl}`);
        }
        console.log(`${CHECK} LLM enrichment: ${llmEnrich ? "enabled" : "disabled (TF-IDF mode)"}`);
        if (envVarName) {
          console.log(`${CHECK} CI/CD env var: ${envVarName}`);
        }
        console.log();
        console.log(`${BOLD}Next steps:${RESET}`);
        if (!sitemapUrl) {
          console.log(`  1. Add your sitemap URL to gnosys.json → web.sitemapUrl`);
        }
        if (envVarName) {
          console.log(`  ${sitemapUrl ? "1" : "2"}. Set ${CYAN}${envVarName}${RESET} in your hosting provider (Vercel, Netlify, GitHub Actions)`);
          console.log(`     ${DIM}Never commit API keys to your repo${RESET}`);
        }
        console.log(`  ${!sitemapUrl && envVarName ? "3" : envVarName || !sitemapUrl ? "2" : "1"}. Run: ${CYAN}gnosys web build${RESET}`);
        console.log(`  ${!sitemapUrl && envVarName ? "4" : envVarName || !sitemapUrl ? "3" : "2"}. Add to package.json: ${CYAN}"postbuild": "npx gnosys web build"${RESET}`);
        console.log();
        console.log(`${DIM}Every deploy will re-crawl and rebuild the search index automatically.${RESET}`);
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Web init failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

webCmd
  .command("ingest")
  .description("Crawl the configured source and generate knowledge markdown files")
  .option("--source <url>", "Override sitemap URL or content directory")
  .option("--prune", "Remove orphaned knowledge files")
  .option("--no-llm", "Force structured mode (no LLM)")
  .option("--concurrency <n>", "Parallel processing limit", "3")
  .option("--dry-run", "Show what would change without writing files")
  .option("--verbose", "Print per-page details")
  .option("--json", "Output results as JSON")
  .action(async (opts: { source?: string; prune?: boolean; llm: boolean; concurrency: string; dryRun?: boolean; verbose?: boolean; json?: boolean }) => {
    try {
      const { loadConfig } = await import("./lib/config.js");
      const { ingestSite } = await import("./lib/webIngest.js");

      const gnosysConfig = await loadConfig(await getWebStorePath());
      const webConfig = gnosysConfig.web;
      if (!webConfig) {
        throw new Error("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
      }

      const result = await ingestSite({
        source: webConfig.source,
        sitemapUrl: opts.source || webConfig.sitemapUrl,
        contentDir: opts.source || webConfig.contentDir,
        urls: webConfig.urls,
        outputDir: webConfig.outputDir,
        exclude: webConfig.exclude,
        categories: webConfig.categories,
        llmEnrich: opts.llm ? webConfig.llmEnrich : false,
        prune: opts.prune || webConfig.prune,
        concurrency: parseInt(opts.concurrency) || webConfig.concurrency,
        crawlDelayMs: webConfig.crawlDelayMs,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      }, gnosysConfig);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Ingestion complete (${result.duration}ms):`);
        console.log(`  Added:     ${result.added.length}`);
        console.log(`  Updated:   ${result.updated.length}`);
        console.log(`  Unchanged: ${result.unchanged.length}`);
        console.log(`  Removed:   ${result.removed.length}`);
        if (result.errors.length > 0) {
          console.log(`  Errors:    ${result.errors.length}`);
          for (const e of result.errors) {
            console.log(`    ${e.url}: ${e.error}`);
          }
        }
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Ingest failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

webCmd
  .command("build-index")
  .description("Generate search index JSON from the knowledge directory")
  .option("--input <dir>", "Override knowledge directory")
  .option("--output <path>", "Override output file path")
  .option("--no-stop-words", "Disable stop-word filtering")
  .option("--json", "Output index stats as JSON")
  .action(async (opts: { input?: string; output?: string; stopWords: boolean; json?: boolean }) => {
    try {
      const { loadConfig } = await import("./lib/config.js");
      const { buildIndex, writeIndex } = await import("./lib/webIndex.js");

      const gnosysConfig = await loadConfig(await getWebStorePath());
      const knowledgeDir = opts.input || gnosysConfig.web?.outputDir || "./knowledge";
      const outputPath = opts.output || path.join(knowledgeDir, "gnosys-index.json");

      const index = await buildIndex(knowledgeDir, {
        stopWords: opts.stopWords,
      });

      await writeIndex(index, outputPath);

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          documentCount: index.documentCount,
          tokenCount: Object.keys(index.invertedIndex).length,
          outputPath,
        }));
      } else {
        console.log(`Search index built:`);
        console.log(`  Documents: ${index.documentCount}`);
        console.log(`  Tokens:    ${Object.keys(index.invertedIndex).length}`);
        console.log(`  Output:    ${outputPath}`);
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Build index failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

webCmd
  .command("build")
  .description("Run ingest + build-index in one shot")
  .option("--source <url>", "Override sitemap URL or content directory")
  .option("--prune", "Remove orphaned knowledge files")
  .option("--no-llm", "Force structured mode (no LLM)")
  .option("--concurrency <n>", "Parallel processing limit", "3")
  .option("--dry-run", "Show what would change without writing files")
  .option("--json", "Output results as JSON")
  .action(async (opts: { source?: string; prune?: boolean; llm: boolean; concurrency: string; dryRun?: boolean; json?: boolean }) => {
    try {
      const { loadConfig } = await import("./lib/config.js");
      const { ingestSite } = await import("./lib/webIngest.js");
      const { buildIndex, writeIndex } = await import("./lib/webIndex.js");

      const gnosysConfig = await loadConfig(await getWebStorePath());
      const webConfig = gnosysConfig.web;
      if (!webConfig) {
        throw new Error("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
      }

      // Step 1: Ingest
      const ingestResult = await ingestSite({
        source: webConfig.source,
        sitemapUrl: opts.source || webConfig.sitemapUrl,
        contentDir: opts.source || webConfig.contentDir,
        urls: webConfig.urls,
        outputDir: webConfig.outputDir,
        exclude: webConfig.exclude,
        categories: webConfig.categories,
        llmEnrich: opts.llm ? webConfig.llmEnrich : false,
        prune: opts.prune || webConfig.prune,
        concurrency: parseInt(opts.concurrency) || webConfig.concurrency,
        crawlDelayMs: webConfig.crawlDelayMs,
        dryRun: opts.dryRun,
      }, gnosysConfig);

      // Step 2: Build index (skip if dry run)
      let indexStats = { documentCount: 0, tokenCount: 0 };
      if (!opts.dryRun) {
        const index = await buildIndex(webConfig.outputDir);
        const indexPath = path.join(webConfig.outputDir, "gnosys-index.json");
        await writeIndex(index, indexPath);
        indexStats = {
          documentCount: index.documentCount,
          tokenCount: Object.keys(index.invertedIndex).length,
        };
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...ingestResult, index: indexStats }));
      } else {
        console.log(`Web build complete (${ingestResult.duration}ms):`);
        console.log(`  Added:     ${ingestResult.added.length}`);
        console.log(`  Updated:   ${ingestResult.updated.length}`);
        console.log(`  Unchanged: ${ingestResult.unchanged.length}`);
        console.log(`  Removed:   ${ingestResult.removed.length}`);
        console.log(`  Index:     ${indexStats.documentCount} docs, ${indexStats.tokenCount} tokens`);
        if (ingestResult.errors.length > 0) {
          console.log(`  Errors:    ${ingestResult.errors.length}`);
          for (const e of ingestResult.errors) {
            console.log(`    ${e.url}: ${e.error}`);
          }
        }
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Web build failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

webCmd
  .command("add <url>")
  .description("Ingest a single URL into the knowledge base")
  .option("--category <name>", "Override category inference")
  .option("--no-llm", "Force structured mode")
  .option("--no-reindex", "Skip index rebuild")
  .option("--json", "Output as JSON")
  .action(async (url: string, opts: { category?: string; llm: boolean; reindex: boolean; json?: boolean }) => {
    try {
      const { loadConfig } = await import("./lib/config.js");
      const { ingestUrl } = await import("./lib/webIngest.js");
      const { buildIndex, writeIndex } = await import("./lib/webIndex.js");

      const gnosysConfig = await loadConfig(await getWebStorePath());
      const webConfig = gnosysConfig.web;
      if (!webConfig) {
        throw new Error("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
      }

      const categories = opts.category
        ? { ...webConfig.categories, "/*": opts.category }
        : webConfig.categories;

      const result = await ingestUrl(url, {
        source: "urls",
        outputDir: webConfig.outputDir,
        categories,
        llmEnrich: opts.llm ? webConfig.llmEnrich : false,
        concurrency: 1,
        crawlDelayMs: 0,
      }, gnosysConfig);

      // Rebuild index unless --no-reindex
      if (opts.reindex && result.added.length + result.updated.length > 0) {
        const index = await buildIndex(webConfig.outputDir);
        await writeIndex(index, path.join(webConfig.outputDir, "gnosys-index.json"));
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.added.length > 0) {
          console.log(`Added: ${result.added[0]}`);
        } else if (result.updated.length > 0) {
          console.log(`Updated: ${result.updated[0]}`);
        } else if (result.unchanged.length > 0) {
          console.log(`Unchanged (content identical)`);
        }
        if (result.errors.length > 0) {
          console.error(`Error: ${result.errors[0].error}`);
        }
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Web add failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

webCmd
  .command("remove <filepath>")
  .description("Remove a knowledge file and rebuild the index")
  .option("--json", "Output as JSON")
  .action(async (filepath: string, opts: { json?: boolean }) => {
    try {
      const { loadConfig } = await import("./lib/config.js");
      const { buildIndex, writeIndex } = await import("./lib/webIndex.js");
      const fsp = await import("fs/promises");

      const gnosysConfig = await loadConfig(await getWebStorePath());
      const webConfig = gnosysConfig.web;
      const knowledgeDir = webConfig?.outputDir || "./knowledge";
      const fullPath = path.resolve(knowledgeDir, filepath);

      if (!existsSync(fullPath)) {
        throw new Error(`File not found: ${fullPath}`);
      }

      await fsp.unlink(fullPath);

      // Rebuild index
      const index = await buildIndex(knowledgeDir);
      await writeIndex(index, path.join(knowledgeDir, "gnosys-index.json"));

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, removed: filepath, documentCount: index.documentCount }));
      } else {
        console.log(`Removed: ${filepath}`);
        console.log(`Index rebuilt: ${index.documentCount} documents`);
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Web remove failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

webCmd
  .command("update <urlOrPath>")
  .description("Re-ingest a URL or refresh a knowledge file, then rebuild the index")
  .option("--no-llm", "Force structured mode (no LLM)")
  .option("--category <name>", "Override category inference")
  .option("--json", "Output as JSON")
  .action(async (urlOrPath: string, opts: { llm: boolean; category?: string; json?: boolean }) => {
    try {
      const { loadConfig } = await import("./lib/config.js");
      const { ingestUrl } = await import("./lib/webIngest.js");
      const { buildIndex, writeIndex } = await import("./lib/webIndex.js");

      const gnosysConfig = await loadConfig(await getWebStorePath());
      const webConfig = gnosysConfig.web;
      if (!webConfig) {
        throw new Error("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
      }

      const knowledgeDir = webConfig.outputDir || "./knowledge";
      const isUrl = urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://");

      if (isUrl) {
        // Re-ingest the URL
        const categories = opts.category
          ? { "/*": opts.category }
          : webConfig.categories;

        const result = await ingestUrl(urlOrPath, {
          source: "urls",
          outputDir: knowledgeDir,
          categories,
          llmEnrich: opts.llm ? webConfig.llmEnrich : false,
          prune: false,
          concurrency: 1,
          crawlDelayMs: 0,
        }, gnosysConfig);

        // Rebuild index
        const index = await buildIndex(knowledgeDir);
        await writeIndex(index, path.join(knowledgeDir, "gnosys-index.json"));

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, ...result, documentCount: index.documentCount }));
        } else {
          console.log(`Updated: ${urlOrPath}`);
          console.log(`  Added: ${result.added.length}, Updated: ${result.updated.length}`);
          console.log(`Index rebuilt: ${index.documentCount} documents`);
        }
      } else {
        // Refresh a local knowledge file — rebuild index
        const fullPath = path.resolve(knowledgeDir, urlOrPath);
        if (!existsSync(fullPath)) {
          throw new Error(`File not found: ${fullPath}`);
        }

        const index = await buildIndex(knowledgeDir);
        await writeIndex(index, path.join(knowledgeDir, "gnosys-index.json"));

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, refreshed: urlOrPath, documentCount: index.documentCount }));
        } else {
          console.log(`Refreshed: ${urlOrPath}`);
          console.log(`Index rebuilt: ${index.documentCount} documents`);
        }
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Web update failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

webCmd
  .command("status")
  .description("Show the current state of the web knowledge base")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    try {
      const { loadConfig } = await import("./lib/config.js");
      const { readdirSync, statSync } = await import("fs");

      const gnosysConfig = await loadConfig(await getWebStorePath());
      const webConfig = gnosysConfig.web;
      const knowledgeDir = webConfig?.outputDir || "./knowledge";
      const resolvedDir = path.resolve(knowledgeDir);

      if (!existsSync(resolvedDir)) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, exists: false, message: "Knowledge directory not found" }));
        } else {
          console.log(`Knowledge directory not found: ${resolvedDir}`);
          console.log(`Run 'gnosys web init' to get started.`);
        }
        return;
      }

      // Count files by category
      const categoryCounts: Record<string, number> = {};
      let totalFiles = 0;

      function countFiles(dir: string): void {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            countFiles(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(".md")) {
            const category = path.relative(resolvedDir, dir) || "root";
            categoryCounts[category] = (categoryCounts[category] || 0) + 1;
            totalFiles++;
          }
        }
      }
      countFiles(resolvedDir);

      // Check index file
      const indexPath = path.join(resolvedDir, "gnosys-index.json");
      let indexInfo: { exists: boolean; documentCount?: number; size?: number; generated?: string } = { exists: false };
      if (existsSync(indexPath)) {
        const stat = statSync(indexPath);
        try {
          const indexData = JSON.parse(readFileSync(indexPath, "utf-8"));
          indexInfo = {
            exists: true,
            documentCount: indexData.documentCount,
            size: stat.size,
            generated: indexData.generated,
          };
        } catch {
          indexInfo = { exists: true, size: stat.size };
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          knowledgeDir: resolvedDir,
          totalFiles,
          categoryCounts,
          index: indexInfo,
        }, null, 2));
      } else {
        console.log(`Web Knowledge Base Status:`);
        console.log(`  Directory: ${resolvedDir}`);
        console.log(`  Total files: ${totalFiles}`);
        if (Object.keys(categoryCounts).length > 0) {
          console.log(`  By category:`);
          for (const [cat, count] of Object.entries(categoryCounts).sort()) {
            console.log(`    ${cat}: ${count}`);
          }
        }
        if (indexInfo.exists) {
          console.log(`  Index: ${indexInfo.documentCount ?? "?"} docs, ${((indexInfo.size || 0) / 1024).toFixed(1)}KB`);
          if (indexInfo.generated) {
            console.log(`  Last built: ${indexInfo.generated}`);
          }
        } else {
          console.log(`  Index: not built (run 'gnosys web build-index')`);
        }
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Web status failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

program.parse();
