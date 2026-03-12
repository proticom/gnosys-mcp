#!/usr/bin/env node
/**
 * Gnosys MCP Server — The core of Gnosys.
 * Exposes memory operations as MCP tools that any agent can call.
 * Supports layered stores: project (auto-discovered), personal, global, optional.
 */

// Load API keys from ~/.config/gnosys/.env before anything else.
// IMPORTANT: We use dotenv.parse() instead of dotenv.config() because
// dotenv v17+ writes injection notices to stdout, which corrupts the
// MCP stdio JSON protocol. parse() is a pure function with no side effects.
import dotenv from "dotenv";
import path from "path";
import { readFileSync } from "fs";
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import { MemoryFrontmatter } from "./lib/store.js";
import { GnosysSearch } from "./lib/search.js";
import { GnosysTagRegistry } from "./lib/tags.js";
import { performImport, formatImportSummary, estimateDuration } from "./lib/import.js";
import { GnosysIngestion } from "./lib/ingest.js";
import { GnosysResolver } from "./lib/resolver.js";
import { applyLens, applyCompoundLens, LensFilter, CompoundLens } from "./lib/lensing.js";
import { getFileHistory, getFileAtCommit, rollbackToCommit, hasGitHistory, getFileDiff } from "./lib/history.js";
import { groupByPeriod, computeStats, TimePeriod } from "./lib/timeline.js";
import { buildLinkGraph, getBacklinks, getOutgoingLinks, formatGraphSummary } from "./lib/wikilinks.js";
import { bootstrap, discoverFiles } from "./lib/bootstrap.js";
import { loadConfig, GnosysConfig, DEFAULT_CONFIG } from "./lib/config.js";
import { GnosysEmbeddings } from "./lib/embeddings.js";
import { GnosysHybridSearch } from "./lib/hybridSearch.js";
import { GnosysAsk } from "./lib/ask.js";
import { getLLMProvider, isProviderAvailable, LLMProvider } from "./lib/llm.js";
import { GnosysMaintenanceEngine, formatMaintenanceReport } from "./lib/maintenance.js";
import { recall, formatRecall, formatRecallCLI } from "./lib/recall.js";
import { initAudit, readAuditLog, formatAuditTimeline } from "./lib/audit.js";
import { GnosysDB } from "./lib/db.js";
import { syncMemoryToDb, syncUpdateToDb, syncArchiveToDb, syncDearchiveToDb, syncReinforcementToDb, auditToDb } from "./lib/dbWrite.js";
import { GnosysDreamEngine, DreamScheduler, formatDreamReport } from "./lib/dream.js";
import { GnosysExporter, formatExportReport } from "./lib/export.js";
import { createProjectIdentity, readProjectIdentity, findProjectIdentity, checkDirectoryMismatch } from "./lib/projectIdentity.js";

// Initialize resolver (discovers all layered stores)
const resolver = new GnosysResolver();
let config: GnosysConfig = DEFAULT_CONFIG;

// Create MCP server
const server = new McpServer({
  name: "gnosys",
  version: "2.0.0",
});

// These are initialized in main() after resolver runs
let search: GnosysSearch | null = null;
let tagRegistry: GnosysTagRegistry | null = null;
let ingestion: GnosysIngestion | null = null;
let hybridSearch: GnosysHybridSearch | null = null;
let askEngine: GnosysAsk | null = null;
/** v2.0: Unified SQLite store (available after migration) */
let gnosysDb: GnosysDB | null = null;
/** v3.0: Central DB at ~/.gnosys/gnosys.db */
let centralDb: GnosysDB | null = null;
/** v2.0: Dream scheduler (idle-time consolidation) */
let dreamScheduler: DreamScheduler | null = null;

// ─── Multi-Project Support ───────────────────────────────────────────────
// Each tool call can optionally pass a `projectRoot` to target a specific
// project's .gnosys store. This is STATELESS — no race conditions when
// multiple agents call tools in parallel.

/** Common Zod schema fragment for projectRoot parameter */
const projectRootParam = z.string().optional().describe(
  "Optional project root path for multi-project support. When provided, this tool operates on projectRoot/.gnosys instead of the default store. Use gnosys_stores to see all available stores."
);

/**
 * Per-call context resolution. If projectRoot is provided, creates a scoped
 * resolver and returns a project-specific context. Otherwise returns the
 * default (module-level) context. This is STATELESS and thread-safe.
 */
interface ToolContext {
  resolver: GnosysResolver;
  store: import("./lib/store.js").GnosysStore | null;
  storePath: string;
  config: GnosysConfig;
  search: GnosysSearch | null;
  gnosysDb: GnosysDB | null;
  /** v3.0: Central DB at ~/.gnosys/gnosys.db */
  centralDb: GnosysDB | null;
  /** v3.0: Project identity from .gnosys/gnosys.json */
  projectId: string | null;
}

async function resolveToolContext(projectRoot?: string): Promise<ToolContext> {
  if (!projectRoot) {
    // Default context — use module-level state
    const writeTarget = resolver.getWriteTarget();
    // v3.0: Try to read project identity from the write target's parent dir
    let projectId: string | null = null;
    if (writeTarget) {
      const parentDir = path.dirname(writeTarget.store.getStorePath());
      const identity = await readProjectIdentity(parentDir);
      projectId = identity?.projectId || null;
    }

    return {
      resolver,
      store: writeTarget?.store || null,
      storePath: writeTarget?.store.getStorePath() || "",
      config,
      search,
      gnosysDb,
      centralDb,
      projectId,
    };
  }

  // Scoped context — resolve for this specific project
  const scopedResolver = await GnosysResolver.resolveForProject(projectRoot);
  const scopedWriteTarget = scopedResolver.getWriteTarget();
  const scopedStorePath = scopedWriteTarget?.store.getStorePath() || "";
  let scopedConfig = DEFAULT_CONFIG;
  let scopedDb: GnosysDB | null = null;
  let scopedSearch: GnosysSearch | null = null;

  // v3.0: Read project identity
  const identity = await readProjectIdentity(path.resolve(projectRoot));
  const projectId = identity?.projectId || null;

  if (scopedStorePath) {
    try {
      scopedConfig = await loadConfig(scopedStorePath);
    } catch {
      // Use defaults
    }

    // Initialize search for the scoped store
    scopedSearch = new GnosysSearch(scopedStorePath);
    if (scopedWriteTarget) {
      await scopedSearch.addStoreMemories(scopedWriteTarget.store);
    }

    // Initialize GnosysDB for the scoped store
    try {
      scopedDb = new GnosysDB(scopedStorePath);
      if (!scopedDb.isAvailable() || !scopedDb.isMigrated()) {
        scopedDb = null;
      }
    } catch {
      scopedDb = null;
    }
  }

  return {
    resolver: scopedResolver,
    store: scopedWriteTarget?.store || null,
    storePath: scopedStorePath,
    config: scopedConfig,
    search: scopedSearch,
    gnosysDb: scopedDb,
    centralDb,
    projectId,
  };
}

