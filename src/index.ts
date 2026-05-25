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
import { fileURLToPath } from "url";
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

// v5.7.1 (#15): read our running version so the upgrade-marker watcher
// can detect when a newer global install lands and exit for client respawn.
const __filenameMcp = fileURLToPath(import.meta.url);
const __dirnameMcp = path.dirname(__filenameMcp);
const RUNNING_VERSION: string = (() => {
  try {
    const raw = readFileSync(path.resolve(__dirnameMcp, "..", "package.json"), "utf8");
    return (JSON.parse(raw).version as string) || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import { MemoryFrontmatter } from "./lib/store.js";
import { GnosysSearch } from "./lib/search.js";
import { GnosysTagRegistry } from "./lib/tags.js";
import { GnosysResolver } from "./lib/resolver.js";
import { applyLens, LensFilter } from "./lib/lensing.js";
import { groupByPeriod, computeStats, TimePeriod } from "./lib/timeline.js";
import { buildLinkGraph, getBacklinks, getOutgoingLinks, formatGraphSummary } from "./lib/wikilinks.js";
import { loadConfig, GnosysConfig, DEFAULT_CONFIG } from "./lib/config.js";
import { getLLMProvider, isProviderAvailable, LLMProvider } from "./lib/llm.js";
import { recall, formatRecall, formatRecallCLI } from "./lib/recall.js";
import { initAudit, readAuditLog, formatAuditTimeline } from "./lib/audit.js";
import { GnosysDB } from "./lib/db.js";
import { syncMemoryToDb, syncUpdateToDb, syncArchiveToDb, syncDearchiveToDb, syncReinforcementToDb, auditToDb } from "./lib/dbWrite.js";
import { createProjectIdentity, readProjectIdentity, findProjectIdentity, checkDirectoryMismatch } from "./lib/projectIdentity.js";
import { setPreference, getPreference, getAllPreferences, deletePreference, Preference, KNOWN_PREFERENCE_KEYS, suggestPreferenceKey } from "./lib/preferences.js";
import { syncRules, generateRulesBlock, removeRulesBlock } from "./lib/rulesGen.js";
import { federatedSearch, federatedDiscover, detectAmbiguity, generateBriefing, generateAllBriefings, getWorkingSet, formatWorkingSet, detectCurrentProject } from "./lib/federated.js";
import { generatePortfolio, formatPortfolioCompact, formatPortfolioMarkdown, generateStatusPrompt } from "./lib/portfolio.js";

// v5.9.1 (#100): heavy modules — pulled in via dynamic import() inside the
// handlers that actually use them, so the MCP server's cold-start doesn't
// pay the ~3-25s import cost for @huggingface/transformers, mammoth,
// pdf-parse, etc. These are type-only imports — zero runtime cost.
import type { GnosysIngestion } from "./lib/ingest.js";
import type { GnosysEmbeddings } from "./lib/embeddings.js";
import type { GnosysHybridSearch } from "./lib/hybridSearch.js";
import type { GnosysAsk } from "./lib/ask.js";
import type { GnosysDreamEngine, DreamScheduler } from "./lib/dream.js";

// Initialize resolver (discovers all layered stores)
const resolver = new GnosysResolver();
let config: GnosysConfig = DEFAULT_CONFIG;

// Create MCP server
const server = new McpServer({
  name: "gnosys",
  version: "2.0.0",
});

// v5.12: capability registrations (tool/prompt/resource) are collected as
// replayable thunks so a fresh McpServer can be built per HTTP session, while
// stdio keeps reusing the singleton `server`. Handlers reference module-global
// state (the shared brain/search/resolver), so sessions need no per-client
// state — only the registrations are replayed. See registerCapabilities().
type Registrar = (s: McpServer) => void;
const _registrations: Registrar[] = [];
// Typed to the McpServer methods so call-site generic inference (Zod schema →
// handler arg types) is preserved; the body just collects a replay thunk.
const regTool: typeof server.tool = ((...args: unknown[]) => {
  _registrations.push((s) => (s.tool as (...a: unknown[]) => unknown)(...args));
}) as typeof server.tool;
const regPrompt: typeof server.prompt = ((...args: unknown[]) => {
  _registrations.push((s) => (s.prompt as (...a: unknown[]) => unknown)(...args));
}) as typeof server.prompt;
const regResource: typeof server.resource = ((...args: unknown[]) => {
  _registrations.push((s) => (s.resource as (...a: unknown[]) => unknown)(...args));
}) as typeof server.resource;
/** Replay all collected capability registrations onto a server instance. */
export function registerCapabilities(s: McpServer): void {
  for (const r of _registrations) r(s);
}

/**
 * v5.4.1: Format MCP errors. Detects DB corruption and replaces the raw
 * "database disk image is malformed" with actionable recovery instructions.
 * Use this in catch blocks instead of inlining error.message.
 */
function formatMcpError(action: string, err: unknown): string {
  if (GnosysDB.isCorruptionError(err)) {
    return `Error ${action}: ${err instanceof Error ? err.message : String(err)}\n\n${GnosysDB.corruptionRecoveryInstructions()}`;
  }
  return `Error ${action}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * v5.7.1 (#15): poll `~/.gnosys/last-upgrade-at` and exit when a newer
 * version has been installed. The MCP client (Claude Code, Cursor, etc.)
 * sees the clean exit and respawns the process, which then runs the new
 * global binary.
 *
 * The 10s cadence is a deliberate trade-off: latency is small, the FS
 * check is one stat (~µs), and an upgrade that landed mid-session gets
 * picked up before the next agent turn in almost every case.
 */
function startUpgradeMarkerWatcher(): void {
  const check = async () => {
    try {
      const { shouldRestartMcp, readUpgradeMarker } = await import("./lib/upgrade.js");
      if (shouldRestartMcp(RUNNING_VERSION)) {
        const marker = readUpgradeMarker();
        const newVersion = marker?.version || "newer";
        console.error(
          `gnosys MCP: upgrading from v${RUNNING_VERSION} → v${newVersion} — restarting`,
        );
        // Clean exit so the MCP host respawns us against the upgraded binary.
        process.exit(0);
      }
    } catch {
      // Stat failed — non-critical. Try again on the next tick.
    }
  };
  // Immediate boot-time check, then poll.
  void check();
  const timer = setInterval(() => void check(), 10_000);
  // Don't block process exit on this timer.
  timer.unref();
}

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

    // v5.2: No local project DB — central DB is sole source of truth.
    // Removed: new GnosysDB(scopedStorePath) which created an empty
    // gnosys.db in the project's .gnosys/ directory.
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

/**
 * v5.7.1 (#13): Resolve scope + projectId for a memory write.
 *
 * Previously every write was hard-coded to scope="project" with whatever
 * `ctx.projectId` happened to resolve to — including null. That produced
 * "project-scope, no project" orphans visible cross-project.
 *
 * Now: derive scope from the explicit `store` argument and refuse to
 * create a project-scoped memory when no project identity is reachable,
 * telling the caller exactly how to fix it.
 */
function resolveWriteScope(
  ctx: ToolContext,
  targetStore: "project" | "personal" | "global" | undefined,
):
  | { ok: true; scope: "project" | "personal" | "global"; projectId: string | null }
  | { ok: false; error: string } {
  const scope = targetStore || "project";
  if (scope === "global" || scope === "personal") {
    return { ok: true, scope, projectId: null };
  }
  if (!ctx.projectId) {
    return {
      ok: false,
      error: [
        "Cannot write a project-scoped memory: no project identity is reachable.",
        "",
        "Pick one:",
        "  • Pass projectRoot=<path-to-project> to anchor this memory to that project",
        "  • Pass store='global' to write to shared org knowledge",
        "  • Pass store='personal' for cross-project personal notes",
        "  • Run gnosys_init in the target directory to register it as a project",
      ].join("\n"),
    };
  }
  return { ok: true, scope: "project", projectId: ctx.projectId };
}

// ─── Tool: gnosys_discover ──────────────────────────────────────────────
regTool(
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
    if (ctx.centralDb?.isAvailable() && ctx.centralDb?.isMigrated()) {
      const results = ctx.centralDb.discoverFts(query, limit || 20);
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
regTool(
  "gnosys_read",
  "Read a specific memory. Accepts a memory ID (e.g., 'arch-012') or layer-prefixed path (e.g., 'project:decisions/why-not-rag.md'). Without a prefix, searches all stores in precedence order.",
  {
    path: z.string().describe("Memory ID or path, optionally prefixed with store layer"),
    projectRoot: projectRootParam,
  },
  async ({ path: memPath, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    // v2.0 DB-backed fast path: try reading by memory ID from gnosys.db first
    if (ctx.centralDb?.isAvailable() && ctx.centralDb?.isMigrated()) {
      const dbMem = ctx.centralDb.getMemory(memPath);
      if (dbMem) {
        const tags = dbMem.tags || "[]";
        const headerLines = [
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
        ];
        if (dbMem.source_file) {
          headerLines.push(
            `source_file: ${dbMem.source_file}${dbMem.source_page != null ? ` (page ${Number(dbMem.source_page)})` : ""}`,
          );
        }
        if (dbMem.source_path) headerLines.push(`source_path: ${dbMem.source_path}`);
        headerLines.push(`---`);
        const header = headerLines.join("\n");
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

    let raw: string;
    try {
      raw = await fs.readFile(memory.filePath, "utf-8");
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("reading memory", err) }], isError: true };
    }
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
regTool(
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
    if (ctx.centralDb?.isAvailable() && ctx.centralDb?.isMigrated()) {
      const results = ctx.centralDb.searchFts(query, limit || 20);
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
regTool(
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

    // DB-first: read from central DB instead of scanning markdown files
    const db = ctx.centralDb;
    if (db?.isAvailable()) {
      let dbMemories = status === "active" || !status
        ? db.getActiveMemories()
        : db.getAllMemories();

      // Apply filters on DB results
      if (status && status !== "active") {
        dbMemories = dbMemories.filter((m) => m.status === status);
      }
      if (storeFilter) {
        dbMemories = dbMemories.filter((m) => m.scope === storeFilter);
      }
      if (category) {
        dbMemories = dbMemories.filter((m) => m.category === category);
      }
      if (tag) {
        dbMemories = dbMemories.filter((m) => {
          try {
            const parsed = JSON.parse(m.tags || "[]");
            const tagList: string[] = Array.isArray(parsed)
              ? parsed
              : Object.values(parsed).flat() as string[];
            return tagList.includes(tag);
          } catch {
            return false;
          }
        });
      }
      // Filter by project if we have a project ID (so scoped queries only see their project)
      if (ctx.projectId && !storeFilter) {
        dbMemories = dbMemories.filter((m) => m.project_id === ctx.projectId || m.scope !== "project");
      }

      const lines = dbMemories.map(
        (m) => `- [${m.scope}] **${m.title}** (${m.category}/${m.id}) [${m.status}]`
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

    // Fallback: read from markdown files if central DB unavailable
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
regTool(
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

    // v5.9.1 (#100): ingestion is constructed in the background after
    // server.connect() responds to the MCP handshake. Wait for that to
    // finish before proceeding — first call after a fresh MCP spawn
    // may pause here briefly.
    await ensureHeavyDeps();
    if (!ingestion) {
      return {
        content: [
          { type: "text", text: "Ingestion module not initialized." },
        ],
        isError: true,
      };
    }

    try {
      // v5.8.0 (#8): pass per-call config so the LLM provider resolves against
      // the merged project+global config, not the MCP's boot-time config.
      const result = await ingestion.ingest(input, ctx.config);
      if (!ctx.centralDb?.isAvailable()) {
        return {
          content: [{ type: "text", text: "Database not available. Cannot write memory." }],
          isError: true,
        };
      }

      // v5.7.1 (#13): determine scope/projectId before writing
      const scopeResult = resolveWriteScope(
        ctx,
        targetStore as "project" | "personal" | "global" | undefined,
      );
      if (!scopeResult.ok) {
        return { content: [{ type: "text", text: scopeResult.error }], isError: true };
      }

      const id = ctx.centralDb.getNextId(result.category, scopeResult.projectId ?? undefined);

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

      const content = `# ${result.title}\n\n${result.content}`;

      // Write to DB only (SQLite is sole source of truth)
      syncMemoryToDb(
        ctx.centralDb,
        frontmatter,
        content,
        undefined,
        scopeResult.projectId,
        scopeResult.scope,
      );
      auditToDb(ctx.centralDb, "write", id, { tool: "gnosys_add", category: result.category });

      // Rebuild search index across all stores
      if (ctx.search) {
        await reindexAllStores();
      }

      let response = `Memory added to [${writeTarget.label}]: **${result.title}**\nID: ${id}\nCategory: ${result.category}\nConfidence: ${result.confidence}`;

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
          (r) => r.title !== result.title
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
        content: [{ type: "text", text: formatMcpError("adding memory", err) }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_add_structured ─────────────────────────────────────────
regTool(
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
    try {
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

      if (!ctx.centralDb?.isAvailable()) {
        return {
          content: [{ type: "text", text: "Database not available. Cannot write memory." }],
          isError: true,
        };
      }

      // v5.7.1 (#13): determine scope/projectId before writing
      const scopeResult = resolveWriteScope(
        ctx,
        targetStore as "project" | "personal" | "global" | undefined,
      );
      if (!scopeResult.ok) {
        return { content: [{ type: "text", text: scopeResult.error }], isError: true };
      }

      const id = ctx.centralDb.getNextId(category, scopeResult.projectId ?? undefined);

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

      // Write to DB only (SQLite is sole source of truth)
      syncMemoryToDb(
        ctx.centralDb,
        frontmatter,
        fullContent,
        undefined,
        scopeResult.projectId,
        scopeResult.scope,
      );
      auditToDb(ctx.centralDb, "write", id, { tool: "gnosys_add_structured", category });

      if (ctx.search) await reindexAllStores();

      return {
        content: [
          {
            type: "text",
            text: `Memory added to [${writeTarget.label}]: **${title}**\nID: ${id}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: formatMcpError("adding structured memory", err) }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_tags ───────────────────────────────────────────────────
regTool(
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
regTool(
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
regTool(
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
    try {
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
        if (sourceStore) {
          const count = (memory.frontmatter.reinforcement_count || 0) + 1;

          // Write reinforcement to DB only (SQLite is sole source of truth)
          if (ctx.centralDb?.isAvailable()) {
            syncReinforcementToDb(ctx.centralDb, memory_id, count);
            auditToDb(ctx.centralDb, "reinforce", memory_id, { signal, context });
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
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("reinforcing memory", err) }], isError: true };
    }
  }
);

// ─── Tool: gnosys_init ───────────────────────────────────────────────────
regTool(
  "gnosys_init",
  "Initialize Gnosys in a project directory. Creates .gnosys/ with project identity (gnosys.json), registers the project in the central DB (~/.gnosys/gnosys.db), and sets up tag registry. You MUST run this before any other Gnosys tool in a new project. Pass the full absolute path to the project root.",
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
      // Create directory structure (DB is sole source of truth — no category folders or changelog)
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
      const { GnosysIngestion } = await import("./lib/ingest.js");
      ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);
      await reindexAllStores();
    }

    // Configure IDE hooks for automatic memory recall
    const { configureIdeHooks } = await import("./lib/projectIdentity.js");
    const hookResult = await configureIdeHooks(targetDir);

    const action = isResync ? "re-synced" : "initialized";
    const hookInfo = hookResult.configured
      ? `\n\nIDE Hooks (${hookResult.ide}):\n- ${hookResult.details}\n- File: ${hookResult.filePath}`
      : `\n\nIDE hooks: ${hookResult.details}`;

    return {
      content: [
        {
          type: "text",
          text: `Gnosys store ${action} at ${storePath}\n\nProject Identity:\n- ID: ${identity.projectId}\n- Name: ${identity.projectName}\n- Directory: ${identity.workingDirectory}\n- Agent rules target: ${identity.agentRulesTarget || "none detected"}\n- Central DB: ${centralDb?.isAvailable() ? "registered ✓" : "not available"}\n\n${isResync ? "Identity re-synced." : "Created:\n- gnosys.json (project identity)\n- .config/ (internal config)\n- tags.json (tag registry)"}${hookInfo}\n\nThe store is ready. Use gnosys_discover to find existing memories or gnosys_add to create new ones.`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_migrate ────────────────────────────────────────────────
regTool(
  "gnosys_migrate",
  "Migrate a Gnosys store (.gnosys/) from one directory to another. Updates the project name, working directory, and central DB registration. Use this when a project has moved or you want to consolidate stores.",
  {
    sourcePath: z.string().describe("Directory that currently contains .gnosys/ (absolute path)"),
    targetPath: z.string().describe("Directory to move .gnosys/ into (absolute path)"),
    newName: z.string().optional().describe("New project name (default: basename of target directory)"),
    syncMemories: z.boolean().optional().default(false).describe("Sync markdown memories into central DB after migration"),
    deleteOld: z.boolean().optional().default(false).describe("Delete the old .gnosys/ directory after successful migration"),
  },
  async ({ sourcePath, targetPath, newName, syncMemories, deleteOld }) => {
    try {
      const { migrateProject } = await import("./lib/projectIdentity.js");

      const result = await migrateProject({
        sourcePath,
        targetPath,
        newName,
        deleteSource: deleteOld,
        centralDb: centralDb || undefined,
      });

      const resolvedTargetPath = path.resolve(targetPath);
      const newStorePath = path.join(resolvedTargetPath, ".gnosys");

      let summary = `Migration complete!\n\n`;
      summary += `Project: ${result.oldIdentity.projectName} → ${result.newIdentity.projectName}\n`;
      summary += `Path: ${result.oldIdentity.workingDirectory} → ${result.newIdentity.workingDirectory}\n`;
      summary += `Memory files: ${result.memoryFileCount}\n`;
      summary += `Central DB: ${centralDb?.isAvailable() ? "updated ✓" : "not available"}`;

      // Sync memories to central DB if requested
      if (syncMemories && centralDb?.isAvailable()) {
        const matter = (await import("gray-matter")).default;
        const { syncMemoryToDb } = await import("./lib/dbWrite.js");
        const { glob } = await import("glob");

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
                parsed.data as MemoryFrontmatter,
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

        summary += `\n\nSynced ${synced} memories to central DB.`;
      }

      if (deleteOld) {
        summary += `\n\nOld .gnosys/ at ${sourcePath} has been removed.`;
      }

      // Add the new store location to the resolver so future tool calls find it
      await resolver.registerProject(resolvedTargetPath);
      await resolver.addProjectStore(newStorePath);

      const writeTarget = resolver.getWriteTarget();
      if (writeTarget) {
        search = new GnosysSearch(writeTarget.store.getStorePath());
        tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
        await tagRegistry.load();
        const { GnosysIngestion } = await import("./lib/ingest.js");
      ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);
        await reindexAllStores();
      }

      return { content: [{ type: "text" as const, text: summary }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Migration failed: ${msg}` }], isError: true };
    }
  }
);

// ─── Tool: gnosys_update ─────────────────────────────────────────────────
regTool(
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

    if (!ctx.centralDb?.isAvailable()) {
      return {
        content: [{ type: "text", text: "Database not available. Cannot update memory." }],
        isError: true,
      };
    }

    // DB-first lookup: resolve memory ID from central DB (mirrors gnosys_read pattern)
    let memoryId: string;
    let currentTitle: string;

    const dbMem = ctx.centralDb.getMemory(memPath);
    if (dbMem) {
      memoryId = dbMem.id;
      currentTitle = dbMem.title;
    } else {
      // Fallback to legacy file resolver
      const memory = await ctx.resolver.readMemory(memPath);
      if (!memory) {
        return {
          content: [{ type: "text", text: `Memory not found: ${memPath}` }],
          isError: true,
        };
      }
      if (!memory.frontmatter.id) {
        return {
          content: [{ type: "text", text: `Memory has no ID: ${memPath}` }],
          isError: true,
        };
      }
      memoryId = memory.frontmatter.id;
      currentTitle = memory.frontmatter.title || memPath;
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

    const fullContent = newContent ? `# ${title || currentTitle}\n\n${newContent}` : undefined;

    // Write update to DB only (SQLite is sole source of truth)
    syncUpdateToDb(ctx.centralDb, memoryId, updates, fullContent);
    auditToDb(ctx.centralDb, "write", memoryId, { tool: "gnosys_update", changed: Object.keys(updates) });

    // Supersession cross-linking: if A supersedes B, mark B as superseded_by A
    if (supersedes) {
      syncUpdateToDb(ctx.centralDb, supersedes, { superseded_by: memoryId, status: "superseded" });
    }

    // Rebuild search index
    if (ctx.search) await reindexAllStores();

    const changedFields = Object.keys(updates);
    if (newContent) changedFields.push("content");

    const updatedTitle = title || currentTitle;

    return {
      content: [
        {
          type: "text",
          text: `Memory updated: **${updatedTitle}**\nID: ${memoryId}\nChanged: ${changedFields.join(", ")}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_stale ─────────────────────────────────────────────────
regTool(
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
    try {
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
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("finding stale memories", err) }], isError: true };
    }
  }
);

// ─── Tool: gnosys_commit_context ────────────────────────────────────────
regTool(
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
    // v5.8.0 (#8): no early-gate on the module-level `ingestion` here.
    // It's bound to the MCP's boot-time config — which may not have an LLM
    // block on the directory we launched in. The real LLM resolution
    // happens against `ctx.config` (merged project+global) below; if that
    // can't find a provider, getLLMProvider() surfaces a provider-specific
    // error message.
    //
    // v5.9.1 (#100): wait for the background heavy-init to populate
    // `ingestion` if it hasn't yet (first call after a fresh MCP spawn
    // may pause here while @huggingface/transformers etc. load).
    await ensureHeavyDeps();
    if (!ingestion) {
      return {
        content: [{ type: "text", text: "Ingestion module not initialized." }],
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
            if (!ctx.centralDb?.isAvailable()) {
              results.push(`❌ FAILED: "${candidate.summary}": Database not available`);
              continue;
            }
            const result = await ingestion.ingest(candidate.summary, ctx.config);
            const id = ctx.centralDb.getNextId(result.category, ctx.projectId ?? undefined);
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

            const content = `# ${result.title}\n\n${result.content}`;

            // Write to DB only (SQLite is sole source of truth)
            syncMemoryToDb(ctx.centralDb, frontmatter, content, undefined, ctx.projectId, "project");
            auditToDb(ctx.centralDb, "write", id, { tool: "gnosys_commit_context", category: result.category });

            results.push(
              `➕ ADDED: "${result.title}"\n  ID: ${id}`
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
regTool(
  "gnosys_history",
  "View audit history for a memory. Shows what changed and when based on the audit log.",
  {
    path: z.string().describe("Path to memory, optionally layer-prefixed"),
    limit: z.number().optional().describe("Max history entries (default 20)"),
    projectRoot: projectRootParam,
  },
  async ({ path: memPath, limit, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);

    if (ctx.centralDb?.isAvailable()) {
      const dbMem = ctx.centralDb.getMemory(memPath);
      if (dbMem) {
        const audits = ctx.centralDb.getAuditLog(dbMem.id, limit || 20);

        if (audits.length > 0) {
          const lines = audits.map(
            (e) => `- ${e.timestamp.split("T")[0]} — ${e.operation}${e.details ? ` (${e.details})` : ""}`
          );
          return {
            content: [{
              type: "text",
              text: `History for **${dbMem.title}** (${dbMem.id}, ${audits.length} entries):\n\nCreated: ${dbMem.created}\nModified: ${dbMem.modified}\n\n${lines.join("\n")}`,
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: `Memory found: **${dbMem.title}** (${dbMem.id})\nCreated: ${dbMem.created}\nModified: ${dbMem.modified}\nNo audit history recorded.`,
          }],
        };
      }
    }

    return { content: [{ type: "text", text: `Memory not found: ${memPath}` }], isError: true };
  }
);

// ─── Tool: gnosys_lens ──────────────────────────────────────────────────
regTool(
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
    try {
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
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("applying memory lens", err) }], isError: true };
    }
  }
);

// ─── Tool: gnosys_timeline ───────────────────────────────────────────────
regTool(
  "gnosys_timeline",
  "View memory creation and modification activity over time. Shows how knowledge evolves by grouping memories into time periods.",
  {
    period: z.enum(["day", "week", "month", "year"]).optional().describe("Grouping period (default: month)"),
    projectRoot: projectRootParam,
  },
  async ({ period, projectRoot }) => {
    try {
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
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("building timeline", err) }], isError: true };
    }
  }
);

// ─── Tool: gnosys_stats ─────────────────────────────────────────────────
regTool(
  "gnosys_stats",
  "Summary statistics across all memories — totals by category, status, author, authority, average confidence, and date ranges.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    try {
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
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("computing statistics", err) }], isError: true };
    }
  }
);

