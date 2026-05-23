/**
 * Gnosys Dashboard — Aggregated system status in a pretty terminal display.
 * Combines memory stats, maintenance health, graph stats, and LLM routing.
 */

import { GnosysResolver } from "./resolver.js";
import {
  GnosysConfig,
  resolveTaskModel,
  ALL_PROVIDERS,
  LLMProviderName,
} from "./config.js";
import { isProviderAvailable } from "./llm.js";
import { GnosysEmbeddings } from "./embeddings.js";
import { GnosysDB } from "./db.js";
import { readMachineConfig } from "./machineConfig.js";
import { effectiveProjectPath } from "./projectPaths.js";
import fs from "fs/promises";
import path from "path";

// ─── Types ──────────────────────────────────────────────────────────────

export interface DashboardData {
  stores: Array<{ label: string; path: string; memoryCount: number }>;
  totalMemories: number;
  /** v2.0: gnosys.db unified store stats */
  gnosysDb: {
    migrated: boolean;
    schemaVersion: number;
    activeCount: number;
    archivedCount: number;
    totalCount: number;
    embeddingCount: number;
    categories: string[];
  } | null;
  archive: {
    totalArchived: number;
    dbSizeMB: number;
    archiveEligible: number;
  } | null;
  maintenance: {
    staleCount: number;
    avgConfidence: number;
    avgDecayedConfidence: number;
    neverReinforced: number;
    totalReinforcements: number;
  } | null;
  embeddings: {
    count: number;
    dbSizeMB: number;
  } | null;
  graph: {
    nodes: number;
    edges: number;
    orphans: number;
    mostConnected: string | null;
  } | null;
  soc: {
    defaultProvider: LLMProviderName;
    structuring: { provider: LLMProviderName; model: string };
    synthesis: { provider: LLMProviderName; model: string };
    providerStatus: Array<{
      name: LLMProviderName;
      available: boolean;
      note: string;
    }>;
  };
  recall: {
    aggressive: boolean;
    maxMemories: number;
    minRelevance: number;
  };
  performance: {
    activeSearchMs: number;
    archiveSearchMs: number;
    recallMs: number;
  } | null;
  /** v5.4.2: Dream Mode health (designation + recent runs). */
  dream: {
    enabled: boolean;
    designatedMachine: string | null;
    isThisMachine: boolean;
    localMachine: string | null;
    lastRun: string | null;
    lastSuccessfulRun: string | null;
    consecutiveFailures: number;
    recentTotal: number;
    recentFailures: number;
    provider: string;
    model: string | null;
  } | null;
  version: string;
}

/**
 * Probe a local LLM provider's HTTP endpoint with a short timeout.
 * Returns true if the server responded within 500ms.
 */
