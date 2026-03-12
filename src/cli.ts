#!/usr/bin/env node
/**
 * Gnosys CLI — Thin wrapper around the core modules.
 * Uses the resolver for layered multi-store support.
 */

import { Command } from "commander";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { readFileSync } from "fs";
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
import { createProjectIdentity, readProjectIdentity, findProjectIdentity } from "./lib/projectIdentity.js";
import { setPreference, getPreference, getAllPreferences, deletePreference } from "./lib/preferences.js";
import { syncRules } from "./lib/rulesGen.js";

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
  .description("Gnosys — Agent-first persistent memory system (SQLite core + Dream Mode + Obsidian export)")
  .version(pkg.version);

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
  .description("Discover relevant memories by keyword. Searches relevance clouds, titles, and tags — returns metadata only, no content.")
  .option("-n, --limit <number>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: { limit: string; json?: boolean }) => {
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
  .description("Search memories by keyword across all stores")
  .option("-n, --limit <number>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: { limit: string; json?: boolean }) => {
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

      const tagRegistry = new GnosysTagRegistry(
        writeTarget.store.getStorePath()
      );
      await tagRegistry.load();
      const ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);

      if (!ingestion.isLLMAvailable) {
        console.error(
          "Error: No LLM provider available. Set ANTHROPIC_API_KEY or switch to Ollama: gnosys config set provider ollama"
        );
        process.exit(1);
      }

      console.log("Structuring memory via LLM...");
      const result = await ingestion.ingest(input);
      const id = await writeTarget.store.generateId(result.category);

      const today = new Date().toISOString().split("T")[0];
      const frontmatter = {
        id,
        title: result.title,
        category: result.category,
        tags: result.tags,
        relevance: result.relevance,
        author: opts.author as "human" | "ai" | "human+ai",
        authority: opts.authority as
          | "declared"
          | "observed"
          | "imported"
          | "inferred",
        confidence: result.confidence,
        created: today,
        modified: today,
        last_reviewed: today,
        status: "active" as const,
        supersedes: null,
      };

      const content = `# ${result.title}\n\n${result.content}`;
      const relPath = await writeTarget.store.writeMemory(
        result.category,
        `${result.filename}.md`,
        frontmatter,
        content
      );

      console.log(`\nMemory added to [${writeTarget.label}]: ${result.title}`);
      console.log(`Path: ${writeTarget.label}:${relPath}`);
      console.log(`Category: ${result.category}`);
      console.log(`Confidence: ${result.confidence}`);

      if (result.proposedNewTags && result.proposedNewTags.length > 0) {
        console.log("\nProposed new tags (not yet in registry):");
        for (const t of result.proposedNewTags) {
          console.log(`  ${t.category}:${t.tag}`);
        }
      }
    }
  );