// ─── Tool: gnosys_links ─────────────────────────────────────────────────
regTool(
  "gnosys_links",
  "Show wikilinks for a specific memory — outgoing [[links]] and backlinks from other memories. Obsidian-compatible [[Title]] and [[path|display]] syntax.",
  {
    path: z.string().describe("Path to memory, optionally layer-prefixed"),
    projectRoot: projectRootParam,
  },
  async ({ path: memPath, projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);

    // DB-first: resolve memory ID and check relationships table
    if (ctx.centralDb?.isAvailable()) {
      const dbMem = ctx.centralDb.getMemory(memPath);
      if (dbMem) {
        const outRels = ctx.centralDb.getRelationshipsFrom(dbMem.id);
        const inRels = ctx.centralDb.getRelationshipsTo(dbMem.id);

        if (outRels.length > 0 || inRels.length > 0) {
          const parts: string[] = [`Links for **${dbMem.title}** (${dbMem.id}):\n`];

          if (outRels.length > 0) {
            parts.push(`Outgoing (${outRels.length}):`);
            for (const r of outRels) {
              const target = ctx.centralDb.getMemory(r.target_id);
              parts.push(`  → ${r.rel_type} → ${target ? target.title : r.target_id}`);
            }
          }
          if (inRels.length > 0) {
            parts.push(`\nIncoming (${inRels.length}):`);
            for (const r of inRels) {
              const source = ctx.centralDb.getMemory(r.source_id);
              parts.push(`  ← ${r.rel_type} ← ${source ? source.title : r.source_id}`);
            }
          }
          return { content: [{ type: "text", text: parts.join("\n") }] };
        }
        return { content: [{ type: "text", text: `Memory found: **${dbMem.title}** (${dbMem.id})\nNo links or relationships recorded.` }] };
      }
    }

    // Legacy file-based fallback
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
regTool(
  "gnosys_graph",
  "Show the full cross-reference graph across all memories. Reveals clusters, orphaned links, and the most-connected memories.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    try {
    const ctx = await resolveToolContext(projectRoot);
    const allMemories = await ctx.resolver.getAllMemories();

    if (allMemories.length === 0) {
      return { content: [{ type: "text", text: "No memories found." }] };
    }

    const graph = buildLinkGraph(allMemories);
    return { content: [{ type: "text", text: formatGraphSummary(graph) }] };
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("building graph", err) }], isError: true };
    }
  }
);