async function probeLocalProvider(
  provider: "ollama" | "lmstudio",
  config: GnosysConfig
): Promise<boolean> {
  const probeUrl = provider === "ollama"
    ? `${config.llm.ollama.baseUrl.replace(/\/$/, "")}/api/tags`
    : `${config.llm.lmstudio.baseUrl.replace(/\/$/, "")}/v1/models`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const res = await fetch(probeUrl, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

// ─── Data Collection ────────────────────────────────────────────────────

export async function collectDashboardData(
  resolver: GnosysResolver,
  config: GnosysConfig,
  version: string,
  gnosysDb?: GnosysDB
): Promise<DashboardData> {
  const stores = resolver.getStores();

  // v2.0: GnosysDB stats
  let gnosysDbData: DashboardData["gnosysDb"] = null;
  if (gnosysDb?.isAvailable() && gnosysDb?.isMigrated()) {
    const counts = gnosysDb.getMemoryCount();
    const embCount = gnosysDb.getAllEmbeddings().length;
    const categories = gnosysDb.getCategories();
    gnosysDbData = {
      migrated: true,
      schemaVersion: gnosysDb.getSchemaVersion(),
      activeCount: counts.active,
      archivedCount: counts.archived,
      totalCount: counts.total,
      embeddingCount: embCount,
      categories,
    };
  }

  // Memory counts — v5.4.1: prefer central DB. The legacy resolver path
  // returns 0 in DB-only mode (memories aren't on the filesystem anymore).
  // Show per-project breakdown from the central DB when available.
  const storeData: DashboardData["stores"] = [];
  let totalMemories = 0;
  if (gnosysDb?.isAvailable() && gnosysDb?.isMigrated()) {
    const projects = gnosysDb.getAllProjects();
    const machine = readMachineConfig();
    for (const p of projects) {
      const count = gnosysDb.getMemoriesByProject(p.id).length;
      const path = effectiveProjectPath(gnosysDb, p, machine) ?? "(not on this machine)";
      storeData.push({ label: p.name, path, memoryCount: count });
      totalMemories += count;
    }
    // Also count user/global-scoped memories that have no project_id
    const orphanCount = gnosysDb
      .getAllMemories()
      .filter((m) => !m.project_id).length;
    if (orphanCount > 0) {
      storeData.push({ label: "user/global", path: "(no project)", memoryCount: orphanCount });
      totalMemories += orphanCount;
    }
  } else {
    for (const s of stores) {
      const memories = await s.store.getAllMemories();
      storeData.push({ label: s.label, path: s.path, memoryCount: memories.length });
      totalMemories += memories.length;
    }
  }

  // Archive stats
  let archive: DashboardData["archive"] = null;
  if (stores.length > 0) {
    try {
      const { GnosysArchive, getArchiveEligible } = await import("./archive.js");
      const arch = new GnosysArchive(stores[0].path);
      if (arch.isAvailable()) {
        const stats = arch.getStats();
        // Count eligible for archiving
        const allMems = await stores[0].store.getAllMemories();
        const eligible = getArchiveEligible(allMems, config);
        archive = {
          totalArchived: stats.totalArchived,
          dbSizeMB: stats.dbSizeMB,
          archiveEligible: eligible.length,
        };
        arch.close();
      }
    } catch {
      // Archive not available
    }
  }

  // Maintenance health
  let maintenance: DashboardData["maintenance"] = null;
  if (stores.length > 0) {
    try {
      const { GnosysMaintenanceEngine } = await import("./maintenance.js");
      const engine = new GnosysMaintenanceEngine(resolver, config);
      const health = await engine.getHealthReport();
      maintenance = {
        staleCount: health.staleCount,
        avgConfidence: health.avgConfidence,
        avgDecayedConfidence: health.avgDecayedConfidence,
        neverReinforced: health.neverReinforced,
        totalReinforcements: health.totalReinforcements,
      };
    } catch {
      // Maintenance not available
    }
  }

  // Embeddings
  let embeddings: DashboardData["embeddings"] = null;
  if (stores.length > 0) {
    try {
      const emb = new GnosysEmbeddings(stores[0].path);
      const stats = emb.getStats();
      if (stats.count > 0) {
        embeddings = { count: stats.count, dbSizeMB: stats.dbSizeMB };
      }
    } catch {
      // Embeddings not initialized
    }
  }

  // Graph stats
  let graph: DashboardData["graph"] = null;
  if (stores.length > 0) {
    try {
      const graphPath = path.join(stores[0].path, "graph.json");
      const raw = await fs.readFile(graphPath, "utf-8");
      const graphData = JSON.parse(raw) as {
        nodes: Array<{ id: string; edges: number }>;
        edges: Array<unknown>;
      };
      const nodes = graphData.nodes?.length || 0;
      const edges = graphData.edges?.length || 0;
      const orphans = graphData.nodes?.filter((n) => n.edges === 0).length || 0;
      const sorted = [...(graphData.nodes || [])].sort((a, b) => b.edges - a.edges);
      const mostConnected = sorted.length > 0 ? sorted[0].id : null;
      graph = { nodes, edges, orphans, mostConnected };
    } catch {
      // No graph file
    }
  }

  // SOC status
  const structuring = resolveTaskModel(config, "structuring");
  const synthesis = resolveTaskModel(config, "synthesis");
  const providerStatus: DashboardData["soc"]["providerStatus"] = [];

  for (const p of ALL_PROVIDERS) {
    const status = isProviderAvailable(config, p);
    let available = status.available;
    let note = status.available ? "ready" : (status.error || "not configured");
    // v5.4.1: For local providers, the sync isProviderAvailable check just
    // confirms "no API key needed." Actually probe the local server with a
    // short timeout so the dashboard reports truthful state.
    if (status.available && (p === "ollama" || p === "lmstudio")) {
      const reachable = await probeLocalProvider(p, config);
      available = reachable;
      note = reachable ? "ready" : "server not running";
    }
    providerStatus.push({ name: p, available, note });
  }

  // Performance benchmarks (quick probe of search/archive latency)
  let performance: DashboardData["performance"] = null;
  if (stores.length > 0) {
    try {
      const { GnosysSearch: SearchClass } = await import("./search.js");
      const testSearch = new SearchClass(stores[0].path);
      await testSearch.addStoreMemories(stores[0].store);

      // Active search benchmark
      const t1 = Date.now();
      testSearch.search("test benchmark probe", 5);
      const activeSearchMs = Date.now() - t1;

      // Archive search benchmark
      let archiveSearchMs = 0;
      try {
        const { GnosysArchive: ArchClass } = await import("./archive.js");
        const arch = new ArchClass(stores[0].path);
        if (arch.isAvailable()) {
          const t2 = Date.now();
          arch.searchArchive("test benchmark probe", 5);
          archiveSearchMs = Date.now() - t2;
          arch.close();
        }
      } catch {
        // Archive not available
      }

      // Recall benchmark (active search only)
      const t3 = Date.now();
      testSearch.discover("test benchmark probe", 8);
      const recallMs = Date.now() - t3;

      performance = { activeSearchMs, archiveSearchMs, recallMs };
    } catch {
      // Performance probe failed
    }
  }

  // v5.4.2: Dream health
  let dreamData: DashboardData["dream"] = null;
  if (gnosysDb?.isAvailable() && gnosysDb?.isMigrated()) {
    try {
      const designated = gnosysDb.getDreamMachineId();
      const localMachine = gnosysDb.getMeta("machine_id");
      const consecutiveFailures = gnosysDb.getDreamConsecutiveFailures();
      const recentRuns = gnosysDb.getRecentDreamRuns(5);
      const lastRun = recentRuns[0];
      const lastSuccessful = gnosysDb.getLastSuccessfulDreamRun();
      const recentFailures = recentRuns.filter((r) => {
        const d = r.details as Record<string, unknown>;
        return Number(d.errors || 0) > 0 || Boolean(d.providerUnreachable);
      }).length;
      dreamData = {
        enabled: !!config.dream?.enabled,
        designatedMachine: designated,
        isThisMachine: !!designated && designated === localMachine,
        localMachine,
        lastRun: lastRun?.completed ?? null,
        lastSuccessfulRun: lastSuccessful?.completed ?? null,
        consecutiveFailures,
        recentTotal: recentRuns.length,
        recentFailures,
        provider: config.dream?.provider ?? "ollama",
        model: config.dream?.model ?? null,
      };
    } catch {
      // Dream stats unavailable — leave null
    }
  }

  return {
    stores: storeData,
    totalMemories,
    gnosysDb: gnosysDbData,
    archive,
    maintenance,
    embeddings,
    graph,
    soc: {
      defaultProvider: config.llm.defaultProvider,
      structuring,
      synthesis,
      providerStatus,
    },
    recall: {
      aggressive: config.recall?.aggressive !== false,
      maxMemories: config.recall?.maxMemories ?? 8,
      minRelevance: config.recall?.minRelevance ?? 0.4,
    },
    performance,
    dream: dreamData,
    version,
  };
}

// ─── Pretty Terminal Formatting ─────────────────────────────────────────

// Box dimensions. Inner width = chars between ║ and ║. Top/bottom borders
// use the same width so everything aligns. The +1 in `pad` ensures content
// always has at least 1 char of trailing margin before the right border.
const BOX_W = 54;
const BOX_TOP = "╔" + "═".repeat(BOX_W) + "╗";
const BOX_MID = "╠" + "═".repeat(BOX_W) + "╣";
const BOX_DIV = "╟" + "─".repeat(BOX_W) + "╢";
const BOX_BOT = "╚" + "═".repeat(BOX_W) + "╝";

/** Wrap a content line in box borders, truncating with ellipsis if needed. */
function row(content: string): string {
  const max = BOX_W - 1; // leave at least 1 char of trailing margin
  const trimmed = content.length > max
    ? content.substring(0, max - 1) + "…"
    : content;
  return `║${trimmed.padEnd(BOX_W)}║`;
}

/** Section header — a centred-ish title with trailing margin. */
function header(title: string): string {
  return row(`  ${title}`);
}

export function formatDashboard(data: DashboardData): string {
  const lines: string[] = [];

  lines.push(BOX_TOP);
  lines.push(row(`          GNOSYS DASHBOARD  v${data.version}`));
  lines.push(BOX_MID);

  // v5.x: Central Database stats (was "v2.0 AGENT-NATIVE CORE")
  if (data.gnosysDb) {
    lines.push(header("CENTRAL DATABASE"));
    lines.push(BOX_DIV);
    lines.push(row(`  Schema v${data.gnosysDb.schemaVersion} — migrated ✓`));
    lines.push(row(`  Active: ${data.gnosysDb.activeCount} | Archived: ${data.gnosysDb.archivedCount} | Total: ${data.gnosysDb.totalCount}`));
    lines.push(row(`  Embeddings: ${data.gnosysDb.embeddingCount} inline vectors`));
    lines.push(row(`  Categories: ${data.gnosysDb.categories.join(", ")}`));
    lines.push(BOX_DIV);
  }

  // Memory by project (was "MEMORY STORES" — populated from central DB in v5.4.1)
  lines.push(header("MEMORY BY PROJECT"));
  lines.push(BOX_DIV);
  for (const s of data.stores) {
    lines.push(row(`  ${s.label}: ${s.memoryCount} memories`));
  }
  lines.push(row(`  Total: ${data.totalMemories} active memories`));

  // Archive (was "ARCHIVE (TWO-TIER MEMORY)" — two-tier was the pre-v5 model)
  if (data.archive) {
    lines.push(BOX_DIV);
    lines.push(header("ARCHIVE"));
    lines.push(BOX_DIV);
    lines.push(row(`  Archived: ${data.archive.totalArchived} memories (${data.archive.dbSizeMB.toFixed(1)} MB)`));
    lines.push(row(`  Eligible for archiving: ${data.archive.archiveEligible}`));
  }

  // Maintenance Health
  if (data.maintenance) {
    lines.push(BOX_DIV);
    lines.push(header("MAINTENANCE HEALTH"));
    lines.push(BOX_DIV);
    const m = data.maintenance;
    lines.push(row(`  Confidence: ${m.avgConfidence.toFixed(3)} raw / ${m.avgDecayedConfidence.toFixed(3)} decayed`));
    lines.push(row(`  Stale: ${m.staleCount} | Never reinforced: ${m.neverReinforced}`));
    lines.push(row(`  Total reinforcements: ${m.totalReinforcements}`));
  }

  // Embeddings
  lines.push(BOX_DIV);
  lines.push(header("EMBEDDINGS"));
  lines.push(BOX_DIV);
  if (data.embeddings) {
    lines.push(row(`  ${data.embeddings.count} vectors (${data.embeddings.dbSizeMB.toFixed(1)} MB)`));
  } else {
    lines.push(row("  Not initialized (run gnosys reindex)"));
  }

  // Wikilink Graph
  lines.push(BOX_DIV);
  lines.push(header("WIKILINK GRAPH"));
  lines.push(BOX_DIV);
  if (data.graph) {
    const g = data.graph;
    lines.push(row(`  ${g.nodes} nodes, ${g.edges} edges, ${g.orphans} orphans`));
    if (g.mostConnected) {
      lines.push(row(`  Most connected: ${g.mostConnected}`));
    }
  } else {
    lines.push(row("  Not built (run gnosys reindex-graph)"));
  }

  // Recall
  lines.push(BOX_DIV);
  lines.push(header("RECALL (AUTOMATIC MEMORY INJECTION)"));
  lines.push(BOX_DIV);
  const recallMode = data.recall.aggressive ? "aggressive" : "filtered";
  lines.push(row(`  Mode: ${recallMode} | Max: ${data.recall.maxMemories} | Min relevance: ${data.recall.minRelevance}`));

  // SOC
  lines.push(BOX_DIV);
  lines.push(header("SYSTEM OF COGNITION (SOC)"));
  lines.push(BOX_DIV);
  lines.push(row(`  Default: ${data.soc.defaultProvider}`));
  lines.push(row(`  Structuring → ${data.soc.structuring.provider}/${data.soc.structuring.model}`));
  lines.push(row(`  Synthesis   → ${data.soc.synthesis.provider}/${data.soc.synthesis.model}`));
  lines.push(row(""));
  for (const p of data.soc.providerStatus) {
    const icon = p.available ? "✓" : "—";
    let note = p.note;
    if (note.includes("Add to environment or gnosys.json")) {
      note = "no API key";
    }
    lines.push(row(`  ${icon} ${p.name}: ${note}`));
  }

  // v5.4.2: Dream Mode health
  if (data.dream) {
    lines.push(BOX_DIV);
    lines.push(header("DREAM HEALTH"));
    lines.push(BOX_DIV);
    const d = data.dream;
    if (!d.enabled) {
      lines.push(row(`  Status:        disabled (run 'gnosys setup dream')`));
    } else if (!d.designatedMachine) {
      lines.push(row(`  Status:        enabled, no machine designated`));
      lines.push(row(`  This machine:  ${d.localMachine || "?"}`));
      lines.push(row(`  Action:        run 'gnosys setup dream' on the machine that should host`));
    } else {
      const ownership = d.isThisMachine ? " (this machine)" : " (other machine)";
      lines.push(row(`  Designated:    ${d.designatedMachine}${ownership}`));
      lines.push(row(`  Provider:      ${d.provider}${d.model ? "/" + d.model : ""}`));
      lines.push(row(`  Last run:      ${d.lastRun || "never"}`));
      lines.push(row(`  Last success:  ${d.lastSuccessfulRun || "never (no LLM work)"}`));
      const failureCount = d.recentFailures;
      const totalRecent = d.recentTotal;
      if (totalRecent > 0) {
        lines.push(row(`  Recent runs:   ${failureCount} failure(s) of last ${totalRecent}`));
      }
      if (d.consecutiveFailures > 0) {
        lines.push(row(`  ⚠ ${d.consecutiveFailures} consecutive provider failure(s)`));
      }
    }
  }

  // Performance (was "PERFORMANCE (ENTERPRISE)")
  if (data.performance) {
    lines.push(BOX_DIV);
    lines.push(header("PERFORMANCE"));
    lines.push(BOX_DIV);
    const perf = data.performance;
    lines.push(row(`  Recall: ${perf.recallMs}ms${perf.recallMs > 50 ? " ⚠ SLOW" : " ✓"}`));
    lines.push(row(`  Active search: ${perf.activeSearchMs}ms`));
    lines.push(row(`  Archive search: ${perf.archiveSearchMs}ms`));
    if (perf.recallMs > 50) {
      lines.push(row("  ⚠ Recall exceeds 50ms target"));
    }
  }

  lines.push(BOX_BOT);

  return lines.join("\n");
}

/**
 * Format dashboard data as structured JSON for MCP tool consumption.
 */
export function formatDashboardJSON(data: DashboardData): string {
  return JSON.stringify(data, null, 2);
}
