/**
 * Gnosys Dashboard — Aggregated system status in a pretty terminal display.
 * Combines memory stats, maintenance health, graph stats, and LLM routing.
 */

import { GnosysResolver } from "./resolver.js";
import {
  GnosysConfig,
  DEFAULT_CONFIG,
  resolveTaskModel,
  ALL_PROVIDERS,
  LLMProviderName,
} from "./config.js";
import { isProviderAvailable } from "./llm.js";
import { GnosysEmbeddings } from "./embeddings.js";
import fs from "fs/promises";
import path from "path";

// ─── Types ──────────────────────────────────────────────────────────────

export interface DashboardData {
  stores: Array<{ label: string; path: string; memoryCount: number }>;
  totalMemories: number;
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
  version: string;
}

// ─── Data Collection ────────────────────────────────────────────────────

export async function collectDashboardData(
  resolver: GnosysResolver,
  config: GnosysConfig,
  version: string
): Promise<DashboardData> {
  const stores = resolver.getStores();

  // Memory counts
  const storeData: DashboardData["stores"] = [];
  let totalMemories = 0;
  for (const s of stores) {
    const memories = await s.store.getAllMemories();
    storeData.push({ label: s.label, path: s.path, memoryCount: memories.length });
    totalMemories += memories.length;
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
    providerStatus.push({
      name: p,
      available: status.available,
      note: status.available ? "ready" : (status.error || "not configured"),
    });
  }

  return {
    stores: storeData,
    totalMemories,
    maintenance,
    embeddings,
    graph,
    soc: {
      defaultProvider: config.llm.defaultProvider,
      structuring,
      synthesis,
      providerStatus,
    },
    version,
  };
}

// ─── Pretty Terminal Formatting ─────────────────────────────────────────

export function formatDashboard(data: DashboardData): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════╗");
  lines.push(`║          GNOSYS DASHBOARD  v${data.version.padEnd(24)}║`);
  lines.push("╠══════════════════════════════════════════════════════╣");

  // Memory Stats
  lines.push("║  MEMORY STORES                                      ║");
  lines.push("╟──────────────────────────────────────────────────────╢");
  for (const s of data.stores) {
    const label = `  ${s.label}: ${s.memoryCount} memories`.padEnd(53);
    lines.push(`║${label}║`);
  }
  const total = `  Total: ${data.totalMemories} memories`.padEnd(53);
  lines.push(`║${total}║`);

  // Maintenance Health
  if (data.maintenance) {
    lines.push("╟──────────────────────────────────────────────────────╢");
    lines.push("║  MAINTENANCE HEALTH                                 ║");
    lines.push("╟──────────────────────────────────────────────────────╢");
    const m = data.maintenance;
    const conf = `  Confidence: ${m.avgConfidence.toFixed(3)} raw / ${m.avgDecayedConfidence.toFixed(3)} decayed`.padEnd(53);
    lines.push(`║${conf}║`);
    const stale = `  Stale: ${m.staleCount} | Never reinforced: ${m.neverReinforced}`.padEnd(53);
    lines.push(`║${stale}║`);
    const reinf = `  Total reinforcements: ${m.totalReinforcements}`.padEnd(53);
    lines.push(`║${reinf}║`);
  }

  // Embeddings
  lines.push("╟──────────────────────────────────────────────────────╢");
  lines.push("║  EMBEDDINGS                                         ║");
  lines.push("╟──────────────────────────────────────────────────────╢");
  if (data.embeddings) {
    const emb = `  ${data.embeddings.count} vectors (${data.embeddings.dbSizeMB.toFixed(1)} MB)`.padEnd(53);
    lines.push(`║${emb}║`);
  } else {
    lines.push("║  Not initialized (run gnosys reindex)               ║");
  }

  // Graph
  lines.push("╟──────────────────────────────────────────────────────╢");
  lines.push("║  WIKILINK GRAPH                                     ║");
  lines.push("╟──────────────────────────────────────────────────────╢");
  if (data.graph) {
    const g = data.graph;
    const stats = `  ${g.nodes} nodes, ${g.edges} edges, ${g.orphans} orphans`.padEnd(53);
    lines.push(`║${stats}║`);
    if (g.mostConnected) {
      const mc = `  Most connected: ${g.mostConnected}`.substring(0, 53).padEnd(53);
      lines.push(`║${mc}║`);
    }
  } else {
    lines.push("║  Not built (run gnosys reindex-graph)               ║");
  }

  // SOC
  lines.push("╟──────────────────────────────────────────────────────╢");
  lines.push("║  SYSTEM OF COGNITION (SOC)                          ║");
  lines.push("╟──────────────────────────────────────────────────────╢");
  const defP = `  Default: ${data.soc.defaultProvider}`.padEnd(53);
  lines.push(`║${defP}║`);
  const strLine = `  Structuring → ${data.soc.structuring.provider}/${data.soc.structuring.model}`.substring(0, 53).padEnd(53);
  lines.push(`║${strLine}║`);
  const synLine = `  Synthesis   → ${data.soc.synthesis.provider}/${data.soc.synthesis.model}`.substring(0, 53).padEnd(53);
  lines.push(`║${synLine}║`);
  lines.push("║                                                      ║");
  for (const p of data.soc.providerStatus) {
    const icon = p.available ? "✓" : "—";
    // Shorten common error messages to fit the box
    let note = p.note;
    if (note.includes("Add to environment or gnosys.json")) {
      note = "no API key";
    }
    const pLine = `  ${icon} ${p.name}: ${note}`.substring(0, 53).padEnd(53);
    lines.push(`║${pLine}║`);
  }

  lines.push("╚══════════════════════════════════════════════════════╝");

  return lines.join("\n");
}

/**
 * Format dashboard data as structured JSON for MCP tool consumption.
 */
export function formatDashboardJSON(data: DashboardData): string {
  return JSON.stringify(data, null, 2);
}