// ─── Tool: gnosys_bootstrap ─────────────────────────────────────────────
regTool(
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
      // v5.9.1 (#100): bootstrap pulls in heavy file-walking deps — load lazily.
      const { bootstrap } = await import("./lib/bootstrap.js");
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
regTool(
  "gnosys_import",
  "Bulk import structured data (CSV, JSON, JSONL) into Gnosys memories. Map source fields to title/category/content/tags/relevance. Use mode='llm' for smart ingestion with keyword clouds, or 'structured' for fast direct mapping. For large datasets (>100 records with LLM), the CLI is recommended: gnosys import <file>",
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
      // v5.9.1 (#100): import.js pulls mammoth + pdf-parse + turndown.
      const { performImport, formatImportSummary, estimateDuration } = await import(
        "./lib/import.js"
      );
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

      // DB-only: audit the import (no local migrate — all writes go to central DB)
      if (!dryRun && result.imported.length > 0 && gnosysDb?.isAvailable()) {
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
        response += `\n\n💡 Tip: For large LLM imports, the CLI offers progress tracking and resume:\n  gnosys import ${data.length < 100 ? data : "<file>"} --format ${format} --mode llm --skip-existing`;
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
regTool(
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
    // v5.9.1 (#100): wait for the background heavy-init to finish.
    await ensureHeavyDeps();
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
        // v5.9.1 (#100): lazy-load the maintenance module here too.
        const { GnosysMaintenanceEngine } = await import("./lib/maintenance.js");
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
regTool(
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
    await ensureHeavyDeps();
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
regTool(
  "gnosys_reindex",
  "Rebuild all semantic embeddings from every memory file. Downloads the embedding model (~80 MB) on first run. Required before hybrid/semantic search can be used. Safe to re-run — fully regenerates the index.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    // Note: reindex operates on all stores, projectRoot is for API consistency
    (projectRoot); // quiets unused warning if any
    await ensureHeavyDeps();
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
regTool(
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
    await ensureHeavyDeps();
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
        // v5.9.1 (#100): lazy-load the maintenance module here too.
        const { GnosysMaintenanceEngine } = await import("./lib/maintenance.js");
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
regTool(
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
      // v5.9.1 (#100): maintenance engine pulls LLM machinery for the
      // discoverRelationships / generateSummaries phases — load lazily.
      const { GnosysMaintenanceEngine, formatMaintenanceReport } = await import(
        "./lib/maintenance.js"
      );
      const engine = new GnosysMaintenanceEngine(ctx.resolver, ctx.config);
      const report = await engine.maintain({
        dryRun: dryRun ?? true,
        autoApply: autoApply ?? false,
      });

      // v2.0: Log maintenance run to gnosys.db
      if (ctx.centralDb?.isAvailable()) {
        auditToDb(ctx.centralDb, "maintain", undefined, {
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
regTool(
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
      if (ctx.centralDb?.isAvailable()) {
        for (const memId of ids) {
          syncDearchiveToDb(ctx.centralDb, memId);
        }
        auditToDb(ctx.centralDb, "dearchive", undefined, { query, count: restored.length });
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
regTool(
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
regTool(
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
    try {
    const ctx = await resolveToolContext(params.projectRoot);
    if (!ctx.centralDb || !ctx.centralDb.isAvailable() || !ctx.centralDb.isMigrated()) {
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

    // v5.9.1 (#100): dream engine pulls LLM provider machinery — load lazily.
    const { GnosysDreamEngine, formatDreamReport } = await import("./lib/dream.js");
    const engine = new GnosysDreamEngine(ctx.centralDb, ctx.config || DEFAULT_CONFIG, dreamConfig);
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
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("running dream mode", err) }], isError: true };
    }
  }
);

// ─── Tool: gnosys_export ─────────────────────────────────────────────────
regTool(
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
    try {
    const ctx = await resolveToolContext(params.projectRoot);
    if (!ctx.centralDb || !ctx.centralDb.isAvailable() || !ctx.centralDb.isMigrated()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Export requires gnosys.db (v2.0). Run `gnosys migrate` first.",
          },
        ],
      };
    }

    // v5.9.1 (#100): exporter pulls obsidian-flavored markdown gen — lazy.
    const { GnosysExporter, formatExportReport } = await import("./lib/export.js");
    const exporter = new GnosysExporter(ctx.centralDb);
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
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("exporting vault", err) }], isError: true };
    }
  }
);

// ─── Tool: gnosys_dashboard ──────────────────────────────────────────────
regTool(
  "gnosys_dashboard",
  "Show the Gnosys system dashboard: memory counts, maintenance health, graph stats, LLM provider status. Returns structured JSON.",
  { projectRoot: projectRootParam },
  async ({ projectRoot }) => {
    const ctx = await resolveToolContext(projectRoot);
    try {
      const { collectDashboardData, formatDashboardJSON } = await import("./lib/dashboard.js");
      const data = await collectDashboardData(ctx.resolver, ctx.config, "1.1.0", ctx.centralDb || undefined);
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
regTool(
  "gnosys_stores",
  "Debug tool — lists all detected Gnosys stores across registered projects, MCP workspace roots, cwd, and environment variables. Shows which store is active and helps diagnose multi-project routing.",
  {},
  async () => {
    try {
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
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("listing stores", err) }], isError: true };
    }
  }
);

// ─── Helper: reindex search across all stores ────────────────────────────
async function reindexAllStores(): Promise<void> {
  if (!search) return;
  search.clearIndex();

  // DB-first: read from central DB instead of scanning markdown files
  if (centralDb?.isAvailable()) {
    const memories = centralDb.getActiveMemories();
    search.addDbMemories(memories);
    return;
  }

  // Fallback: read from markdown files if central DB unavailable
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
regResource(
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
regTool(
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
    try {
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
      gnosysDb: ctx.centralDb || undefined,
    });

    return {
      content: [{ type: "text" as const, text: formatRecall(result) }],
    };
    } catch (err) {
      return { content: [{ type: "text", text: formatMcpError("recalling memories", err) }], isError: true };
    }
  }
);

// ─── Tool: gnosys_audit ──────────────────────────────────────────────────
regTool(
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

// ─── Tool: gnosys_preference_set ─────────────────────────────────────────
regTool(
  "gnosys_preference_set",
  "Set a user preference. Preferences are stored in the central DB as user-scoped memories. They persist across all projects and are injected into agent rules files on `gnosys sync`. Use this to record workflow conventions, coding standards, tool preferences, etc.",
  {
    key: z.string().describe(
      "Preference key, kebab-case. Examples: 'commit-convention', 'code-style', 'llm-provider', 'testing-approach', 'naming-convention'"
    ),
    value: z.string().describe(
      "The preference value. Can be a sentence or paragraph describing the convention."
    ),
    title: z.string().optional().describe("Human-readable title. Auto-generated from key if omitted."),
    tags: z.array(z.string()).optional().describe("Optional tags for discovery."),
    projectRoot: projectRootParam,
  },
  async ({ key, value, title, tags }) => {
    if (!centralDb?.isAvailable()) {
      return {
        content: [{ type: "text" as const, text: "Central DB not available. Cannot store preferences." }],
        isError: true,
      };
    }

    try {
      if (!(KNOWN_PREFERENCE_KEYS as readonly string[]).includes(key)) {
        const suggestion = suggestPreferenceKey(key);
        if (suggestion) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: `Unknown preference key \`${key}\` — did you mean \`${suggestion}\`?`,
            }],
          };
        }
      }

      const pref = setPreference(centralDb, key, value, { title, tags });
      return {
        content: [{
          type: "text" as const,
          // v5.8.0 (#9): no longer suggest running gnosys_sync. The
          // SessionStart hook (gnosys recall) already injects preferences
          // into the next session's context — no need to rewrite tracked
          // files like CLAUDE.md.
          text: `Preference set: **${pref.title}**\n  Key: ${pref.key}\n  Value: ${pref.value}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error setting preference: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_preference_get ─────────────────────────────────────────
regTool(
  "gnosys_preference_get",
  "Get a user preference by key, or list all preferences.",
  {
    key: z.string().optional().describe("Preference key to retrieve. Omit to list all preferences."),
    projectRoot: projectRootParam,
  },
  async ({ key }) => {
    if (!centralDb?.isAvailable()) {
      return {
        content: [{ type: "text" as const, text: "Central DB not available." }],
        isError: true,
      };
    }

    if (key) {
      const pref = getPreference(centralDb, key);
      if (!pref) {
        return {
          content: [{ type: "text" as const, text: `No preference found for key "${key}".` }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: `**${pref.title}** (${pref.key})\n\n${pref.value}\n\nConfidence: ${pref.confidence}\nModified: ${pref.modified}`,
        }],
      };
    }

    // List all
    const prefs = getAllPreferences(centralDb);
    if (prefs.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No preferences set. Use gnosys_preference_set to add some." }],
      };
    }

    const formatted = prefs
      .map((p) => `- **${p.title}** (\`${p.key}\`): ${p.value.split("\n")[0]}`)
      .join("\n");

    return {
      content: [{
        type: "text" as const,
        text: `${prefs.length} user preference(s):\n\n${formatted}`,
      }],
    };
  }
);

// ─── Tool: gnosys_preference_delete ──────────────────────────────────────
regTool(
  "gnosys_preference_delete",
  "Delete a user preference by key.",
  {
    key: z.string().describe("Preference key to delete."),
    projectRoot: projectRootParam,
  },
  async ({ key }) => {
    if (!centralDb?.isAvailable()) {
      return {
        content: [{ type: "text" as const, text: "Central DB not available." }],
        isError: true,
      };
    }

    const deleted = deletePreference(centralDb, key);
    if (!deleted) {
      return {
        content: [{ type: "text" as const, text: `No preference found for key "${key}".` }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        // v5.8.0 (#9): drop the gnosys_sync suggestion — SessionStart
        // hook picks up the change next time without rewriting tracked files.
        text: `Preference "${key}" deleted.`,
      }],
    };
  }
);

// ─── Tool: gnosys_sync ──────────────────────────────────────────────────
//
// v5.8.0 (#9): inert-by-default. Previously this tool always wrote a
// GNOSYS:START/GNOSYS:END block into the project's CLAUDE.md (a tracked
// file in most repos), producing phantom git diffs every time an agent
// helpfully called it after a preference change. Now the default is
// "return the rules block as text" — the agent can use that as in-context
// guidance without touching disk. To actually rewrite the rules file
// (the v5.7.0 behaviour), pass `commit_to_disk: true` explicitly.
//
// Routine in-session context flows through the SessionStart hook
// (`gnosys recall`), not through this tool.
regTool(
  "gnosys_sync",
  "Get the current user preferences + project conventions formatted as a GNOSYS:START/GNOSYS:END block. By default returns the block as text only (no disk write). Pass commit_to_disk=true to write it into the detected agent rules file (CLAUDE.md, .cursor/rules/gnosys.mdc) — only do this if the user has explicitly asked to refresh the rules file. Routine session context is already injected via the SessionStart hook (`gnosys recall`); do NOT call this tool after every preference change.",
  {
    projectRoot: projectRootParam,
    commit_to_disk: z
      .boolean()
      .optional()
      .describe("If true, write the block into the detected agent rules file on disk. Default: false (text only). Note: rules files like CLAUDE.md and .cursor/rules/*.mdc are typically tracked in git, so writing creates a diff."),
  },
  async ({ projectRoot, commit_to_disk }) => {
    if (!centralDb?.isAvailable()) {
      return {
        content: [{ type: "text" as const, text: "Central DB not available. Cannot sync rules." }],
        isError: true,
      };
    }

    const ctx = await resolveToolContext(projectRoot);
    const writeTarget = ctx.resolver.getWriteTarget();
    if (!writeTarget) {
      return {
        content: [{ type: "text" as const, text: "No writable store found. Run gnosys_init first." }],
        isError: true,
      };
    }

    // Find project identity
    const storePath = writeTarget.store.getStorePath();
    const projectDir = path.dirname(storePath);
    const identity = await readProjectIdentity(projectDir);

    if (!identity) {
      return {
        content: [{ type: "text" as const, text: "No project identity found. Run gnosys_init first." }],
        isError: true,
      };
    }

    const preferences = getAllPreferences(centralDb);
    let projectConventions: import("./lib/db.js").DbMemory[] = [];
    if (identity.projectId) {
      const projectMems = centralDb.getMemoriesByProject(identity.projectId);
      projectConventions = projectMems.filter(
        (m) => (m.category === "decisions" || m.category === "conventions") && m.status === "active",
      );
    }
    const block = generateRulesBlock(preferences, projectConventions);

    // Default path: return the block as text, no disk write.
    if (!commit_to_disk) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Rules block (preview, not written to disk):\n\n${block}\n\n` +
              `Summary: ${preferences.length} preference(s), ${projectConventions.length} project convention(s).\n` +
              `To write this into ${identity.agentRulesTarget || "the agent rules file"}, call gnosys_sync again with commit_to_disk=true.\n` +
              `(SessionStart hook 'gnosys recall' already provides routine session context — usually no disk write is needed.)`,
          },
        ],
      };
    }

    // Opt-in disk write path.
    if (!identity.agentRulesTarget) {
      return {
        content: [
          {
            type: "text" as const,
            text: "commit_to_disk=true requested, but no agent rules target detected (no .cursor/ or CLAUDE.md found). Create one first, then re-run gnosys_init to detect it.",
          },
        ],
      };
    }

    const result = await syncRules(
      centralDb,
      projectDir,
      identity.agentRulesTarget,
      identity.projectId,
    );

    if (!result) {
      return {
        content: [{ type: "text" as const, text: "Sync failed — no agent rules target." }],
        isError: true,
      };
    }

    const action = result.created ? "Created" : "Updated";
    return {
      content: [
        {
          type: "text" as const,
          text:
            `${action} rules file: ${result.filePath}\n\n  Preferences injected: ${result.prefCount}\n  Project conventions: ${result.conventionCount}\n\n` +
            `⚠ This wrote to a file that may be tracked in git — expect a diff. Routine session context flows through the SessionStart hook; only call gnosys_sync with commit_to_disk=true when the user explicitly asks to refresh the rules file.`,
        },
      ],
    };
  },
);

// ─── Tool: gnosys_federated_search ───────────────────────────────────────

regTool(
  "gnosys_federated_search",
  "Search across all scopes (project → user → global) with tier boosting. Results from the current project rank highest. Returns score breakdown showing which boosts were applied.",
  {
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default: 20)"),
    projectRoot: z.string().optional().describe("Project root directory for context detection"),
    includeGlobal: z.boolean().optional().describe("Include global-scope memories (default: true)"),
  },
  async ({ query, limit, projectRoot, includeGlobal }) => {
    if (!centralDb?.isAvailable()) {
      return { content: [{ type: "text" as const, text: "Central DB not available. Run gnosys_init first." }], isError: true };
    }

    // Auto-detect current project
    const projectId = await detectCurrentProject(centralDb, projectRoot || undefined);

    const results = federatedSearch(centralDb, query, {
      limit: limit || 20,
      projectId,
      includeGlobal: includeGlobal !== false,
    });

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: `No results for "${query}" across any scope.` }] };
    }

    const lines = results.map((r, i) => {
      const projectLabel = r.projectName ? ` [${r.projectName}]` : "";
      const boostLabel = r.boosts.length > 0 ? ` (${r.boosts.join(", ")})` : "";
      return `${i + 1}. **${r.title}** (${r.category})${projectLabel}\n   scope: ${r.scope} | score: ${r.score.toFixed(4)}${boostLabel}\n   ${r.snippet}`;
    });

    const contextNote = projectId ? `Context: project ${projectId}` : "Context: no project detected";
    return {
      content: [{ type: "text" as const, text: `${contextNote}\n\n${lines.join("\n\n")}` }],
    };
  }
);

// ─── Tool: gnosys_detect_ambiguity ──────────────────────────────────────

regTool(
  "gnosys_detect_ambiguity",
  "Check if a query matches memories in multiple projects. Use before write operations to confirm the target project when ambiguity exists.",
  {
    query: z.string().describe("Query to check for cross-project ambiguity"),
  },
  async ({ query }) => {
    if (!centralDb?.isAvailable()) {
      return { content: [{ type: "text" as const, text: "Central DB not available." }], isError: true };
    }

    const ambiguity = detectAmbiguity(centralDb, query);

    if (!ambiguity) {
      return { content: [{ type: "text" as const, text: `No ambiguity detected for "${query}" — matches at most one project.` }] };
    }

    const candidateLines = ambiguity.candidates.map(
      (c) => `- **${c.projectName}** (${c.projectId})\n  Dir: ${c.workingDirectory}\n  Matching memories: ${c.memoryCount}`
    );

    return {
      content: [{
        type: "text" as const,
        text: `⚠️ ${ambiguity.message}\n\nMatching projects:\n${candidateLines.join("\n\n")}`,
      }],
    };
  }
);

// ─── Tool: gnosys_briefing ──────────────────────────────────────────────

regTool(
  "gnosys_briefing",
  "Generate a project briefing — a summary of memory state, categories, recent activity, and top tags. Use for dream mode pre-computation or quick project status.",
  {
    projectId: z.string().optional().describe("Project ID (auto-detects from cwd if omitted)"),
    all: z.boolean().optional().describe("Generate briefings for ALL projects"),
    projectRoot: z.string().optional().describe("Project root for auto-detection"),
  },
  async ({ projectId, all, projectRoot }) => {
    if (!centralDb?.isAvailable()) {
      return { content: [{ type: "text" as const, text: "Central DB not available." }], isError: true };
    }

    if (all) {
      const briefings = generateAllBriefings(centralDb);
      if (briefings.length === 0) {
        return { content: [{ type: "text" as const, text: "No projects registered." }] };
      }
      const summaries = briefings.map((b) => `## ${b.projectName}\n${b.summary}`);
      return {
        content: [{ type: "text" as const, text: `# All Project Briefings\n\n${summaries.join("\n\n")}` }],
      };
    }

    // Auto-detect project if not provided
    let pid = projectId || null;
    if (!pid) {
      pid = await detectCurrentProject(centralDb, projectRoot || undefined);
    }

    if (!pid) {
      return { content: [{ type: "text" as const, text: "No project specified and none detected from current directory." }], isError: true };
    }

    const briefing = generateBriefing(centralDb, pid);
    if (!briefing) {
      return { content: [{ type: "text" as const, text: `Project not found: ${pid}` }], isError: true };
    }

    const catLines = Object.entries(briefing.categories)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `  ${cat}: ${count}`);

    const recentLines = briefing.recentActivity.map(
      (r) => `  - ${r.title} (${r.modified})`
    );

    const tagLine = briefing.topTags.slice(0, 10).map((t) => `${t.tag}(${t.count})`).join(", ");

    const text = [
      `# Briefing: ${briefing.projectName}`,
      `Directory: ${briefing.workingDirectory}`,
      `Active memories: ${briefing.activeMemories} / ${briefing.totalMemories} total`,
      "",
      `## Categories\n${catLines.join("\n")}`,
      "",
      `## Recent Activity (7d)\n${recentLines.length > 0 ? recentLines.join("\n") : "  None"}`,
      "",
      `## Top Tags\n  ${tagLine || "None"}`,
      "",
      `## Summary\n${briefing.summary}`,
    ].join("\n");

    return { content: [{ type: "text" as const, text }] };
  }
);

// ─── Tool: gnosys_portfolio ─────────────────────────────────────────────

regTool(
  "gnosys_portfolio",
  "Portfolio dashboard — shows all registered projects with memory counts, categories, status snapshots, roadmap items, and recent activity. Use for cross-project status overview.",
  {
    format: z.enum(["compact", "full"]).optional().describe("Output format: compact (default) or full markdown"),
  },
  async ({ format }) => {
    if (!centralDb?.isAvailable()) {
      return { content: [{ type: "text" as const, text: "Central DB not available." }], isError: true };
    }

    const report = generatePortfolio(centralDb);
    if (report.projects.length === 0) {
      return { content: [{ type: "text" as const, text: "No projects with active memories found." }] };
    }

    const text = format === "full"
      ? formatPortfolioMarkdown(report)
      : formatPortfolioCompact(report);

    return { content: [{ type: "text" as const, text }] };
  }
);

// ─── Remote sync tools (v5.3.0) ─────────────────────────────────────────

regTool(
  "gnosys_remote_status",
  "Check the status of remote sync (multi-machine). Returns pending pushes, pulls, conflicts, and reachability. Agents should surface this to the user when there are pending changes or conflicts.",
  {},
  async () => {
    // Sync operations need explicit local DB access (not auto-routed remote).
    const localDb = GnosysDB.openLocal();
    try {
      if (!localDb.isAvailable()) {
        return { content: [{ type: "text" as const, text: "Local DB not available." }], isError: true };
      }
      const remotePath = localDb.getMeta("remote_path");
      if (!remotePath) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ configured: false, message: "Remote sync not configured." }, null, 2),
          }],
        };
      }
      const { RemoteSync } = await import("./lib/remote.js");
      const sync = new RemoteSync(localDb, remotePath);
      const status = await sync.getStatus();
      sync.closeRemote();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      };
    } finally {
      localDb.close();
    }
  }
);