// ─── gnosys init ─────────────────────────────────────────────────────────
program
  .command("init")
  .description("Initialize Gnosys in the current directory. Creates project identity, registers in central DB, and sets up store.")
  .option("-d, --directory <dir>", "Target directory (default: cwd)")
  .option("-n, --name <name>", "Project name (default: directory basename)")
  .action(async (opts: { directory?: string; name?: string }) => {
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

      const changelog = `# Gnosys Changelog\n\n## ${new Date().toISOString().split("T")[0]}\n\n- Store initialized\n`;
      await fs.writeFile(
        path.join(storePath, "CHANGELOG.md"),
        changelog,
        "utf-8"
      );

      try {
        const { execSync } = await import("child_process");
        execSync("git init", { cwd: storePath, stdio: "pipe" });
        try {
          execSync("git config user.name", { cwd: storePath, stdio: "pipe" });
        } catch {
          execSync('git config user.name "Gnosys"', { cwd: storePath, stdio: "pipe" });
          execSync('git config user.email "gnosys@local"', { cwd: storePath, stdio: "pipe" });
        }
        execSync("git add -A && git add -f .config/", { cwd: storePath, stdio: "pipe" });
        execSync('git commit -m "Initialize Gnosys store"', {
          cwd: storePath,
          stdio: "pipe",
        });
      } catch {
        // Git not available
      }
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
      console.log(`  CHANGELOG.md`);
      console.log(`  git repo`);
    }

    console.log(`\nStart adding memories with: gnosys add "your knowledge here"`);
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

      const updated = await sourceStore.store.updateMemory(
        memory.relativePath,
        updates,
        fullContent
      );

      if (!updated) {
        console.error(`Failed to update: ${memPath}`);
        process.exit(1);
      }

      // Supersession cross-linking
      if (opts.supersedes && updated.frontmatter.id) {
        const allMemories = await resolver.getAllMemories();
        const supersededMemory = allMemories.find(
          (m) => m.frontmatter.id === opts.supersedes
        );
        if (supersededMemory) {
          const supersededStore = resolver
            .getStores()
            .find((s) => s.label === supersededMemory.sourceLabel);
          if (supersededStore?.writable) {
            await supersededStore.store.updateMemory(
              supersededMemory.relativePath,
              { superseded_by: updated.frontmatter.id, status: "superseded" } as any
            );
            console.log(`Cross-linked: ${supersededMemory.frontmatter.title} marked as superseded.`);
          }
        }
      }

      const changedFields = Object.keys(updates);
      if (opts.content) changedFields.push("content");

      console.log(`Memory updated: ${updated.frontmatter.title}`);
      console.log(`Path: ${memory.sourceLabel}:${memory.relativePath}`);
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
        const allMemories = await resolver.getAllMemories();
        const memory = allMemories.find((m) => m.frontmatter.id === memoryId);
        if (memory) {
          const sourceStore = resolver
            .getStores()
            .find((s) => s.label === memory.sourceLabel);
          if (sourceStore?.writable) {
            await sourceStore.store.updateMemory(memory.relativePath, {
              modified: new Date().toISOString().split("T")[0],
            } as any);
          }
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
    }) => {
      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget(
        (opts.store as any) || undefined
      );
      if (!writeTarget) {
        console.error("No writable store found.");
        process.exit(1);
      }

      let tags: Record<string, string[]>;
      try {
        tags = JSON.parse(opts.tags);
      } catch {
        console.error("Invalid --tags JSON. Example: '{\"domain\":[\"auth\"],\"type\":[\"decision\"]}'");
        process.exit(1);
      }

      const id = await writeTarget.store.generateId(opts.category);
      const slug = opts.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .substring(0, 60);

      const today = new Date().toISOString().split("T")[0];
      const frontmatter = {
        id,
        title: opts.title,
        category: opts.category,
        tags,
        relevance: opts.relevance,
        author: opts.author as "human" | "ai" | "human+ai",
        authority: opts.authority as "declared" | "observed" | "imported" | "inferred",
        confidence: parseFloat(opts.confidence),
        created: today,
        modified: today,
        last_reviewed: today,
        status: "active" as const,
        supersedes: null,
      };

      const content = `# ${opts.title}\n\n${opts.content}`;
      const relPath = await writeTarget.store.writeMemory(
        opts.category,
        `${slug}.md`,
        frontmatter,
        content
      );

      console.log(`Memory added to [${writeTarget.label}]: ${opts.title}`);
      console.log(`Path: ${writeTarget.label}:${relPath}`);
    }
  );

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
      console.error("Error: No LLM provider available. Set ANTHROPIC_API_KEY or switch to Ollama: gnosys config set provider ollama");
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
          const id = await writeTarget.store.generateId(result.category);
          const today = new Date().toISOString().split("T")[0];

          const frontmatter = {
            id,
            title: result.title,
            category: result.category,
            tags: result.tags,
            relevance: result.relevance,
            author: "ai" as "human" | "ai" | "human+ai",
            authority: "observed" as "declared" | "observed" | "imported" | "inferred",
            confidence: result.confidence,
            created: today,
            modified: today,
            last_reviewed: today,
            status: "active" as const,
            supersedes: null,
          };

          const content = `# ${result.title}\n\n${result.content}`;
          const relPath = await writeTarget.store.writeMemory(
            result.category,
            `${result.filename}.md`,
            frontmatter,
            content
          );

          console.log(`  ➕ ADDED: "${result.title}"`);
          console.log(`    Path: ${writeTarget.label}:${relPath}`);
          added++;
        } catch (err) {
          console.error(`  ❌ FAILED: "${candidate.summary}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      console.log();
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
  .description("Search using hybrid keyword + semantic fusion (RRF)")
  .option("-l, --limit <n>", "Max results", "15")
  .option("-m, --mode <mode>", "Search mode: keyword | semantic | hybrid", "hybrid")
  .action(async (query: string, opts: { limit: string; mode: string }) => {
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
      console.log(`No results for "${query}". Try gnosys reindex to build embeddings.`);
    } else {
      console.log(`Found ${results.length} results for "${query}" (mode: ${mode}):\n`);
      for (const r of results) {
        console.log(`  ${r.title}`);
        console.log(`    Path: ${r.relativePath}`);
        console.log(`    Score: ${r.score.toFixed(4)} (via: ${r.sources.join("+")})`);
        console.log(`    ${r.snippet.substring(0, 120)}...\n`);
      }

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
    "Ask a natural-language question and get a synthesized answer with citations"
  )
  .option("-l, --limit <n>", "Max memories to retrieve", "15")
  .option("-m, --mode <mode>", "Search mode: keyword | semantic | hybrid", "hybrid")
  .option("--no-stream", "Disable streaming output")
  .action(async (question: string, opts: { limit: string; mode: string; stream: boolean }) => {
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

    const mode = opts.mode as "keyword" | "semantic" | "hybrid";
    const useStream = opts.stream !== false;

    try {
      const result = await ask.ask(question, {
        limit: parseInt(opts.limit),
        mode,
        stream: useStream,
        callbacks: useStream
          ? {
              onToken: (token) => process.stdout.write(token),
              onSearchComplete: (count, searchMode) => {
                console.log(`\n🔍 Found ${count} relevant memories (${searchMode} search)\n`);
              },
              onDeepQuery: (refined) => {
                console.log(`\n🔄 Deep query: searching for "${refined}"...\n`);
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

    // Check Anthropic
    const anthropicStatus = isProviderAvailable(cfg, "anthropic");
    if (anthropicStatus.available) {
      try {
        const provider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: "anthropic" } });
        await provider.testConnection();
        console.log(`  Anthropic: ✓ connected (${cfg.llm.anthropic.model})`);
      } catch (err) {
        console.log(`  Anthropic: ✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.log(`  Anthropic: — ${anthropicStatus.error}`);
    }

    // Check Ollama
    try {
      const ollamaProvider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: "ollama" } });
      await ollamaProvider.testConnection();
      console.log(`  Ollama: ✓ connected (${cfg.llm.ollama.model} at ${cfg.llm.ollama.baseUrl})`);
    } catch (err) {
      console.log(`  Ollama: ✗ ${err instanceof Error ? err.message : String(err)}`);
    }

    // Check Groq
    const groqStatus = isProviderAvailable(cfg, "groq");
    if (groqStatus.available) {
      try {
        const provider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: "groq" } });
        await provider.testConnection();
        console.log(`  Groq: ✓ connected (${cfg.llm.groq.model})`);
      } catch (err) {
        console.log(`  Groq: ✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.log(`  Groq: — ${groqStatus.error}`);
    }

    // Check OpenAI
    const openaiStatus = isProviderAvailable(cfg, "openai");
    if (openaiStatus.available) {
      try {
        const provider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: "openai" } });
        await provider.testConnection();
        console.log(`  OpenAI: ✓ connected (${cfg.llm.openai.model})`);
      } catch (err) {
        console.log(`  OpenAI: ✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.log(`  OpenAI: — ${openaiStatus.error}`);
    }

    // Check LM Studio
    try {
      const lmsProvider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: "lmstudio" } });
      await lmsProvider.testConnection();
      console.log(`  LM Studio: ✓ connected (${cfg.llm.lmstudio.model} at ${cfg.llm.lmstudio.baseUrl})`);
    } catch (err) {
      console.log(`  LM Studio: ✗ ${err instanceof Error ? err.message : String(err)}`);
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
  .description("Always-on memory recall — injects most relevant memories as context (sub-50ms, no LLM)")
  .option("--limit <n>", "Max memories to return (default from config)")
  .option("--aggressive", "Force aggressive mode (inject even medium-relevance memories)")
  .option("--no-aggressive", "Force filtered mode (hard cutoff at minRelevance)")
  .option("--trace-id <id>", "Trace ID for audit correlation")
  .option("--json", "Output raw JSON instead of formatted text")
  .option("--host", "Output in host-friendly <gnosys-recall> format (default for MCP)")
  .action(async (query: string, opts: { limit?: string; aggressive?: boolean; traceId?: string; json?: boolean; host?: boolean }) => {
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
  .description("Create a backup of the central Gnosys database")
  .option("-o, --output <dir>", "Backup output directory (default: ~/.gnosys/)")
  .action(async (opts: { output?: string }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      const backupPath = centralDb.backup(opts.output);
      console.log(`Backup created: ${backupPath}`);

      const counts = centralDb.getMemoryCount();
      console.log(`  Memories: ${counts.total} (${counts.active} active, ${counts.archived} archived)`);
      console.log(`  Projects: ${centralDb.getAllProjects().length}`);
    } catch (err) {
      console.error(`Backup failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys restore ─────────────────────────────────────────────────────
program
  .command("restore <backupFile>")
  .description("Restore the central Gnosys database from a backup")
  .action(async (backupFile: string) => {
    const resolved = path.resolve(backupFile);
    try {
      const db = GnosysDB.restore(resolved);
      const counts = db.getMemoryCount();
      console.log(`Database restored from ${resolved}`);
      console.log(`  Memories: ${counts.total} (${counts.active} active, ${counts.archived} archived)`);
      console.log(`  Projects: ${db.getAllProjects().length}`);
      db.close();
    } catch (err) {
      console.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// ─── gnosys migrate --to-central ────────────────────────────────────────
program
  .command("migrate")
  .description("Migrate data. Use --to-central to move per-project stores into the central DB.")
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
  .description("Regenerate agent rules file from user preferences and project conventions. Injects GNOSYS:START/GNOSYS:END block.")
  .option("-d, --directory <dir>", "Project directory (default: cwd)")
  .action(async (opts: { directory?: string }) => {
    const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();

    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      // Read project identity
      const identity = await readProjectIdentity(projectDir);
      if (!identity) {
        console.error("No project identity found. Run 'gnosys init' first.");
        process.exit(1);
      }

      if (!identity.agentRulesTarget) {
        console.error("No agent rules target detected (no .cursor/ or CLAUDE.md found).");
        console.error("Create one of these, then run 'gnosys init' to detect it.");
        process.exit(1);
      }

      const result = await syncRules(
        centralDb,
        projectDir,
        identity.agentRulesTarget,
        identity.projectId
      );

      if (!result) {
        console.error("Sync failed.");
        process.exit(1);
      }

      const action = result.created ? "Created" : "Updated";
      console.log(`${action} rules file: ${result.filePath}`);
      console.log(`  Preferences injected: ${result.prefCount}`);
      console.log(`  Project conventions:  ${result.conventionCount}`);
      console.log(`\nContent is inside <!-- GNOSYS:START --> / <!-- GNOSYS:END --> markers.`);
      console.log(`User content outside these markers is preserved.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

program.parse();
