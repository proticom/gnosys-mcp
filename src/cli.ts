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

// Load API keys from ~/.config/gnosys/.env (same as MCP server)
const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
dotenv.config({ path: path.join(home, ".config", "gnosys", ".env") });

// Also load .env from current directory as fallback
dotenv.config();

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

program
  .name("gnosys")
  .description("Gnosys — LLM-native persistent memory system")
  .version(pkg.version);

// ─── gnosys read <path> ──────────────────────────────────────────────────
program
  .command("read <memoryPath>")
  .description(
    "Read a specific memory. Supports layer prefix (e.g., project:decisions/auth.md)"
  )
  .action(async (memoryPath: string) => {
    const resolver = await getResolver();
    const memory = await resolver.readMemory(memoryPath);
    if (!memory) {
      console.error(`Memory not found: ${memoryPath}`);
      process.exit(1);
    }
    const raw = await fs.readFile(memory.filePath, "utf-8");
    console.log(`[Source: ${memory.sourceLabel}]\n`);
    console.log(raw);
  });

// ─── gnosys discover <query> ─────────────────────────────────────────────
program
  .command("discover <query>")
  .description("Discover relevant memories by keyword. Searches relevance clouds, titles, and tags — returns metadata only, no content.")
  .option("-n, --limit <number>", "Max results", "20")
  .action(async (query: string, opts: { limit: string }) => {
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
      console.log(`No memories found for "${query}". Try gnosys search for full-text.`);
      search.close();
      return;
    }

    console.log(`Found ${results.length} relevant memories for "${query}":\n`);
    for (const r of results) {
      console.log(`  ${r.title}`);
      console.log(`  ${r.relative_path}`);
      if (r.relevance) console.log(`  Relevance: ${r.relevance}`);
      console.log();
    }
    search.close();
  });

// ─── gnosys search <query> ───────────────────────────────────────────────
program
  .command("search <query>")
  .description("Search memories by keyword across all stores")
  .option("-n, --limit <number>", "Max results", "20")
  .action(async (query: string, opts: { limit: string }) => {
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
      console.log(`No results for "${query}".`);
      search.close();
      return;
    }

    console.log(`Found ${results.length} results for "${query}":\n`);
    for (const r of results) {
      console.log(`  ${r.title}`);
      console.log(`  ${r.relative_path}`);
      console.log(
        `  ${r.snippet.replace(/>>>/g, "").replace(/<<</g, "")}`
      );
      console.log();
    }
    search.close();
  });

// ─── gnosys list ─────────────────────────────────────────────────────────
program
  .command("list")
  .description("List all memories across all stores")
  .option("-c, --category <category>", "Filter by category")
  .option("-t, --tag <tag>", "Filter by tag")
  .option("-s, --store <store>", "Filter by store layer")
  .action(
    async (opts: { category?: string; tag?: string; store?: string }) => {
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

      console.log(`${memories.length} memories:\n`);
      for (const m of memories) {
        console.log(
          `  [${m.sourceLabel}] [${m.frontmatter.status}] ${m.frontmatter.title}`
        );
        console.log(`    ${m.sourceLabel}:${m.relativePath}`);
        console.log();
      }
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
          "Error: ANTHROPIC_API_KEY not set. Smart ingestion requires an LLM."
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
  .description("Initialize a new .gnosys store in the current directory")
  .option("-d, --directory <dir>", "Target directory (default: cwd)")
  .action(async (opts: { directory?: string }) => {
    const targetDir = opts.directory
      ? path.resolve(opts.directory)
      : process.cwd();
    const storePath = path.join(targetDir, ".gnosys");

    try {
      await fs.stat(storePath);
      console.error(`A .gnosys store already exists at ${storePath}`);
      process.exit(1);
    } catch {
      // Good
    }

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

    const changelog = `# Gnosys Changelog\n\n## ${new Date().toISOString().split("T")[0]}\n\n- Store initialized\n`;
    await fs.writeFile(
      path.join(storePath, "CHANGELOG.md"),
      changelog,
      "utf-8"
    );

    try {
      const { execSync } = await import("child_process");
      execSync("git init", { cwd: storePath, stdio: "pipe" });
      // Ensure git has a user identity for the initial commit
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

    console.log(`Gnosys store initialized at ${storePath}`);
    console.log(`\nCreated:`);
    console.log(`  .config/     (internal config)`);
    console.log(`  tags.json    (tag registry)`);
    console.log(`  CHANGELOG.md`);
    console.log(`  git repo`);
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
      console.error("Error: ANTHROPIC_API_KEY not set. commit-context requires an LLM.");
      process.exit(1);
    }

    // Build search index
    const stores = resolver.getStores();
    const search = new GnosysSearch(stores[0].path);
    search.clearIndex();
    for (const s of stores) {
      await search.addStoreMemories(s.store, s.label);
    }

    // Step 1: Extract candidates via LLM
    console.log("Extracting knowledge candidates from context...");
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

    const extractResponse = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: `You extract atomic knowledge items from conversations. Each item should be ONE decision, fact, insight, or observation — not compound.

Output a JSON array of objects, each with:
- summary: One-sentence description of the knowledge
- type: "decision" | "insight" | "fact" | "observation" | "requirement"
- search_terms: 3-5 keywords someone would search for to find if this already exists

Be selective. Only extract things worth remembering long-term. Skip small talk, debugging steps, and transient details. Focus on decisions made, architecture choices, requirements established, and insights gained.

Output ONLY the JSON array, no markdown fences.`,
      messages: [
        {
          role: "user",
          content: `Extract atomic knowledge items from this context:\n\n${context}`,
        },
      ],
    });

    const extractText =
      extractResponse.content[0].type === "text"
        ? extractResponse.content[0].text
        : "[]";

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
  .action(async () => {
    const resolver = await getResolver();
    const allMemories = await resolver.getAllMemories();

    if (allMemories.length === 0) {
      console.log("No memories found.");
      return;
    }

    const stats = computeStats(allMemories);

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

// ─── gnosys stores ───────────────────────────────────────────────────────
program
  .command("stores")
  .description("Show all active stores, their layers, paths, and permissions")
  .action(async () => {
    const resolver = await getResolver();
    console.log(resolver.getSummary());
  });

// ─── gnosys serve ────────────────────────────────────────────────────────
program
  .command("serve")
  .description("Start the MCP server (stdio mode)")
  .action(async () => {
    await import("./index.js");
  });

program.parse();