regTool(
  "gnosys_remote_push",
  "Push local memory changes to the remote (NAS) database. Uses skip-and-flag for conflicts by default. Call this when the user has approved pushing local changes.",
  {
    newerWins: z.boolean().optional().describe("Auto-resolve conflicts by taking the newer version"),
  },
  async ({ newerWins }) => {
    const localDb = GnosysDB.openLocal();
    try {
      if (!localDb.isAvailable()) {
        return { content: [{ type: "text" as const, text: "Local DB not available." }], isError: true };
      }
      const remotePath = localDb.getMeta("remote_path");
      if (!remotePath) {
        return { content: [{ type: "text" as const, text: "Remote not configured. Run 'gnosys remote configure'." }], isError: true };
      }
      const { RemoteSync } = await import("./lib/remote.js");
      const sync = new RemoteSync(localDb, remotePath);
      const result = await sync.push({ strategy: newerWins ? "newer-wins" : "skip-and-flag" });
      sync.closeRemote();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } finally {
      localDb.close();
    }
  }
);

regTool(
  "gnosys_remote_pull",
  "Pull remote memory changes to the local database. Uses skip-and-flag for conflicts by default. Call this when the user wants the latest from the remote.",
  {
    newerWins: z.boolean().optional().describe("Auto-resolve conflicts by taking the newer version"),
  },
  async ({ newerWins }) => {
    const localDb = GnosysDB.openLocal();
    try {
      if (!localDb.isAvailable()) {
        return { content: [{ type: "text" as const, text: "Local DB not available." }], isError: true };
      }
      const remotePath = localDb.getMeta("remote_path");
      if (!remotePath) {
        return { content: [{ type: "text" as const, text: "Remote not configured." }], isError: true };
      }
      const { RemoteSync } = await import("./lib/remote.js");
      const sync = new RemoteSync(localDb, remotePath);
      const result = await sync.pull({ strategy: newerWins ? "newer-wins" : "skip-and-flag" });
      sync.closeRemote();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } finally {
      localDb.close();
    }
  }
);