// ─── Tool: gnosys_discover ──────────────────────────────────────────────
server.tool(
  "gnosys_discover",
  "Discover relevant memories by describing what you're working on. Searches relevance keyword clouds across all stores. Returns lightweight metadata (title, path, relevance keywords) — NO file contents. Use gnosys_read to load specific memories you need. Call this FIRST when starting a task to find what Gnosys knows.",
  {
    query: z
      .string()
      .describe(
        "Describe what you're working on or looking for. Use keywords, not sentences. Example: 'auth JWT session tokens' or 'deployment CI/CD pipeline'"
      ),
    limit: z.number().optional().describe("Max results (default 20)"),
    projectRoot: projectRootParam,
  },
  async ({ query, limit, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    // v2.0 DB-backed fast path
    if (ctx.gnosysDb?.isAvailable() && ctx.gnosysDb?.isMigrated()) {
      const results = ctx.gnosysDb.discoverFts(query, limit || 20);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No memories found for "${query}". Try different keywords.` }],
        };
      }
      const formatted = results
        .map((r) => `**${r.title}**\n  ID: ${r.id}${r.relevance ? `\n  Relevance: ${r.relevance}` : ""}`)
        .join("\n\n");
      return {
        content: [{ type: "text", text: `Found ${results.length} relevant memories for "${query}":\n\n${formatted}\n\nUse gnosys_read to load any of these.` }],
      };
    }

    // v1.x legacy path
    if (!ctx.search) {
      return {
        content: [{ type: "text", text: "Search index not initialized." }],
        isError: true,
      };
    }

    const results = ctx.search.discover(query, limit || 20);
    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No memories found for "${query}". Try different keywords or use gnosys_search for full-text search.`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r) =>
          `**${r.title}**\n  Path: ${r.relative_path}${r.relevance ? `\n  Relevance: ${r.relevance}` : ""}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} relevant memories for "${query}":\n\n${formatted}\n\nUse gnosys_read to load any of these.`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_read ───────────────────────────────────────────────────
server.tool(
  "gnosys_read",
  "Read a specific memory. Accepts a memory ID (e.g., 'arch-012') or layer-prefixed path (e.g., 'project:decisions/why-not-rag.md'). Without a prefix, searches all stores in precedence order.",
  {
    path: z.string().describe("Memory ID or path, optionally prefixed with store layer"),
    projectRoot: projectRootParam,
  },
  async ({ path: memPath, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    // v2.0 DB-backed fast path: try reading by memory ID from gnosys.db first
    if (ctx.gnosysDb?.isAvailable() && ctx.gnosysDb?.isMigrated()) {
      const dbMem = ctx.gnosysDb.getMemory(memPath);
      if (dbMem) {
        const tags = dbMem.tags || "[]";
        const header = [
          `---`,
          `id: ${dbMem.id}`,
          `title: '${dbMem.title}'`,
          `category: ${dbMem.category}`,
          `tags: ${tags}`,
          `relevance: ${dbMem.relevance}`,
          `author: ${dbMem.author}`,
          `authority: ${dbMem.authority}`,
          `confidence: ${dbMem.confidence}`,
          `status: ${dbMem.status}`,
          `tier: ${dbMem.tier}`,
          `created: '${dbMem.created}'`,
          `modified: '${dbMem.modified}'`,
          `---`,
        ].join("\n");
        return {
          content: [{ type: "text", text: `[Source: gnosys.db]\n\n${header}\n\n${dbMem.content}` }],
        };
      }
      // Not found in db — fall through to legacy path
    }

    // v1.x legacy path
    const memory = await ctx.resolver.readMemory(memPath);
    if (!memory) {
      return {
        content: [{ type: "text", text: `Memory not found: ${memPath}` }],
        isError: true,
      };
    }

    const raw = await fs.readFile(memory.filePath, "utf-8");
    return {
      content: [
        {
          type: "text",
          text: `[Source: ${memory.sourceLabel}]\n\n${raw}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_search ─────────────────────────────────────────────────
server.tool(
  "gnosys_search",
  "Search memories by keyword across all stores. Returns matching file paths with relevance snippets.",
  {
    query: z.string().describe("Search query (keywords)"),
    limit: z.number().optional().describe("Max results (default 20)"),
    projectRoot: projectRootParam,
  },
  async ({ query, limit, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    // v2.0 DB-backed fast path
    if (ctx.gnosysDb?.isAvailable() && ctx.gnosysDb?.isMigrated()) {
      const results = ctx.gnosysDb.searchFts(query, limit || 20);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results for "${query}". Try different keywords.` }],
        };
      }
      const formatted = results
        .map((r) => `**${r.title}** (${r.id})\n${r.snippet.replace(/>>>/g, "**").replace(/<<</g, "**")}`)
        .join("\n\n");
      return {
        content: [{ type: "text", text: `Found ${results.length} results for "${query}":\n\n${formatted}` }],
      };
    }

    // v1.x legacy path
    if (!ctx.search) {
      return {
        content: [{ type: "text", text: "Search index not initialized." }],
        isError: true,
      };
    }

    const results = ctx.search.search(query, limit || 20);
    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results for "${query}". Try different keywords or use gnosys_discover.`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r) =>
          `**${r.title}** (${r.relative_path})\n${r.snippet.replace(/>>>/g, "**").replace(/<<</g, "**")}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} results for "${query}":\n\n${formatted}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_list ───────────────────────────────────────────────────
server.tool(
  "gnosys_list",
  "List memories across all stores, optionally filtered by category, tag, or store layer.",
  {
    category: z.string().optional().describe("Filter by category"),
    tag: z.string().optional().describe("Filter by tag"),
    store: z.string().optional().describe("Filter by store layer (project/personal/global/optional)"),
    status: z.string().optional().describe("Filter by status (active/archived/superseded)"),
    projectRoot: projectRootParam,
  },
  async ({ category, tag, store: storeFilter, status, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    let memories = await ctx.resolver.getAllMemories();

    if (storeFilter) {
      memories = memories.filter((m) => m.sourceLayer === storeFilter || m.sourceLabel === storeFilter);
    }
    if (category) {
      memories = memories.filter((m) => m.frontmatter.category === category);
    }
    if (tag) {
      memories = memories.filter((m) => {
        const tags = Array.isArray(m.frontmatter.tags)
          ? m.frontmatter.tags
          : Object.values(m.frontmatter.tags).flat();
        return tags.includes(tag);
      });
    }
    if (status) {
      memories = memories.filter((m) => m.frontmatter.status === status);
    }

    const lines = memories.map(
      (m) =>
        `- [${m.sourceLabel}] **${m.frontmatter.title}** (${m.relativePath}) [${m.frontmatter.status}]`
    );

    return {
      content: [
        {
          type: "text",
          text:
            lines.length > 0
              ? `${lines.length} memories:\n\n${lines.join("\n")}`
              : "No memories match the filter.",
        },
      ],
    };
  }
);

// ─── Tool: gnosys_add ────────────────────────────────────────────────────
server.tool(
  "gnosys_add",
  "Add a new memory. Accepts raw text — an LLM structures it into an atomic memory. Writes to the project store by default. Use store='personal' for cross-project knowledge, or store='global' to explicitly write to shared org knowledge.",
  {
    input: z
      .string()
      .describe(
        "Raw text input. Can be a decision, concept, fact, observation, or any knowledge."
      ),
    store: z
      .enum(["project", "personal", "global"])
      .optional()
      .describe("Which store to write to (default: project). Global requires explicit intent."),
    author: z
      .enum(["human", "ai", "human+ai"])
      .optional()
      .describe("Who is adding this memory"),
    authority: z
      .enum(["declared", "observed", "imported", "inferred"])
      .optional()
      .describe("Epistemic trust level"),
    projectRoot: projectRootParam,
  },
  async ({ input, store: targetStore, author, authority, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const writeTarget = ctx.resolver.getWriteTarget(
      (targetStore as "project" | "personal" | "global") || undefined
    );
    if (!writeTarget) {
      return {
        content: [
          {
            type: "text",
            text: "No writable store found. Create a .gnosys/ directory in your project root or set GNOSYS_PERSONAL.",
          },
        ],
        isError: true,
      };
    }

    // Note: ingestion remains module-level since it's heavy and project-agnostic
    if (!ingestion) {
      return {
        content: [
          { type: "text", text: "Ingestion module not initialized." },
        ],
        isError: true,
      };
    }

    try {
      const result = await ingestion.ingest(input);
      const id = await writeTarget.store.generateId(result.category);

      const today = new Date().toISOString().split("T")[0];
      const frontmatter = {
        id,
        title: result.title,
        category: result.category,
        tags: result.tags,
        relevance: result.relevance,
        author: author || "ai",
        authority: authority || "observed",
        confidence: result.confidence,
        created: today,
        modified: today,
        last_reviewed: today,
        status: "active" as const,
        supersedes: null,
      };

      const filename = `${result.filename}.md`;
      const content = `# ${result.title}\n\n${result.content}`;
      const relativePath = await writeTarget.store.writeMemory(
        result.category,
        filename,
        frontmatter,
        content
      );

      // v2.0: Dual-write to gnosys.db
      if (ctx.gnosysDb?.isAvailable()) {
        syncMemoryToDb(ctx.gnosysDb, frontmatter, content, relativePath);
        auditToDb(ctx.gnosysDb, "write", id, { tool: "gnosys_add", category: result.category });
      }

      // Rebuild search index across all stores
      if (ctx.search) {
        await reindexAllStores();
      }

      let response = `Memory added to [${writeTarget.label}]: **${result.title}**\nPath: ${writeTarget.label}:${relativePath}\nCategory: ${result.category}\nConfidence: ${result.confidence}`;

      if (result.proposedNewTags && result.proposedNewTags.length > 0) {
        const proposed = result.proposedNewTags
          .map((t) => `${t.category}:${t.tag}`)
          .join(", ");
        response += `\n\nProposed new tags (not yet in registry): ${proposed}\nUse gnosys_tags_add to approve them.`;
      }

      // Contradiction / overlap detection: search for closely related memories
      if (ctx.search && result.relevance) {
        const related = ctx.search.discover(result.relevance.split(" ").slice(0, 5).join(" "), 5);
        // Filter out the memory we just added
        const overlaps = related.filter(
          (r) => !r.relative_path.endsWith(filename)
        );
        if (overlaps.length > 0) {
          response += `\n\n⚠️ Potential overlaps detected — review these for contradictions:`;
          for (const o of overlaps.slice(0, 3)) {
            response += `\n  - ${o.title} (${o.relative_path})`;
          }
          response += `\nUse gnosys_read to compare, then gnosys_update with supersedes/superseded_by if needed.`;
        }
      }

      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error adding memory: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_add_structured ─────────────────────────────────────────
server.tool(
  "gnosys_add_structured",
  "Add a memory with structured input (no LLM needed). Writes to the project store by default. Use store='global' to explicitly write to shared org knowledge.",
  {
    title: z.string().describe("Memory title"),
    category: z.string().describe("Category directory name"),
    tags: z
      .record(z.string(), z.array(z.string()))
      .describe("Tags object, e.g. { domain: ['auth'], type: ['decision'] }"),
    relevance: z
      .string()
      .optional()
      .describe("Keyword cloud for discovery search. Space-separated terms describing contexts where this memory is useful."),
    content: z.string().describe("Memory content as markdown"),
    store: z.enum(["project", "personal", "global"]).optional().describe("Target store (default: project). Global requires explicit intent."),
    author: z.enum(["human", "ai", "human+ai"]).optional(),
    authority: z
      .enum(["declared", "observed", "imported", "inferred"])
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    projectRoot: projectRootParam,
  },
  async ({ title, category, tags, relevance, content, store: targetStore, author, authority, confidence, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const writeTarget = ctx.resolver.getWriteTarget(
      (targetStore as "project" | "personal" | "global") || undefined
    );
    if (!writeTarget) {
      return {
        content: [{ type: "text", text: "No writable store found." }],
        isError: true,
      };
    }

    const id = await writeTarget.store.generateId(category);
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 60);

    const today = new Date().toISOString().split("T")[0];
    const frontmatter: MemoryFrontmatter = {
      id,
      title,
      category,
      tags: tags as Record<string, string[]>,
      relevance: relevance || "",
      author: author || "ai",
      authority: authority || "observed",
      confidence: confidence || 0.8,
      created: today,
      modified: today,
      last_reviewed: today,
      status: "active" as const,
      supersedes: null,
    };

    const fullContent = `# ${title}\n\n${content}`;
    const relativePath = await writeTarget.store.writeMemory(
      category,
      `${slug}.md`,
      frontmatter,
      fullContent
    );

    // v2.0: Dual-write to gnosys.db
    if (ctx.gnosysDb?.isAvailable()) {
      syncMemoryToDb(ctx.gnosysDb, frontmatter, fullContent, relativePath);
      auditToDb(ctx.gnosysDb, "write", id, { tool: "gnosys_add_structured", category });
    }

    if (ctx.search) await reindexAllStores();

    return {
      content: [
        {
          type: "text",
          text: `Memory added to [${writeTarget.label}]: **${title}**\nPath: ${writeTarget.label}:${relativePath}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_tags ───────────────────────────────────────────────────
server.tool(
  "gnosys_tags",
  "List all tags in the registry, grouped by category.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    // Tag registry is module-level and shared across projects, projectRoot is for API consistency
    if (!tagRegistry) {
      return { content: [{ type: "text", text: "Tag registry not loaded." }], isError: true };
    }
    const registry = tagRegistry.getRegistry();
    const lines: string[] = ["# Gnosys Tag Registry\n"];

    for (const [category, tags] of Object.entries(registry)) {
      lines.push(`## ${category}`);
      lines.push(tags.sort().join(", "));
      lines.push("");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: gnosys_tags_add ───────────────────────────────────────────────
server.tool(
  "gnosys_tags_add",
  "Add a new tag to the registry.",
  {
    category: z.string().describe("Tag category (domain, type, concern, status_tag)"),
    tag: z.string().describe("The new tag to add"),
    projectRoot: projectRootParam,
  },
  async ({ category, tag, projectRoot }) => {
    // Tag registry is module-level and shared across projects, projectRoot is for API consistency
    if (!tagRegistry) {
      return { content: [{ type: "text", text: "Tag registry not loaded." }], isError: true };
    }
    const added = await tagRegistry.addTag(category, tag);
    if (added) {
      return {
        content: [{ type: "text", text: `Tag '${tag}' added to category '${category}'.` }],
      };
    }
    return {
      content: [{ type: "text", text: `Tag '${tag}' already exists in '${category}'.` }],
    };
  }
);

// ─── Tool: gnosys_reinforce ──────────────────────────────────────────────
server.tool(
  "gnosys_reinforce",
  "Signal whether a memory was useful. 'useful' reinforces it (resets decay). 'not_relevant' means routing was wrong, not the memory (memory unchanged). 'outdated' flags for review.",
  {
    memory_id: z.string().describe("The memory ID (from frontmatter)"),
    signal: z
      .enum(["useful", "not_relevant", "outdated"])
      .describe("The reinforcement signal"),
    context: z.string().optional().describe("Why this signal was given"),
    projectRoot: projectRootParam,
  },
  async ({ memory_id, signal, context, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    // Log to the first writable store's .config directory
    const writeTarget = ctx.resolver.getWriteTarget();
    if (writeTarget) {
      const logPath = path.join(
        writeTarget.store.getStorePath(),
        ".config",
        "reinforcement.log"
      );
      const entry = JSON.stringify({
        memory_id,
        signal,
        context,
        timestamp: new Date().toISOString(),
      });
      await fs.appendFile(logPath, entry + "\n", "utf-8");
    }

    // If 'useful', find the memory across all stores and update if writable
    if (signal === "useful") {
      const allMemories = await ctx.resolver.getAllMemories();
      const memory = allMemories.find((m) => m.frontmatter.id === memory_id);
      if (memory) {
        const sourceStore = ctx.resolver
          .getStores()
          .find((s) => s.label === memory.sourceLabel);
        if (sourceStore?.writable) {
          const count = (memory.frontmatter.reinforcement_count || 0) + 1;
          await sourceStore.store.updateMemory(memory.relativePath, {
            modified: new Date().toISOString().split("T")[0],
            reinforcement_count: count,
            last_reinforced: new Date().toISOString().split("T")[0],
          } as any);

          // v2.0: Sync reinforcement to gnosys.db
          if (ctx.gnosysDb?.isAvailable()) {
            syncReinforcementToDb(ctx.gnosysDb, memory_id, count);
            auditToDb(ctx.gnosysDb, "reinforce", memory_id, { signal, context });
          }
        }
      }
    }

    const messages: Record<string, string> = {
      useful: `Memory ${memory_id} reinforced. Decay clock reset.`,
      not_relevant: `Routing feedback logged for ${memory_id}. Memory unchanged — consider reviewing its relevance keywords or tags.`,
      outdated: `Memory ${memory_id} flagged for review as outdated.`,
    };

    return { content: [{ type: "text", text: messages[signal] }] };
  }
);

// ─── Tool: gnosys_init ───────────────────────────────────────────────────
server.tool(
  "gnosys_init",
  "Initialize Gnosys in a project directory. Creates .gnosys/ with project identity (gnosys.json), registers the project in the central DB (~/.gnosys/gnosys.db), and sets up tag registry + git. You MUST run this before any other Gnosys tool in a new project. Pass the full absolute path to the project root.",
  {
    directory: z
      .string()
      .describe(
        "Absolute path to the project directory to initialize. Required."
      ),
    projectName: z.string().optional().describe("Human-readable project name. Defaults to directory basename."),
    projectRoot: projectRootParam,
  },
  async ({ directory, projectName, projectRoot }) => {
    // Note: For gnosys_init, directory is the target, projectRoot is ignored since we're creating new
    const targetDir = path.resolve(directory);
    const storePath = path.join(targetDir, ".gnosys");

    // Check if already exists — if so, re-sync identity instead of failing
    let isResync = false;
    try {
      await fs.stat(storePath);
      isResync = true;
    } catch {
      // Good — doesn't exist yet
    }

    if (!isResync) {
      // Create directory structure
      await fs.mkdir(storePath, { recursive: true });
      await fs.mkdir(path.join(storePath, ".config"), { recursive: true });

      // Seed default tag registry
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

      // Seed changelog
      const changelog = `# Gnosys Changelog\n\n## ${new Date().toISOString().split("T")[0]}\n\n- Store initialized\n`;
      await fs.writeFile(
        path.join(storePath, "CHANGELOG.md"),
        changelog,
        "utf-8"
      );

      // Init git
      try {
        const { execSync } = await import("child_process");
        execSync("git init", { cwd: storePath, stdio: "pipe" });
        execSync("git add -A", { cwd: storePath, stdio: "pipe" });
        execSync('git commit -m "Initialize Gnosys store"', {
          cwd: storePath,
          stdio: "pipe",
        });
      } catch {
        // Git not available — that's fine
      }
    }

    // v3.0: Create/update project identity and register in central DB
    const identity = await createProjectIdentity(targetDir, {
      projectName,
      centralDb: centralDb || undefined,
    });

    // Register this project so the resolver finds it on future restarts
    await resolver.registerProject(targetDir);

    // Directly add the new store to the resolver (no re-resolve from cwd needed)
    await resolver.addProjectStore(storePath);

    // Initialize search, tags, and ingestion if this is the first store
    const writeTarget = resolver.getWriteTarget();
    if (writeTarget && !search) {
      search = new GnosysSearch(writeTarget.store.getStorePath());
      tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
      await tagRegistry.load();
      ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);
      await reindexAllStores();
    }

    const action = isResync ? "re-synced" : "initialized";
    return {
      content: [
        {
          type: "text",
          text: `Gnosys store ${action} at ${storePath}\n\nProject Identity:\n- ID: ${identity.projectId}\n- Name: ${identity.projectName}\n- Directory: ${identity.workingDirectory}\n- Agent rules target: ${identity.agentRulesTarget || "none detected"}\n- Central DB: ${centralDb?.isAvailable() ? "registered ✓" : "not available"}\n\n${isResync ? "Identity re-synced." : "Created:\n- gnosys.json (project identity)\n- .config/ (internal config)\n- tags.json (tag registry)\n- CHANGELOG.md\n- git repo"}\n\nThe store is ready. Use gnosys_discover to find existing memories or gnosys_add to create new ones.`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_update ─────────────────────────────────────────────────
server.tool(
  "gnosys_update",
  "Update an existing memory's frontmatter and/or content. Specify the memory path and the fields to change.",
  {
    path: z
      .string()
      .describe(
        "Path to memory, optionally prefixed with store layer (e.g., 'project:decisions/auth.md')"
      ),
    title: z.string().optional().describe("New title"),
    tags: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe("New tags object"),
    status: z
      .enum(["active", "archived", "superseded"])
      .optional()
      .describe("New status"),
    confidence: z.number().min(0).max(1).optional().describe("New confidence"),
    supersedes: z
      .string()
      .optional()
      .describe("ID of memory this supersedes"),
    relevance: z
      .string()
      .optional()
      .describe("Updated relevance keyword cloud for discovery"),
    superseded_by: z
      .string()
      .optional()
      .describe("ID of memory that supersedes this one"),
    content: z
      .string()
      .optional()
      .describe("New markdown content (replaces existing body)"),
    projectRoot: projectRootParam,
  },
  async ({
    path: memPath,
    title,
    tags,
    status,
    confidence,
    relevance,
    supersedes,
    superseded_by,
    content: newContent,
    projectRoot,
  }) => {
    const ctx = await resolveToolContext(projectRoot);
    const memory = await ctx.resolver.readMemory(memPath);
    if (!memory) {
      return {
        content: [{ type: "text", text: `Memory not found: ${memPath}` }],
        isError: true,
      };
    }

    // Find the source store and check if writable
    const sourceStore = ctx.resolver
      .getStores()
      .find((s) => s.label === memory.sourceLabel);
    if (!sourceStore?.writable) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot update: store [${memory.sourceLabel}] is read-only.`,
          },
        ],
        isError: true,
      };
    }

    // Build updates object — only include defined fields
    const updates: Partial<MemoryFrontmatter> = {};
    if (title !== undefined) updates.title = title;
    if (tags !== undefined) updates.tags = tags as Record<string, string[]>;
    if (status !== undefined) updates.status = status;
    if (confidence !== undefined) updates.confidence = confidence;
    if (relevance !== undefined) updates.relevance = relevance;
    if (supersedes !== undefined) updates.supersedes = supersedes;
    if (superseded_by !== undefined) updates.superseded_by = superseded_by;

    const fullContent = newContent ? `# ${title || memory.frontmatter.title}\n\n${newContent}` : undefined;

    const updated = await sourceStore.store.updateMemory(
      memory.relativePath,
      updates,
      fullContent
    );

    if (!updated) {
      return {
        content: [{ type: "text", text: `Failed to update: ${memPath}` }],
        isError: true,
      };
    }

    // Supersession cross-linking: if A supersedes B, mark B as superseded_by A
    if (supersedes && updated.frontmatter.id) {
      const allMemories = await ctx.resolver.getAllMemories();
      const supersededMemory = allMemories.find(
        (m) => m.frontmatter.id === supersedes
      );
      if (supersededMemory) {
        const supersededStore = ctx.resolver
          .getStores()
          .find((s) => s.label === supersededMemory.sourceLabel);
        if (supersededStore?.writable) {
          await supersededStore.store.updateMemory(
            supersededMemory.relativePath,
            {
              superseded_by: updated.frontmatter.id,
              status: "superseded",
            } as Partial<MemoryFrontmatter>
          );
        }
      }
    }

    // v2.0: Dual-write update to gnosys.db
    if (ctx.gnosysDb?.isAvailable() && updated.frontmatter.id) {
      syncUpdateToDb(ctx.gnosysDb, updated.frontmatter.id, updates, fullContent);
      auditToDb(ctx.gnosysDb, "write", updated.frontmatter.id, { tool: "gnosys_update", changed: Object.keys(updates) });

      // Cross-link supersession in db too
      if (supersedes) {
        syncUpdateToDb(ctx.gnosysDb, supersedes, { superseded_by: updated.frontmatter.id, status: "superseded" });
      }
    }

    // Rebuild search index
    if (ctx.search) await reindexAllStores();

    const changedFields = Object.keys(updates);
    if (newContent) changedFields.push("content");

    return {
      content: [
        {
          type: "text",
          text: `Memory updated: **${updated.frontmatter.title}**\nPath: ${memory.sourceLabel}:${memory.relativePath}\nChanged: ${changedFields.join(", ")}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_stale ─────────────────────────────────────────────────
server.tool(
  "gnosys_stale",
  "Find memories that haven't been modified or reviewed within a given number of days. Useful for identifying knowledge that may be outdated.",
  {
    days: z
      .number()
      .optional()
      .describe("Number of days since last modification to consider stale (default: 90)"),
    limit: z.number().optional().describe("Max results (default 20)"),
    projectRoot: projectRootParam,
  },
  async ({ days, limit, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const threshold = days || 90;
    const maxResults = limit || 20;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - threshold);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const allMemories = await ctx.resolver.getAllMemories();
    const stale = allMemories
      .filter((m) => {
        const lastTouched = m.frontmatter.last_reviewed || m.frontmatter.modified;
        return lastTouched && lastTouched < cutoffStr;
      })
      .sort((a, b) => {
        const aDate = a.frontmatter.last_reviewed || a.frontmatter.modified;
        const bDate = b.frontmatter.last_reviewed || b.frontmatter.modified;
        return (aDate || "").localeCompare(bDate || "");
      })
      .slice(0, maxResults);

    if (stale.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No memories older than ${threshold} days found. Everything is fresh.`,
          },
        ],
      };
    }

    const lines = stale.map(
      (m) =>
        `- **${m.frontmatter.title}** (${m.sourceLabel}:${m.relativePath})\n  Last modified: ${m.frontmatter.modified}${m.frontmatter.last_reviewed ? `, Last reviewed: ${m.frontmatter.last_reviewed}` : ""}`
    );

    return {
      content: [
        {
          type: "text",
          text: `Found ${stale.length} memories not touched in ${threshold}+ days:\n\n${lines.join("\n\n")}\n\nUse gnosys_read to review, then gnosys_update or gnosys_reinforce as needed.`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_commit_context ────────────────────────────────────────
server.tool(
  "gnosys_commit_context",
  "Pre-compaction memory sweep. Call this before context is lost (e.g., before a long conversation compacts). Extracts important decisions, facts, and insights from the conversation and commits novel ones to memory. Checks existing memories to avoid duplicates — only adds what's genuinely new or augments what's changed.",
  {
    context: z
      .string()
      .describe(
        "Summary of the conversation or context to extract memories from. Include key decisions, facts, insights, and observations."
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "If true, show what would be committed without actually writing. Default: false."
      ),
    projectRoot: projectRootParam,
  },
  async ({ context, dry_run, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    // Note: ingestion is module-level since it's heavy
    if (!ingestion || !ingestion.isLLMAvailable) {
      return {
        content: [
          {
            type: "text",
            text: "Commit context requires an LLM. Configure a provider in gnosys.json or set ANTHROPIC_API_KEY.",
          },
        ],
        isError: true,
      };
    }

    const writeTarget = ctx.resolver.getWriteTarget();
    if (!writeTarget) {
      return {
        content: [{ type: "text", text: "No writable store found." }],
        isError: true,
      };
    }

    // Step 1: Use LLM to extract candidate memories from the context
    let extractProvider: LLMProvider;
    try {
      extractProvider = getLLMProvider(ctx.config, "structuring");
    } catch (err) {
      return {
        content: [{ type: "text", text: `LLM not available: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
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

    let candidates: Array<{
      summary: string;
      type: string;
      search_terms: string[];
    }>;
    try {
      const jsonMatch =
        extractText.match(/```json\s*([\s\S]*?)```/) ||
        extractText.match(/```\s*([\s\S]*?)```/) || [null, extractText];
      candidates = JSON.parse(jsonMatch[1] || extractText);
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `Failed to extract candidates from context. LLM output was not valid JSON.`,
          },
        ],
        isError: true,
      };
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No extractable knowledge found in the provided context.",
          },
        ],
      };
    }

    // Step 2: For each candidate, check if it's novel by searching existing memories
    const results: string[] = [];
    let added = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const searchTerms = candidate.search_terms.join(" ");

      // Check existing memories via discover
      const existing = ctx.search
        ? ctx.search.discover(searchTerms, 3)
        : [];

      const hasOverlap = existing.length > 0;

      if (hasOverlap) {
        const topMatch = existing[0];
        results.push(
          `⏭ SKIP: "${candidate.summary}"\n  Overlaps with: ${topMatch.title} (${topMatch.relative_path})`
        );
        skipped++;
      } else {
        if (dry_run) {
          results.push(`➕ WOULD ADD: "${candidate.summary}" [${candidate.type}]`);
          added++;
        } else {
          // Actually add via ingestion
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
              author: "ai" as const,
              authority: "observed" as const,
              confidence: result.confidence,
              created: today,
              modified: today,
              last_reviewed: today,
              status: "active" as const,
              supersedes: null,
            };

            const filename = `${result.filename}.md`;
            const content = `# ${result.title}\n\n${result.content}`;
            const relPath = await writeTarget.store.writeMemory(
              result.category,
              filename,
              frontmatter,
              content
            );

            results.push(
              `➕ ADDED: "${result.title}"\n  Path: ${writeTarget.label}:${relPath}`
            );
            added++;
          } catch (err) {
            results.push(
              `❌ FAILED: "${candidate.summary}": ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }

    // Rebuild search index after all writes
    if (!dry_run && ctx.search && added > 0) {
      await reindexAllStores();
    }

    const header = dry_run
      ? `DRY RUN — ${candidates.length} candidates extracted, ${added} would be added, ${skipped} duplicates skipped:`
      : `Context committed — ${candidates.length} candidates extracted, ${added} added, ${skipped} duplicates skipped:`;

    return {
      content: [
        {
          type: "text",
          text: `${header}\n\n${results.join("\n\n")}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_history ────────────────────────────────────────────────
server.tool(
  "gnosys_history",
  "View version history for a memory. Shows what changed and when. Every memory write/update creates a git commit, so the full evolution is available.",
  {
    path: z.string().describe("Path to memory, optionally layer-prefixed"),
    limit: z.number().optional().describe("Max history entries (default 20)"),
    projectRoot: projectRootParam,
  },
  async ({ path: memPath, limit, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const memory = await ctx.resolver.readMemory(memPath);
    if (!memory) {
      return { content: [{ type: "text", text: `Memory not found: ${memPath}` }], isError: true };
    }

    const sourceStore = ctx.resolver.getStores().find((s) => s.label === memory.sourceLabel);
    if (!sourceStore || !hasGitHistory(sourceStore.path)) {
      return { content: [{ type: "text", text: "No git history available for this store." }], isError: true };
    }

    const history = getFileHistory(sourceStore.path, memory.relativePath, limit || 20);
    if (history.length === 0) {
      return { content: [{ type: "text", text: "No history found for this memory." }] };
    }

    const lines = history.map(
      (e) => `- \`${e.commitHash.substring(0, 7)}\` ${e.date} — ${e.message}`
    );

    return {
      content: [{
        type: "text",
        text: `History for **${memory.frontmatter.title}** (${history.length} entries):\n\n${lines.join("\n")}\n\nUse gnosys_rollback with a commit hash to revert to a prior version.`,
      }],
    };
  }
);

// ─── Tool: gnosys_rollback ──────────────────────────────────────────────
server.tool(
  "gnosys_rollback",
  "Rollback a memory to its state at a specific commit. Non-destructive: creates a new commit with the reverted content. Use gnosys_history first to find the target commit hash.",
  {
    path: z.string().describe("Path to memory, optionally layer-prefixed"),
    commitHash: z.string().describe("Git commit hash to revert to (full or abbreviated)"),
    projectRoot: projectRootParam,
  },
  async ({ path: memPath, commitHash, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const memory = await ctx.resolver.readMemory(memPath);
    if (!memory) {
      return { content: [{ type: "text", text: `Memory not found: ${memPath}` }], isError: true };
    }

    const sourceStore = ctx.resolver.getStores().find((s) => s.label === memory.sourceLabel);
    if (!sourceStore?.writable) {
      return { content: [{ type: "text", text: "Cannot rollback: store is read-only." }], isError: true };
    }

    const success = rollbackToCommit(sourceStore.path, memory.relativePath, commitHash);
    if (!success) {
      return { content: [{ type: "text", text: `Rollback failed. Verify the commit hash with gnosys_history.` }], isError: true };
    }

    // Reindex after rollback
    if (ctx.search) await reindexAllStores();

    // Read the reverted memory
    const reverted = await ctx.resolver.readMemory(memPath);
    return {
      content: [{
        type: "text",
        text: `Rolled back **${memory.frontmatter.title}** to commit ${commitHash.substring(0, 7)}.\n\nCurrent state: ${reverted?.frontmatter.title} [${reverted?.frontmatter.status}] (confidence: ${reverted?.frontmatter.confidence})`,
      }],
    };
  }
);

// ─── Tool: gnosys_lens ──────────────────────────────────────────────────
server.tool(
  "gnosys_lens",
  "Filtered view of memories. Combine criteria to focus on specific subsets — e.g., 'active decisions about auth with confidence > 0.8'. Use AND (default) to require all criteria, or OR to match any.",
  {
    category: z.string().optional().describe("Filter by category"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    tagMatchMode: z.enum(["any", "all"]).optional().describe("'any' = has any listed tag (default), 'all' = must have every listed tag"),
    status: z.array(z.enum(["active", "archived", "superseded"])).optional().describe("Filter by status"),
    author: z.array(z.enum(["human", "ai", "human+ai"])).optional().describe("Filter by author"),
    authority: z.array(z.enum(["declared", "observed", "imported", "inferred"])).optional().describe("Filter by authority"),
    minConfidence: z.number().min(0).max(1).optional().describe("Minimum confidence"),
    maxConfidence: z.number().min(0).max(1).optional().describe("Maximum confidence"),
    createdAfter: z.string().optional().describe("Created after ISO date"),
    createdBefore: z.string().optional().describe("Created before ISO date"),
    modifiedAfter: z.string().optional().describe("Modified after ISO date"),
    modifiedBefore: z.string().optional().describe("Modified before ISO date"),
    operator: z.enum(["AND", "OR"]).optional().describe("Compound operator when multiple filter groups are provided (default: AND)"),
    projectRoot: projectRootParam,
  },
  async ({ category, tags, tagMatchMode, status, author, authority, minConfidence, maxConfidence, createdAfter, createdBefore, modifiedAfter, modifiedBefore, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const allMemories = await ctx.resolver.getAllMemories();

    const lens: LensFilter = {};
    if (category) lens.category = category;
    if (tags) { lens.tags = tags; lens.tagMatchMode = tagMatchMode || "any"; }
    if (status) lens.status = status;
    if (author) lens.author = author;
    if (authority) lens.authority = authority;
    if (minConfidence !== undefined) lens.minConfidence = minConfidence;
    if (maxConfidence !== undefined) lens.maxConfidence = maxConfidence;
    if (createdAfter) lens.createdAfter = createdAfter;
    if (createdBefore) lens.createdBefore = createdBefore;
    if (modifiedAfter) lens.modifiedAfter = modifiedAfter;
    if (modifiedBefore) lens.modifiedBefore = modifiedBefore;

    const result = applyLens(allMemories, lens);

    if (result.length === 0) {
      return { content: [{ type: "text", text: "No memories match the lens filter." }] };
    }

    const lines = result.map(
      (m) => `- **${m.frontmatter.title}** [${m.frontmatter.status}] (${m.frontmatter.confidence})\n  ${(m as any).sourceLabel ? (m as any).sourceLabel + ":" : ""}${m.relativePath}`
    );

    return {
      content: [{ type: "text", text: `${result.length} memories match:\n\n${lines.join("\n\n")}` }],
    };
  }
);

// ─── Tool: gnosys_timeline ───────────────────────────────────────────────
server.tool(
  "gnosys_timeline",
  "View memory creation and modification activity over time. Shows how knowledge evolves by grouping memories into time periods.",
  {
    period: z.enum(["day", "week", "month", "year"]).optional().describe("Grouping period (default: month)"),
    projectRoot: projectRootParam,
  },
  async ({ period, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const allMemories = await ctx.resolver.getAllMemories();
    const entries = groupByPeriod(allMemories, (period as TimePeriod) || "month");

    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No memories found for timeline." }] };
    }

    const lines = entries.map(
      (e) => `**${e.period}** — ${e.created} created, ${e.modified} modified\n  ${e.titles.slice(0, 5).join(", ")}${e.titles.length > 5 ? ` (+${e.titles.length - 5} more)` : ""}`
    );

    return {
      content: [{ type: "text", text: `Knowledge Timeline (by ${period || "month"}):\n\n${lines.join("\n\n")}` }],
    };
  }
);

// ─── Tool: gnosys_stats ─────────────────────────────────────────────────
server.tool(
  "gnosys_stats",
  "Summary statistics across all memories — totals by category, status, author, authority, average confidence, and date ranges.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const allMemories = await ctx.resolver.getAllMemories();
    const stats = computeStats(allMemories);

    if (stats.totalCount === 0) {
      return { content: [{ type: "text", text: "No memories found." }] };
    }

    const catLines = Object.entries(stats.byCategory).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    const statusLines = Object.entries(stats.byStatus).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    const authorLines = Object.entries(stats.byAuthor).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    const authLines = Object.entries(stats.byAuthority).map(([k, v]) => `  ${k}: ${v}`).join("\n");

    const text = `Gnosys Memory Statistics
Total: ${stats.totalCount} memories

By Category:
${catLines}

By Status:
${statusLines}

By Author:
${authorLines}

By Authority:
${authLines}

Average Confidence: ${stats.averageConfidence.toFixed(2)}
Oldest: ${stats.oldestCreated || "—"}
Newest: ${stats.newestCreated || "—"}
Last Modified: ${stats.lastModified || "—"}`;

    return { content: [{ type: "text", text }] };
  }
);

// ─── Tool: gnosys_links ─────────────────────────────────────────────────
server.tool(
  "gnosys_links",
  "Show wikilinks for a specific memory — outgoing [[links]] and backlinks from other memories. Obsidian-compatible [[Title]] and [[path|display]] syntax.",
  {
    path: z.string().describe("Path to memory, optionally layer-prefixed"),
    projectRoot: projectRootParam,
  },
  async ({ path: memPath, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const memory = await ctx.resolver.readMemory(memPath);
    if (!memory) {
      return { content: [{ type: "text", text: `Memory not found: ${memPath}` }], isError: true };
    }

    const allMemories = await ctx.resolver.getAllMemories();
    const outgoing = getOutgoingLinks(allMemories, memory.relativePath);
    const backlinks = getBacklinks(allMemories, memory.relativePath);

    const parts: string[] = [`Links for **${memory.frontmatter.title}**:\n`];

    if (outgoing.length > 0) {
      parts.push(`Outgoing (${outgoing.length}):`);
      for (const link of outgoing) {
        const display = link.displayText ? ` (${link.displayText})` : "";
        parts.push(`  → [[${link.target}]]${display}`);
      }
    } else {
      parts.push("No outgoing links.");
    }

    parts.push("");

    if (backlinks.length > 0) {
      parts.push(`Backlinks (${backlinks.length}):`);
      for (const link of backlinks) {
        parts.push(`  ← ${link.sourceTitle} (${link.sourcePath})`);
      }
    } else {
      parts.push("No backlinks.");
    }

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ─── Tool: gnosys_graph ─────────────────────────────────────────────────
server.tool(
  "gnosys_graph",
  "Show the full cross-reference graph across all memories. Reveals clusters, orphaned links, and the most-connected memories.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const allMemories = await ctx.resolver.getAllMemories();

    if (allMemories.length === 0) {
      return { content: [{ type: "text", text: "No memories found." }] };
    }

    const graph = buildLinkGraph(allMemories);
    return { content: [{ type: "text", text: formatGraphSummary(graph) }] };
  }
);

// ─── Tool: gnosys_bootstrap ─────────────────────────────────────────────
server.tool(
  "gnosys_bootstrap",
  "Batch-import existing documents from a directory into the memory store. Scans for markdown files and creates memories. Use dry_run=true to preview.",
  {
    sourceDir: z.string().describe("Absolute path to directory containing documents to import"),
    patterns: z.array(z.string()).optional().describe("File glob patterns (default: ['**/*.md'])"),
    skipExisting: z.boolean().optional().describe("Skip files whose titles already exist (default: false)"),
    defaultCategory: z.string().optional().describe("Default category for imported files (default: imported)"),
    preserveFrontmatter: z.boolean().optional().describe("Preserve existing YAML frontmatter if present (default: false)"),
    dryRun: z.boolean().optional().describe("Preview what would be imported without writing (default: false)"),
    store: z.enum(["project", "personal", "global"]).optional().describe("Target store"),
    projectRoot: projectRootParam,
  },
  async ({ sourceDir, patterns, skipExisting, defaultCategory, preserveFrontmatter, dryRun, store: targetStore, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const writeTarget = ctx.resolver.getWriteTarget(
      (targetStore as "project" | "personal" | "global") || undefined
    );
    if (!writeTarget) {
      return { content: [{ type: "text", text: "No writable store found." }], isError: true };
    }

    try {
      const result = await bootstrap(writeTarget.store, {
        sourceDir,
        patterns,
        skipExisting,
        defaultCategory,
        preserveFrontmatter,
        dryRun,
      });

      const mode = dryRun ? "DRY RUN" : "COMPLETE";
      const parts: string[] = [
        `Bootstrap ${mode}: ${result.totalScanned} scanned, ${result.imported.length} ${dryRun ? "would be" : ""} imported, ${result.skipped.length} skipped, ${result.failed.length} failed`,
      ];

      if (result.imported.length > 0) {
        parts.push(`\n${dryRun ? "Would import" : "Imported"}:`);
        for (const f of result.imported.slice(0, 20)) {
          parts.push(`  + ${f}`);
        }
        if (result.imported.length > 20) {
          parts.push(`  ... and ${result.imported.length - 20} more`);
        }
      }

      if (result.failed.length > 0) {
        parts.push("\nFailed:");
        for (const f of result.failed.slice(0, 10)) {
          parts.push(`  ✗ ${f.path}: ${f.error}`);
        }
      }

      // Reindex after import
      if (!dryRun && result.imported.length > 0 && ctx.search) {
        await reindexAllStores();
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_import ─────────────────────────────────────────────────
server.tool(
  "gnosys_import",
  "Bulk import structured data (CSV, JSON, JSONL) into Gnosys memories. Map source fields to title/category/content/tags/relevance. Use mode='llm' for smart ingestion with keyword clouds, or 'structured' for fast direct mapping. For large datasets (>100 records with LLM), the CLI is recommended: npx gnosys-mcp import <file>",
  {
    format: z.enum(["csv", "json", "jsonl"]).describe("Data format"),
    data: z.string().describe("File path, URL, or inline data"),
    mapping: z
      .record(z.string(), z.string())
      .describe(
        "Map source fields to Gnosys fields. Keys are source field names, values are: title, category, content, tags, relevance. Example: {\"name\":\"title\", \"group\":\"category\", \"description\":\"content\"}"
      ),
    mode: z
      .enum(["llm", "structured"])
      .optional()
      .describe("Processing mode. 'llm' uses AI for keyword clouds and smart tagging (slower). 'structured' maps directly (fast). Default: structured"),
    dryRun: z.boolean().optional().describe("Preview without writing"),
    skipExisting: z.boolean().optional().describe("Skip records whose titles already exist"),
    limit: z.number().optional().describe("Max records to import"),
    offset: z.number().optional().describe("Skip first N records"),
    concurrency: z.number().optional().describe("Parallel LLM calls (default: 5)"),
    store: z
      .enum(["project", "personal", "global"])
      .optional()
      .describe("Target store (default: project)"),
    projectRoot: projectRootParam,
  },
  async ({
    format,
    data,
    mapping,
    mode,
    dryRun,
    skipExisting,
    limit,
    offset,
    concurrency,
    store: targetStore,
    projectRoot,
  }) => {
    const ctx = await resolveToolContext(projectRoot);
    const writeTarget = ctx.resolver.getWriteTarget(
      (targetStore as "project" | "personal" | "global") || undefined
    );
    if (!writeTarget) {
      return {
        content: [{ type: "text", text: "No writable store found." }],
        isError: true,
      };
    }

    if (!ingestion) {
      return {
        content: [{ type: "text", text: "Ingestion module not initialized." }],
        isError: true,
      };
    }

    const effectiveMode = (mode as "llm" | "structured") || "structured";

    try {
      const result = await performImport(writeTarget.store, ingestion, {
        format: format as "csv" | "json" | "jsonl",
        data,
        mapping: mapping as Record<string, string>,
        mode: effectiveMode,
        dryRun,
        skipExisting,
        limit,
        offset,
        concurrency,
        batchCommit: true,
      });

      // Reindex after import
      if (!dryRun && result.imported.length > 0 && search) {
        await reindexAllStores();
      }

      // v2.0: Sync imported memories to gnosys.db
      if (!dryRun && result.imported.length > 0 && gnosysDb?.isAvailable()) {
        try {
          const { migrate: migrateDb } = await import("./lib/migrate.js");
          await migrateDb(writeTarget.store.getStorePath());
        } catch {
          // Migration sync is best-effort
        }
        auditToDb(gnosysDb, "ingest", undefined, { format, count: result.imported.length, mode: effectiveMode });
      }

      let response = formatImportSummary(result);

      // Smart threshold guidance
      if (
        effectiveMode === "llm" &&
        result.totalProcessed > 100
      ) {
        const estimate = estimateDuration(
          result.totalProcessed,
          "llm",
          concurrency || 5
        );
        response += `\n\n💡 Tip: For large LLM imports, the CLI offers progress tracking and resume:\n  npx gnosys-mcp import ${data.length < 100 ? data : "<file>"} --format ${format} --mode llm --skip-existing`;
      }

      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_hybrid_search ──────────────────────────────────────────
server.tool(
  "gnosys_hybrid_search",
  "Search memories using hybrid keyword + semantic search with Reciprocal Rank Fusion. Combines FTS5 keyword matching with embedding-based semantic similarity for best results. Run gnosys_reindex first if embeddings don't exist yet.",
  {
    query: z.string().describe("Natural language search query"),
    limit: z.number().optional().describe("Max results (default 15)"),
    mode: z.enum(["keyword", "semantic", "hybrid"]).optional().describe("Search mode (default: hybrid)"),
    projectRoot: projectRootParam,
  },
  async ({ query, limit, mode, projectRoot }) => {
    // Note: hybridSearch is module-level (heavy) and not scoped per project
    (projectRoot); // quiets unused warning if any
    if (!hybridSearch) {
      return {
        content: [{ type: "text", text: "Hybrid search not initialized. No stores found." }],
        isError: true,
      };
    }

    try {
      const results = await hybridSearch.hybridSearch(
        query,
        limit || 15,
        (mode as "keyword" | "semantic" | "hybrid") || "hybrid"
      );

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results for "${query}". Try gnosys_reindex to build embeddings, or different keywords.` }],
        };
      }

      const formatted = results
        .map(
          (r) =>
            `**${r.title}** (score: ${r.score.toFixed(4)}, via: ${r.sources.join("+")})\n  Path: ${r.relativePath}\n  ${r.snippet.substring(0, 150)}...`
        )
        .join("\n\n");

      // Reinforce used memories (best-effort, non-blocking)
      // Use default resolver here since hybridSearch operates across all stores
      const writeTarget = resolver.getWriteTarget();
      if (writeTarget) {
        GnosysMaintenanceEngine.reinforceBatch(
          writeTarget.store,
          results.map((r) => r.relativePath)
        ).catch(() => {}); // Fire-and-forget
      }

      const embCount = hybridSearch.embeddingCount();
      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} results for "${query}" (${embCount} embeddings indexed):\n\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_semantic_search ────────────────────────────────────────
server.tool(
  "gnosys_semantic_search",
  "Search memories using semantic similarity only (no keyword matching). Finds conceptually related memories even without exact keyword matches. Requires embeddings — run gnosys_reindex first.",
  {
    query: z.string().describe("Natural language search query"),
    limit: z.number().optional().describe("Max results (default 15)"),
    projectRoot: projectRootParam,
  },
  async ({ query, limit, projectRoot }) => {
    // Note: hybridSearch is module-level (heavy) and not scoped per project
    (projectRoot); // quiets unused warning if any
    if (!hybridSearch) {
      return {
        content: [{ type: "text", text: "Search not initialized. No stores found." }],
        isError: true,
      };
    }

    try {
      const results = await hybridSearch.hybridSearch(query, limit || 15, "semantic");

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No semantic results for "${query}". Run gnosys_reindex first to build embeddings.` }],
        };
      }

      const formatted = results
        .map(
          (r) =>
            `**${r.title}** (similarity: ${r.score.toFixed(4)})\n  Path: ${r.relativePath}\n  ${r.snippet.substring(0, 150)}...`
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text: `Found ${results.length} semantic results for "${query}":\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Semantic search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_reindex ────────────────────────────────────────────────
server.tool(
  "gnosys_reindex",
  "Rebuild all semantic embeddings from every memory file. Downloads the embedding model (~80 MB) on first run. Required before hybrid/semantic search can be used. Safe to re-run — fully regenerates the index.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    // Note: reindex operates on all stores, projectRoot is for API consistency
    (projectRoot); // quiets unused warning if any
    if (!hybridSearch) {
      return {
        content: [{ type: "text", text: "No stores found. Initialize a store with gnosys_init first." }],
        isError: true,
      };
    }

    try {
      // Also rebuild FTS5 index
      await reindexAllStores();

      const count = await hybridSearch.reindex();
      return {
        content: [
          {
            type: "text",
            text: `Reindex complete: ${count} memories embedded. Hybrid search is now available.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Reindex failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_ask ────────────────────────────────────────────────────
server.tool(
  "gnosys_ask",
  "Ask a natural-language question and get a synthesized answer with citations from the entire vault. Uses hybrid search to find relevant memories, then LLM to synthesize a cited response. Citations are Obsidian wikilinks [[filename.md]]. Requires an LLM provider (Anthropic or Ollama) and embeddings (run gnosys_reindex first).",
  {
    question: z.string().describe("Natural language question to answer from the vault"),
    limit: z.number().optional().describe("Max memories to retrieve (default 15)"),
    mode: z.enum(["keyword", "semantic", "hybrid"]).optional().describe("Search mode (default: hybrid)"),
    projectRoot: projectRootParam,
  },
  async ({ question, limit, mode, projectRoot }) => {
    // Note: askEngine is module-level (heavy) and not scoped per project
    (projectRoot); // quiets unused warning if any
    if (!askEngine) {
      return {
        content: [{ type: "text", text: "Ask engine not initialized. Ensure stores exist and an LLM provider is configured." }],
        isError: true,
      };
    }

    try {
      const result = await askEngine.ask(question, {
        limit: limit || 15,
        mode: (mode as "keyword" | "semantic" | "hybrid") || "hybrid",
      });

      // Reinforce used memories (best-effort, non-blocking)
      const writeTarget = resolver.getWriteTarget();
      if (writeTarget && result.sources.length > 0) {
        GnosysMaintenanceEngine.reinforceBatch(
          writeTarget.store,
          result.sources.map((s) => s.relativePath)
        ).catch(() => {}); // Fire-and-forget
      }

      const sourcesText = result.sources.length > 0
        ? "\n\n---\n**Sources:**\n" +
          result.sources
            .map((s) => `- [[${s.relativePath.split("/").pop()}]] — ${s.title}`)
            .join("\n")
        : "";

      const meta = [
        `Search mode: ${result.searchMode}`,
        result.deepQueryUsed ? "Deep query: yes (follow-up search performed)" : null,
        `Sources: ${result.sources.length}`,
      ]
        .filter(Boolean)
        .join(" | ");

      return {
        content: [
          {
            type: "text",
            text: `${result.answer}${sourcesText}\n\n_${meta}_`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Ask failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_maintain ────────────────────────────────────────────────
server.tool(
  "gnosys_maintain",
  "Run vault maintenance: detect duplicate memories, apply confidence decay, consolidate similar memories. Use --dry-run mode first to see what would change. Requires embeddings (run gnosys_reindex first).",
  {
    dryRun: z.boolean().optional().describe("Show what would change without modifying anything (default: true)"),
    autoApply: z.boolean().optional().describe("Automatically apply all changes (default: false)"),
    projectRoot: projectRootParam,
  },
  async ({ dryRun, autoApply, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    try {
      const engine = new GnosysMaintenanceEngine(ctx.resolver, ctx.config);
      const report = await engine.maintain({
        dryRun: dryRun ?? true,
        autoApply: autoApply ?? false,
      });

      // v2.0: Log maintenance run to gnosys.db
      if (ctx.gnosysDb?.isAvailable()) {
        auditToDb(ctx.gnosysDb, "maintain", undefined, {
          dryRun: dryRun ?? true,
          duplicatesFound: report.duplicates?.length || 0,
          consolidated: report.consolidated || 0,
        });
      }

      return {
        content: [{ type: "text", text: formatMaintenanceReport(report) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Maintenance failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_dearchive ──────────────────────────────────────────────
server.tool(
  "gnosys_dearchive",
  "Force-dearchive memories from archive.db back to active. Search the archive for memories matching a query, then restore them to the active layer. Used when you need specific archived knowledge that wasn't auto-dearchived by search/ask.",
  {
    query: z.string().describe("Search query to find archived memories to restore"),
    limit: z.number().optional().describe("Max memories to dearchive (default 5)"),
    projectRoot: projectRootParam,
  },
  async ({ query, limit, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    try {
      const { GnosysArchive } = await import("./lib/archive.js");

      const writeTarget = ctx.resolver.getWriteTarget();
      if (!writeTarget) {
        return {
          content: [{ type: "text", text: "No writable store found. Run gnosys_init first." }],
          isError: true,
        };
      }

      const archive = new GnosysArchive(writeTarget.path);
      if (!archive.isAvailable()) {
        return {
          content: [{ type: "text", text: "Archive not available. Is better-sqlite3 installed?" }],
          isError: true,
        };
      }

      const results = archive.searchArchive(query, limit || 5);
      if (results.length === 0) {
        archive.close();
        return {
          content: [{ type: "text", text: `No archived memories found matching "${query}".` }],
        };
      }

      const ids = results.map((r) => r.id);
      const restored = await archive.dearchiveBatch(ids, writeTarget.store);
      archive.close();

      // v2.0: Sync dearchive to gnosys.db
      if (ctx.gnosysDb?.isAvailable()) {
        for (const memId of ids) {
          syncDearchiveToDb(ctx.gnosysDb, memId);
        }
        auditToDb(ctx.gnosysDb, "dearchive", undefined, { query, count: restored.length });
      }

      const lines = [`Dearchived ${restored.length} memories back to active:`];
      for (const rp of restored) {
        lines.push(`  → ${rp}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Dearchive failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_reindex_graph ──────────────────────────────────────────
server.tool(
  "gnosys_reindex_graph",
  "Build or rebuild the wikilink graph (.gnosys/graph.json). Parses all [[wikilinks]] across memories and generates a persistent JSON graph with nodes, edges, and stats.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    try {
      const { reindexGraph, formatGraphStats } = await import("./lib/graph.js");
      const stats = await reindexGraph(ctx.resolver);
      return {
        content: [{ type: "text", text: formatGraphStats(stats) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Graph reindex failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_dream ──────────────────────────────────────────────────
server.tool(
  "gnosys_dream",
  "Run a Dream Mode cycle — idle-time consolidation that decays confidence, generates category summaries, discovers relationships, and creates review suggestions. NEVER deletes memories. Safe to run anytime.",
  {
    maxRuntimeMinutes: z.number().int().min(1).max(120).default(30).optional().describe("Max runtime in minutes"),
    selfCritique: z.boolean().default(true).optional().describe("Enable self-critique scoring"),
    generateSummaries: z.boolean().default(true).optional().describe("Generate category summaries"),
    discoverRelationships: z.boolean().default(true).optional().describe("Discover relationships between memories"),
    projectRoot: projectRootParam,
  },
  async (params) => {
    const ctx = await resolveToolContext(params.projectRoot);
    if (!ctx.gnosysDb || !ctx.gnosysDb.isAvailable() || !ctx.gnosysDb.isMigrated()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Dream Mode requires gnosys.db (v2.0). Run `gnosys migrate` first.",
          },
        ],
      };
    }

    // Record activity to reset idle timer (if scheduler is running)
    dreamScheduler?.recordActivity();

    const dreamConfig = {
      enabled: true,
      idleMinutes: 0, // Run immediately (manual trigger)
      maxRuntimeMinutes: params.maxRuntimeMinutes ?? 30,
      selfCritique: params.selfCritique ?? true,
      generateSummaries: params.generateSummaries ?? true,
      discoverRelationships: params.discoverRelationships ?? true,
      minMemories: 1, // No minimum for manual trigger
      provider: ctx.config?.dream?.provider || ("ollama" as const),
      model: ctx.config?.dream?.model,
    };

    const engine = new GnosysDreamEngine(ctx.gnosysDb, ctx.config || DEFAULT_CONFIG, dreamConfig);
    const report = await engine.dream((phase, detail) => {
      console.error(`[dream:${phase}] ${detail}`);
    });

    return {
      content: [
        {
          type: "text" as const,
          text: formatDreamReport(report),
        },
      ],
    };
  }
);

// ─── Tool: gnosys_export ─────────────────────────────────────────────────
server.tool(
  "gnosys_export",
  "Export gnosys.db to Obsidian-compatible vault — atomic Markdown files with YAML frontmatter, [[wikilinks]], category summaries, and relationship graph. One-way export, never modifies gnosys.db.",
  {
    targetDir: z.string().describe("Target directory path for export"),
    activeOnly: z.boolean().default(true).optional().describe("Only export active memories (default: true)"),
    overwrite: z.boolean().default(false).optional().describe("Overwrite existing files"),
    includeSummaries: z.boolean().default(true).optional().describe("Include category summaries"),
    includeReviews: z.boolean().default(true).optional().describe("Include review suggestions from dream mode"),
    includeGraph: z.boolean().default(true).optional().describe("Include relationship graph"),
    projectRoot: projectRootParam,
  },
  async (params) => {
    const ctx = await resolveToolContext(params.projectRoot);
    if (!ctx.gnosysDb || !ctx.gnosysDb.isAvailable() || !ctx.gnosysDb.isMigrated()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Export requires gnosys.db (v2.0). Run `gnosys migrate` first.",
          },
        ],
      };
    }

    const exporter = new GnosysExporter(ctx.gnosysDb);
    const report = await exporter.export({
      targetDir: params.targetDir,
      activeOnly: params.activeOnly ?? true,
      overwrite: params.overwrite ?? false,
      includeSummaries: params.includeSummaries ?? true,
      includeReviews: params.includeReviews ?? true,
      includeGraph: params.includeGraph ?? true,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: formatExportReport(report),
        },
      ],
    };
  }
);

// ─── Tool: gnosys_dashboard ──────────────────────────────────────────────
server.tool(
  "gnosys_dashboard",
  "Show the Gnosys system dashboard: memory counts, maintenance health, graph stats, LLM provider status. Returns structured JSON.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    try {
      const { collectDashboardData, formatDashboardJSON } = await import("./lib/dashboard.js");
      const data = await collectDashboardData(ctx.resolver, ctx.config, "1.1.0", ctx.gnosysDb || undefined);
      return {
        content: [{ type: "text", text: formatDashboardJSON(data) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Dashboard failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_stores ─────────────────────────────────────────────────
server.tool(
  "gnosys_stores",
  "Debug tool — lists all detected Gnosys stores across registered projects, MCP workspace roots, cwd, and environment variables. Shows which store is active and helps diagnose multi-project routing.",
  {},
  async () => {
    const lines: string[] = [];

    lines.push("GNOSYS STORES — Multi-Project Overview");
    lines.push("=".repeat(45));
    lines.push("");

    // Active stores
    lines.push("ACTIVE STORES:");
    lines.push(resolver.getSummary());
    lines.push("");

    // MCP roots
    const mcpRoots = GnosysResolver.getMcpRoots();
    lines.push(`MCP WORKSPACE ROOTS (${mcpRoots.length}):`);
    if (mcpRoots.length === 0) {
      lines.push("  (none — host may not support roots/list)");
    } else {
      for (const root of mcpRoots) {
        lines.push(`  ${root}`);
      }
    }
    lines.push("");

    // All detected stores
    const detected = await resolver.detectAllStores();
    lines.push(`ALL DETECTED STORES (${detected.length}):`);
    for (const d of detected) {
      const status = d.isActive ? "✓ ACTIVE" : d.hasGnosys ? "available" : "no .gnosys";
      lines.push(`  [${d.source}] ${d.path} — ${status}`);
    }
    lines.push("");

    // Usage hint
    lines.push("USAGE:");
    lines.push("  Pass projectRoot to any tool to target a specific project:");
    lines.push('  e.g. gnosys_add({ projectRoot: "/path/to/my-project", ... })');

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Helper: reindex search across all stores ────────────────────────────
async function reindexAllStores(): Promise<void> {
  if (!search) return;
  search.clearIndex();
  const allStores = resolver.getStores();
  for (const s of allStores) {
    await search.addStoreMemories(s.store, s.label);
  }
}

// ─── Resource: gnosys://recall (AUTOMATIC MEMORY INJECTION) ────────────
// This is the primary recall mechanism. MCP hosts (Cursor, Claude Desktop,
// Claude Code, Cowork) read this resource on every turn, automatically
// injecting relevant memories into the model context — no tool call needed.
//
// Priority 1 + audience: assistant = hosts inject this before every message.
server.resource(
  "gnosys_recall",
  "gnosys://recall",
  {
    description:
      "Automatic memory injection. Hosts read this resource on every turn to inject the most relevant memories as context. Returns a <gnosys-recall> block with [[wikilinks]] and relevance scores. Priority 1 (highest) — designed for always-on context injection without any tool call. Configure aggressiveness in gnosys.json: recall.aggressive (default: true).",
    mimeType: "text/markdown",
    annotations: {
      audience: ["assistant"],
      priority: 1, // Highest priority — always inject
    },
  },
  async () => {
    // Record activity for dream scheduler (this fires on every turn)
    dreamScheduler?.recordActivity();

    if (!search) {
      return {
        contents: [
          {
            uri: "gnosys://recall",
            mimeType: "text/markdown",
            text: "<gnosys: no-strong-recall-needed>",
          },
        ],
      };
    }

    const storePath = resolver.getWriteTarget()?.store.getStorePath() || "";
    const result = await recall("*", {
      limit: config.recall?.maxMemories || 8,
      search,
      resolver,
      storePath,
      recallConfig: config.recall,
      gnosysDb: gnosysDb || undefined,
    });

    return {
      contents: [
        {
          uri: "gnosys://recall",
          mimeType: "text/markdown",
          text: formatRecall(result),
        },
      ],
    };
  }
);

// ─── Tool: gnosys_recall (query-specific fallback) ──────────────────────
// For hosts that don't support MCP Resources, or when the agent wants to
// recall memories for a specific query. The resource above is preferred.
server.tool(
  "gnosys_recall",
  "Fast memory recall — inject relevant memories as context. Returns <gnosys-recall> block. In aggressive mode (default), always returns top memories even at medium relevance. Prefer the gnosys://recall MCP Resource for automatic injection (no tool call needed).",
  {
    query: z
      .string()
      .describe(
        "What the agent is currently working on. Use keywords. Example: 'auth JWT middleware' or 'database migration schema'"
      ),
    limit: z.number().optional().describe("Max memories to return (default from config, max 15)"),
    traceId: z.string().optional().describe("Optional trace ID from the outer orchestrator for audit correlation"),
    aggressive: z.boolean().optional().describe("Override aggressive mode for this call. Default: from gnosys.json (true)"),
    projectRoot: projectRootParam,
  },
  async ({ query, limit, traceId, aggressive, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    if (!ctx.search) {
      return {
        content: [{ type: "text" as const, text: "<gnosys: no-strong-recall-needed>" }],
      };
    }

    const storePath = ctx.resolver.getWriteTarget()?.store.getStorePath() || "";
    const recallConfig = {
      ...ctx.config.recall,
      ...(aggressive !== undefined ? { aggressive } : {}),
    };

    const result = await recall(query, {
      limit: Math.min(limit || recallConfig.maxMemories, 15),
      search: ctx.search,
      resolver: ctx.resolver,
      storePath,
      traceId,
      recallConfig,
      gnosysDb: ctx.gnosysDb || undefined,
    });

    return {
      content: [{ type: "text" as const, text: formatRecall(result) }],
    };
  }
);

// ─── Tool: gnosys_audit ──────────────────────────────────────────────────
server.tool(
  "gnosys_audit",
  "View the audit trail of all memory operations (reads, writes, reinforcements, dearchives, maintenance). Shows a timeline of what happened and when. Useful for debugging 'why did the agent forget X?'",
  {
    days: z.number().optional().describe("Number of days to look back (default 7)"),
    operation: z.string().optional().describe("Filter by operation type: read, write, reinforce, dearchive, archive, maintain, search, ask, recall"),
    limit: z.number().optional().describe("Max entries to return (default 100)"),
    projectRoot: projectRootParam,
  },
  async ({ days, operation, limit, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    const storePath = ctx.resolver.getWriteTarget()?.store.getStorePath();
    if (!storePath) {
      return {
        content: [{ type: "text" as const, text: "No store found." }],
        isError: true,
      };
    }

    const entries = readAuditLog(storePath, {
      days: days || 7,
      operation: operation as any,
      limit: limit || 100,
    });

    return {
      content: [{ type: "text" as const, text: formatAuditTimeline(entries) }],
    };
  }
);

// ─── Start the server ────────────────────────────────────────────────────
async function main() {
  // v3.0: Initialize central DB at ~/.gnosys/gnosys.db
  try {
    centralDb = GnosysDB.openCentral();
    if (centralDb.isAvailable()) {
      const projects = centralDb.getAllProjects();
      console.error(`Central DB: ready ✓ (${projects.length} projects registered, schema v${centralDb.getSchemaVersion()})`);
    } else {
      centralDb = null;
      console.error("Central DB: not available (better-sqlite3 missing)");
    }
  } catch (err) {
    centralDb = null;
    console.error(`Central DB: initialization failed — ${err instanceof Error ? err.message : err}`);
  }

  // Discover and initialize all layered stores
  const stores = await resolver.resolve();

  if (stores.length === 0) {
    console.error(
      "Warning: No Gnosys stores found. Create a .gnosys/ directory or set GNOSYS_PERSONAL / GNOSYS_GLOBAL."
    );
  }

  console.error("Gnosys MCP server starting.");
  console.error("Active stores:");
  console.error(resolver.getSummary());

  // Initialize search from the first writable store
  const writeTarget = resolver.getWriteTarget();
  if (writeTarget) {
    search = new GnosysSearch(writeTarget.store.getStorePath());
    tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
    await tagRegistry.load();
    // Load config from the primary store
    try {
      config = await loadConfig(writeTarget.store.getStorePath());
    } catch (err) {
      console.error(`Warning: Failed to load gnosys.json: ${err instanceof Error ? err.message : err}`);
    }
    ingestion = new GnosysIngestion(writeTarget.store, tagRegistry, config);

    // Initialize audit logging
    initAudit(writeTarget.store.getStorePath());

    // Build search index across all stores
    await reindexAllStores();

    // v2.0: Initialize GnosysDB (unified SQLite store)
    try {
      gnosysDb = new GnosysDB(writeTarget.store.getStorePath());
      if (gnosysDb.isAvailable() && gnosysDb.isMigrated()) {
        const counts = gnosysDb.getMemoryCount();
        console.error(
          `GnosysDB: migrated ✓ (${counts.active} active, ${counts.archived} archived, schema v${gnosysDb.getSchemaVersion()})`
        );
      } else if (gnosysDb.isAvailable()) {
        console.error(
          "GnosysDB: available but not migrated. Run `gnosys migrate` to populate."
        );
      } else {
        gnosysDb = null;
        console.error("GnosysDB: not available (better-sqlite3 missing)");
      }
    } catch {
      gnosysDb = null;
      console.error("GnosysDB: initialization failed — using legacy paths");
    }

    // Initialize hybrid search + ask engine (embeddings loaded lazily)
    const embeddings = new GnosysEmbeddings(writeTarget.store.getStorePath());
    hybridSearch = new GnosysHybridSearch(
      search, embeddings, resolver, writeTarget.store.getStorePath(),
      gnosysDb || undefined
    );
    askEngine = new GnosysAsk(hybridSearch, config, resolver, writeTarget.store.getStorePath());

    const embCount = embeddings.hasEmbeddings() ? embeddings.count() : 0;
    console.error(
      `LLM ingestion: ${ingestion.isLLMAvailable ? `enabled (${ingestion.providerName})` : "disabled (configure LLM provider)"}`
    );
    console.error(
      `Hybrid search: ${embCount > 0 ? `ready (${embCount} embeddings)` : "available (run gnosys_reindex to build embeddings)"}`
    );
    console.error(
      `Ask engine: ${askEngine.isLLMAvailable ? `ready (${askEngine.providerName}/${askEngine.modelName})` : "disabled (configure LLM provider)"}`
    );

    // v2.0: Initialize Dream Mode (idle-time consolidation)
    if (gnosysDb && config.dream?.enabled) {
      const dreamEngine = new GnosysDreamEngine(gnosysDb, config, config.dream);
      dreamScheduler = new DreamScheduler(dreamEngine, config.dream);
      dreamScheduler.start();
      console.error(
        `Dream Mode: enabled (idle ${config.dream.idleMinutes}min, max ${config.dream.maxRuntimeMinutes}min)`
      );
    } else {
      console.error(
        `Dream Mode: disabled (enable in gnosys.json: dream.enabled = true)`
      );
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ─── MCP Roots Support (multi-project awareness) ───────────────────────
  // After connecting, request workspace roots from the host. This lets us
  // discover .gnosys stores in all open projects, not just the cwd.
  try {
    const rootsResult = await server.server.listRoots();
    if (rootsResult.roots && rootsResult.roots.length > 0) {
      GnosysResolver.setMcpRoots(rootsResult.roots);
      console.error(`MCP roots: ${rootsResult.roots.map((r) => r.name || r.uri).join(", ")}`);
    }
  } catch {
    // Host doesn't support roots/list — that's fine, fall back to cwd
    console.error("MCP roots: not supported by host (using cwd fallback)");
  }

  // Listen for roots changes (e.g. user opens/closes folders)
  try {
    const { RootsListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    server.server.setNotificationHandler(
      RootsListChangedNotificationSchema,
      async () => {
        try {
          const updated = await server.server.listRoots();
          if (updated.roots) {
            GnosysResolver.setMcpRoots(updated.roots);
            console.error(`MCP roots updated: ${updated.roots.map((r) => r.name || r.uri).join(", ")}`);
          }
        } catch {
          // Ignore errors during roots refresh
        }
      }
    );
  } catch {
    // Notification handler setup failed — non-critical
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