regTool(
  "gnosys_remote_resolve",
  "Resolve a sync conflict by choosing which version to keep. Use after gnosys_remote_status reveals conflicts. The agent should present the local and remote versions to the user and call this with their choice.",
  {
    memoryId: z.string().describe("Memory ID with the conflict"),
    choice: z.enum(["local", "remote"]).describe("Which version to keep"),
  },
  async ({ memoryId, choice }) => {
    const localDb = GnosysDB.openLocal();
    try {
      if (!localDb.isAvailable()) {
        return { content: [{ type: "text" as const, text: "Local DB not available." }], isError: true };
      }
      const remotePath = localDb.getMeta("remote_path");
      if (!remotePath) {
        return { content: [{ type: "text" as const, text: "Remote not configured." }], isError: true };
      }
      const { RemoteSync } = await import("./lib/remote.js");
      const sync = new RemoteSync(localDb, remotePath);
      const result = await sync.resolve(memoryId, choice);
      sync.closeRemote();
      if (result.ok) {
        return { content: [{ type: "text" as const, text: `Resolved ${memoryId}: kept ${choice} version.` }] };
      }
      return { content: [{ type: "text" as const, text: `Failed to resolve: ${result.error}` }], isError: true };
    } finally {
      localDb.close();
    }
  }
);

// ─── Tool: gnosys_update_status ─────────────────────────────────────────

regTool(
  "gnosys_update_status",
  "Get the prompt/template for writing a dashboard-compatible status memory for this project. Returns instructions for creating a landscape memory with the correct heading format so the portfolio dashboard can parse it. Run this, then follow the instructions to analyze and write the status.",
  {
    projectRoot: z.string().optional().describe("Project root for auto-detection"),
  },
  async ({ projectRoot }) => {
    if (!centralDb?.isAvailable()) {
      return { content: [{ type: "text" as const, text: "Central DB not available." }], isError: true };
    }

    const pid = await detectCurrentProject(centralDb, projectRoot || undefined);
    if (!pid) {
      return { content: [{ type: "text" as const, text: "No project detected from current directory." }], isError: true };
    }

    const project = centralDb.getProject(pid);
    if (!project) {
      return { content: [{ type: "text" as const, text: `Project not found: ${pid}` }], isError: true };
    }

    const prompt = generateStatusPrompt(project.name, project.working_directory);
    return { content: [{ type: "text" as const, text: prompt }] };
  }
);

// ─── Tool: gnosys_working_set ───────────────────────────────────────────

regTool(
  "gnosys_working_set",
  "Get the implicit working set — recently modified memories for the current project. These represent the active context and get boosted in federated search.",
  {
    projectRoot: z.string().optional().describe("Project root for auto-detection"),
    windowHours: z.number().optional().describe("Lookback window in hours (default: 24)"),
  },
  async ({ projectRoot, windowHours }) => {
    if (!centralDb?.isAvailable()) {
      return { content: [{ type: "text" as const, text: "Central DB not available." }], isError: true };
    }

    const pid = await detectCurrentProject(centralDb, projectRoot || undefined);
    if (!pid) {
      return { content: [{ type: "text" as const, text: "No project detected from current directory." }], isError: true };
    }

    const workingSet = getWorkingSet(centralDb, pid, {
      windowHours: windowHours || 24,
    });

    const formatted = formatWorkingSet(workingSet);
    return { content: [{ type: "text" as const, text: formatted }] };
  }
);

// ─── Tool: gnosys_ingest_file ────────────────────────────────────────────
regTool(
  "gnosys_ingest_file",
  "Ingest a file (PDF, DOCX, TXT, MD) into Gnosys memory. Extracts text, splits into chunks, and creates atomic memories. Supports LLM-powered structuring or fast structured mode.",
  {
    filePath: z.string().describe("Absolute path to the file to ingest"),
    mode: z.enum(["llm", "structured"]).default("llm").optional()
      .describe("Ingestion mode: 'llm' uses AI to structure each chunk, 'structured' uses keyword extraction (faster, no LLM needed)"),
    store: z.enum(["project", "personal", "global"]).optional()
      .describe("Target store layer"),
    author: z.enum(["human", "ai", "human+ai"]).default("human").optional(),
    authority: z.enum(["declared", "observed", "imported", "inferred"]).default("imported").optional(),
    dryRun: z.boolean().default(false).optional()
      .describe("Preview what would be created without writing"),
    projectRoot: projectRootParam,
  },
  async ({ filePath: inputPath, mode, store, author, authority, dryRun, projectRoot }) => {
    try {
      const ctx = await resolveToolContext(projectRoot);
      if (!ctx.store) {
        return {
          content: [{ type: "text" as const, text: "No writable store found. Initialize a project with gnosys_init first." }],
          isError: true,
        };
      }

      const { ingestFile } = await import("./lib/multimodalIngest.js");
      const result = await ingestFile({
        filePath: inputPath,
        storePath: ctx.storePath,
        mode: mode || "llm",
        store: store || undefined,
        author: author || "human",
        authority: authority || "imported",
        dryRun: dryRun || false,
        projectRoot: projectRoot || undefined,
      });

      // Format the result for the agent
      const lines: string[] = [];
      lines.push(`File ingested: ${result.attachment.originalName} (${result.fileType})`);
      lines.push(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
      lines.push(`Memories created: ${result.memories.length}`);

      if (result.memories.length > 0) {
        lines.push("");
        for (const m of result.memories) {
          const extra = m.page ? ` [page ${m.page}]` : "";
          lines.push(`- **${m.title}**${extra} (${m.id})`);
        }
      }

      if (result.errors.length > 0) {
        lines.push("");
        lines.push(`Errors (${result.errors.length}):`);
        for (const e of result.errors) {
          lines.push(`- Chunk ${e.chunk}: ${e.error}`);
        }
      }

      if (!dryRun && ctx.centralDb?.isAvailable()) {
        auditToDb(ctx.centralDb, "ingest", undefined, {
          source_file: result.attachment.originalName,
          fileType: result.fileType,
          count: result.memories.length,
        }, result.duration);
      }

      if (dryRun) {
        lines.unshift("(dry run — no files were written)\n");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Ingestion failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── MCP Prompts (slash commands) ────────────────────────────────────────
// These appear as /gnosys-recall, /gnosys-discover, /gnosys-memorize in
// Cursor, Claude Code, and Codex.

regPrompt(
  "gnosys-recall",
  "Inject top Gnosys memories for the current project into context. Use this at the start of any task to load relevant knowledge.",
  async () => {
    if (!centralDb?.isAvailable()) {
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: "<gnosys-recall>\nNo central DB available. Run gnosys_init first.\n</gnosys-recall>" },
          },
        ],
      };
    }

    // Detect current project from cwd
    const projectId = await detectCurrentProject(centralDb, undefined);

    // Get active memories, filter by project, sort by modified desc, take top 15
    const allActive = centralDb.getActiveMemories();
    const projectMemories = projectId
      ? allActive.filter((m) => m.project_id === projectId)
      : allActive;
    const sorted = projectMemories
      .sort((a, b) => (b.modified || "").localeCompare(a.modified || ""))
      .slice(0, 15);

    if (sorted.length === 0) {
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: "<gnosys-recall>\nNo memories found for this project.\n</gnosys-recall>" },
          },
        ],
      };
    }

    const lines = sorted.map((m) => {
      const snippet = m.content ? m.content.slice(0, 200) : "(no content)";
      return `### [${m.id}] ${m.title}\n*${m.category} | confidence: ${m.confidence}*\n${snippet}`;
    });

    const text = `<gnosys-recall project="${projectId || "unknown"}" count="${sorted.length}">\n${lines.join("\n\n")}\n</gnosys-recall>`;

    return {
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text },
        },
      ],
    };
  }
);

regPrompt(
  "gnosys-discover",
  "Search Gnosys memories on a specific topic and inject results into context.",
  { topic: z.string().describe("Topic or keywords to search for") },
  async ({ topic }) => {
    if (!centralDb?.isAvailable() || !centralDb?.isMigrated()) {
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: `<gnosys-discover topic="${topic}">\nNo central DB available. Run gnosys_init first.\n</gnosys-discover>` },
          },
        ],
      };
    }

    // Use FTS5 search from central DB
    const results = centralDb.searchFts(topic, 15);

    if (results.length === 0) {
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: `<gnosys-discover topic="${topic}">\nNo memories found for "${topic}". Try different keywords.\n</gnosys-discover>` },
          },
        ],
      };
    }

    const lines = results.map((r) => {
      const snippet = r.snippet
        ? r.snippet.replace(/>>>/g, "**").replace(/<<</g, "**")
        : "(no snippet)";
      return `### [${r.id}] ${r.title}\n${snippet}`;
    });

    const text = `<gnosys-discover topic="${topic}" count="${results.length}">\n${lines.join("\n\n")}\n</gnosys-discover>`;

    return {
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text },
        },
      ],
    };
  }
);

regPrompt(
  "gnosys-memorize",
  "Analyze the current conversation and save new decisions, findings, and context as Gnosys memories. Checks for duplicates automatically.",
  async () => {
    // Check for last memorized timestamp from preferences
    let lastMemorizedInfo = "This is the first time /gnosys-memorize has been run — analyze all conversation content.";
    if (centralDb?.isAvailable()) {
      const pref = getPreference(centralDb, "cursor.lastMemorized");
      if (pref) {
        lastMemorizedInfo = `Last memorized at: ${pref.value}. Focus only on conversation content AFTER this timestamp.`;
      }
    }

    const instructions = `<gnosys-memorize>
## Instructions: Extract and save memories from this conversation

${lastMemorizedInfo}

### What to extract
Scan the conversation for:
1. **Decisions** — any choice made about architecture, tools, libraries, approaches, or workflow
2. **Preferences** — coding style, conventions, how the user wants things done
3. **Architecture findings** — patterns discovered, system behavior, integration details
4. **Gotchas** — things that didn't work as expected, workarounds found, subtle bugs
5. **Requirements** — specs, constraints, acceptance criteria discussed

### How to save each memory
For each candidate memory:
1. First call \`gnosys_search\` with relevant keywords to check if it already exists
2. If a similar memory exists, call \`gnosys_update\` to augment it instead of creating a duplicate
3. If genuinely new, call \`gnosys_add_structured\` (NOT \`gnosys_add\`) with these fields:
   - **title**: Clear, descriptive title (e.g. "Decision: Use Postgres over SQLite for production")
   - **category**: One of: \`decisions\`, \`architecture\`, \`requirements\`, \`concepts\`, \`roadmap\`, \`landscape\`, \`open-questions\`
   - **content**: The full memory in markdown
   - **tags**: Object with arrays, e.g. \`{"domain": ["database", "backend"], "type": ["decision"]}\`
   - **relevance**: A keyword cloud for discovery search — 10-30 space-separated terms covering:
     * The primary topic and its synonyms
     * Related technologies, libraries, tools mentioned
     * The problem domain and use case
     * Action verbs (chose, rejected, implemented, configured)
     * Any names, acronyms, or abbreviations used in discussion
     Example: \`"postgres sqlite database migration production scaling orm prisma drizzle chose rejected backend data-layer persistence"\`

Using \`gnosys_add_structured\` instead of \`gnosys_add\` means **no separate LLM API call is needed** — YOU are the LLM doing the structuring.

### When done
After saving all memories, call \`gnosys_preference_set\` with:
- key: \`cursor.lastMemorized\`
- value: \`${new Date().toISOString()}\`

This marks the conversation checkpoint so the next /gnosys-memorize only processes new content.
</gnosys-memorize>`;

    return {
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: instructions },
        },
      ],
    };
  }
);

// ─── Heavy module initialization (deferred) ───────────────────────────────
//
// v5.9.1 (#100). Constructs GnosysIngestion / GnosysEmbeddings /
// GnosysHybridSearch / GnosysAsk / GnosysDreamEngine. These modules pull
// in @huggingface/transformers (80MB), mammoth, pdf-parse, turndown, and
// LLM provider SDKs — together ~24s of import time on cold disk. By
// running them AFTER server.connect() responds to the MCP handshake, we
// avoid the client-side timeout (Grok Build = 10s default).

let heavyDepsReadyResolve: (() => void) | null = null;
const heavyDepsReady: Promise<void> = new Promise((resolve) => {
  heavyDepsReadyResolve = resolve;
});

/**
 * Returns once the heavy deps have been loaded and module-level vars
 * (ingestion, hybridSearch, askEngine) are populated. Handlers that
 * need any of these should `await ensureHeavyDeps()` first.
 */
export function ensureHeavyDeps(): Promise<void> {
  return heavyDepsReady;
}

async function initHeavyDeps(): Promise<void> {
  const writeTarget = resolver.getWriteTarget();
  if (!writeTarget || !tagRegistry || !search) {
    heavyDepsReadyResolve?.();
    return;
  }

  // Ingestion (used by gnosys_add, gnosys_commit_context).
  const { GnosysIngestion } = await import("./lib/ingest.js");
  ingestion = new GnosysIngestion(writeTarget.store, tagRegistry, config);
  console.error(
    `LLM ingestion: ${ingestion.isLLMAvailable ? `enabled (${ingestion.providerName})` : "disabled (configure LLM provider)"}`,
  );

  // Hybrid search + ask (used by gnosys_hybrid_search / gnosys_ask).
  const { GnosysEmbeddings } = await import("./lib/embeddings.js");
  const { GnosysHybridSearch } = await import("./lib/hybridSearch.js");
  const { GnosysAsk } = await import("./lib/ask.js");
  const embeddings = new GnosysEmbeddings(writeTarget.store.getStorePath());
  hybridSearch = new GnosysHybridSearch(
    search,
    embeddings,
    resolver,
    writeTarget.store.getStorePath(),
    gnosysDb || undefined,
  );
  askEngine = new GnosysAsk(hybridSearch, config, resolver, writeTarget.store.getStorePath());
  const embCount = embeddings.hasEmbeddings() ? embeddings.count() : 0;
  console.error(
    `Hybrid search: ${embCount > 0 ? `ready (${embCount} embeddings)` : "available (run gnosys_reindex to build embeddings)"}`,
  );
  console.error(
    `Ask engine: ${askEngine.isLLMAvailable ? `ready (${askEngine.providerName}/${askEngine.modelName})` : "disabled (configure LLM provider)"}`,
  );

  // Dream mode (only constructed if enabled; designation gate inside start()).
  if (gnosysDb && config.dream?.enabled) {
    const { GnosysDreamEngine, DreamScheduler } = await import("./lib/dream.js");
    const dreamEngine = new GnosysDreamEngine(gnosysDb, config, config.dream);
    dreamScheduler = new DreamScheduler(dreamEngine, config.dream);

    // Layer 3: probe the dream provider if this machine is the dream node.
    try {
      const designated = gnosysDb.getDreamMachineId();
      const localId = gnosysDb.getMeta("machine_id");
      if (designated && designated === localId) {
        const dreamProvider = config.dream.provider || "ollama";
        const dreamModel = config.dream.model || "(default)";
        const { validateModel } = await import("./lib/modelValidation.js");
        const envVarName = `GNOSYS_${dreamProvider.toUpperCase()}_KEY`;
        let apiKey = process.env[envVarName] || "";
        if (!apiKey && process.platform === "darwin" && dreamProvider !== "ollama" && dreamProvider !== "lmstudio") {
          try {
            const { execSync } = await import("child_process");
            apiKey = execSync(`security find-generic-password -a "$USER" -s "${envVarName}" -w 2>/dev/null`, {
              stdio: "pipe", encoding: "utf-8", timeout: 2000,
            }).trim();
          } catch {
            // No key in keychain
          }
        }
        if (!apiKey && dreamProvider !== "ollama" && dreamProvider !== "lmstudio") {
          process.stderr.write(
            `gnosys: dream provider '${dreamProvider}/${dreamModel}' has no API key configured.\n` +
            `  This machine is designated to dream, but the LLM cannot be called.\n` +
            `  Run 'gnosys setup dream' to reconfigure.\n`,
          );
        } else {
          const result = await Promise.race([
            validateModel(dreamProvider, dreamModel, apiKey),
            new Promise<{ ok: false; error: string }>((resolve) =>
              setTimeout(() => resolve({ ok: false, error: "probe timeout (5s)" }), 5000),
            ),
          ]);
          if (!result.ok) {
            process.stderr.write(
              `gnosys: dream provider '${dreamProvider}/${dreamModel}' is unreachable at startup.\n` +
              `  This machine is designated to dream, but the LLM cannot be called.\n` +
              `  Error: ${("error" in result && result.error) || "unknown"}\n` +
              `  Run 'gnosys setup dream' to reconfigure.\n`,
            );
          }
        }
      }
    } catch {
      // Probe failed — non-fatal. Continue with scheduler start.
    }

    dreamScheduler.start();
    const designated = gnosysDb.getDreamMachineId();
    const localId = gnosysDb.getMeta("machine_id");
    if (!designated) {
      console.error(`Dream Mode: enabled but no machine designated. Run 'gnosys setup dream' on the machine you want to host dreams.`);
    } else if (designated !== localId) {
      console.error(`Dream Mode: enabled — designated to '${designated}'. This machine (${localId || "?"}) will not dream.`);
    } else {
      console.error(
        `Dream Mode: enabled on this machine (idle ${config.dream.idleMinutes}min, max ${config.dream.maxRuntimeMinutes}min)`,
      );
    }
  } else {
    console.error(`Dream Mode: disabled (run 'gnosys setup dream' to configure)`);
  }

  console.error("Gnosys MCP: heavy modules ready");
  heavyDepsReadyResolve?.();
}

// ─── Start the server ────────────────────────────────────────────────────
async function main() {
  // v5.7.1 (#15): start the upgrade-marker watcher BEFORE anything else.
  // If `gnosys upgrade` was run on this machine while the MCP was idle,
  // pick that up immediately instead of serving stale tool handlers.
  startUpgradeMarkerWatcher();

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

  // Initialize search from the first writable store. Everything in this
  // block is FAST — opening the search index + tag registry + loading
  // gnosys.json. The slow stuff (LLM providers, transformers embeddings,
  // pdf/docx parsers) is deferred to `initHeavyDeps()` below so the MCP
  // server can answer the `initialize` handshake within the client's
  // timeout (Grok Build is 10s, Claude Code is ~15s).
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

    // Initialize audit logging
    initAudit(writeTarget.store.getStorePath());

    // Build search index across all stores
    await reindexAllStores();

    // v5.2: gnosysDb now points to the central DB (sole source of truth).
    // No local project DB is created or opened.
    gnosysDb = centralDb;

    console.error(
      "Gnosys MCP: light init complete; LLM/embeddings/dream loading in background…",
    );
  }

  // v5.9.1 (#100): connect EARLY so the MCP `initialize` handshake responds
  // before we incur the ~24s heavy-import cost. After connect, kick off
  // heavy module initialization in the background. Handlers that use the
  // module-level `ingestion` / `hybridSearch` / `askEngine` vars guard
  // against null and either await readiness or surface a clear error.
  // v5.12: HTTP transport (central-server topology) — opt-in via env, set by
  // `gnosys serve --transport http`. Each session gets its own McpServer
  // (registrations replayed); all share the module-global brain/search.
  if (process.env.GNOSYS_TRANSPORT === "http") {
    const { startMcpHttpServer } = await import("./lib/mcpHttp.js");
    const host = process.env.GNOSYS_HTTP_HOST || "127.0.0.1";
    const port = parseInt(process.env.GNOSYS_HTTP_PORT || "7777", 10);
    const authToken = process.env.GNOSYS_SERVE_TOKEN || undefined;
    try {
      await startMcpHttpServer({
        host,
        port,
        authToken,
        log: (m) => console.error(`Gnosys MCP[http]: ${m}`),
        makeServer: () => {
          const s = new McpServer({ name: "gnosys", version: "2.0.0" });
          registerCapabilities(s);
          return s;
        },
      });
    } catch (err) {
      console.error(`Gnosys MCP: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    console.error(
      `Gnosys MCP: HTTP transport ready on http://${host}:${port}/mcp${authToken ? " (bearer auth required)" : ""}`,
    );
    void initHeavyDeps().catch((err) => {
      console.error(`Gnosys MCP: heavy-init failed — ${err instanceof Error ? err.message : err}`);
    });
    return;
  }

  registerCapabilities(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gnosys MCP: handshake ready (heavy modules still loading)");

  // Kick off heavy deps; fire-and-forget. Errors here are non-fatal —
  // they're logged to stderr and the affected handlers will report the
  // failure on first use.
  void initHeavyDeps().catch((err) => {
    console.error(
      `Gnosys MCP: heavy-init failed — ${err instanceof Error ? err.message : err}`,
    );
  });

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

const invokedAsScript =
  !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsScript) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
