/**
 * Gnosys Graph — Persistent wikilink graph stored as .gnosys/graph.json.
 * Fully regeneratable sidecar file. Parses all [[wikilinks]] from memories
 * and builds a JSON graph with nodes, edges, and stats.
 */

import fs from "fs/promises";
import path from "path";
import { GnosysResolver } from "./resolver.js";
import { buildLinkGraph, LinkGraph } from "./wikilinks.js";
import { Memory } from "./store.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string; // relativePath
  title: string;
  edges: number; // total connections (outgoing + incoming)
  outgoing: number;
  incoming: number;
}

export interface GraphEdge {
  source: string; // relativePath
  target: string; // relativePath
  label: string; // wikilink target text
}

export interface GraphJSON {
  /** ISO timestamp of generation */
  generated: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  orphanNodes: number; // nodes with zero edges
  orphanLinks: number; // wikilinks that don't resolve
  mostConnected: { id: string; title: string; edges: number } | null;
  avgEdgesPerNode: number;
}

// ─── Build & Persist ────────────────────────────────────────────────────

/**
 * Build the wikilink graph from all stores and write to .gnosys/graph.json.
 */
export async function reindexGraph(
  resolver: GnosysResolver,
  onLog?: (message: string) => void
): Promise<GraphStats> {
  const stores = resolver.getStores();
  if (stores.length === 0) {
    throw new Error("No Gnosys stores found.");
  }

  // Collect all memories across stores
  const allMemories: Memory[] = [];
  for (const s of stores) {
    const memories = await s.store.getAllMemories();
    allMemories.push(...memories);
  }

  onLog?.(`Scanning ${allMemories.length} memories for [[wikilinks]]...`);

  // Build the in-memory link graph using existing wikilinks module
  const linkGraph = buildLinkGraph(allMemories);

  // Convert to serializable format
  const graphJSON = linkGraphToJSON(linkGraph);

  onLog?.(`Found ${graphJSON.stats.totalEdges} edges across ${graphJSON.stats.totalNodes} nodes`);

  // Write to the first store's path
  const graphPath = path.join(stores[0].path, "graph.json");
  await fs.writeFile(graphPath, JSON.stringify(graphJSON, null, 2) + "\n", "utf-8");

  onLog?.(`Graph written to ${graphPath}`);

  return graphJSON.stats;
}

/**
 * Convert an in-memory LinkGraph to a serializable GraphJSON.
 */
function linkGraphToJSON(graph: LinkGraph): GraphJSON {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const [nodePath, node] of graph.nodes) {
    nodes.push({
      id: nodePath,
      title: node.title,
      edges: node.outgoing.length + node.incoming.length,
      outgoing: node.outgoing.length,
      incoming: node.incoming.length,
    });

    // Add edges (only from outgoing to avoid duplicates)
    for (const link of node.outgoing) {
      // Find the resolved target path
      const targetNode = Array.from(graph.nodes.values()).find(
        (n) =>
          n.title.toLowerCase() === link.target.toLowerCase() ||
          n.path === link.target ||
          n.path === link.target + ".md" ||
          n.path.split("/").pop()?.replace(/\.md$/, "") === link.target
      );
      if (targetNode) {
        edges.push({
          source: nodePath,
          target: targetNode.path,
          label: link.target,
        });
      }
    }
  }

  // Sort nodes by edge count (most connected first)
  nodes.sort((a, b) => b.edges - a.edges);

  const orphanNodes = nodes.filter((n) => n.edges === 0).length;
  const mostConnected = nodes.length > 0 && nodes[0].edges > 0
    ? { id: nodes[0].id, title: nodes[0].title, edges: nodes[0].edges }
    : null;
  const avgEdgesPerNode = nodes.length > 0
    ? edges.length * 2 / nodes.length // each edge touches 2 nodes
    : 0;

  return {
    generated: new Date().toISOString(),
    nodes,
    edges,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      orphanNodes,
      orphanLinks: graph.orphanedLinks.length,
      mostConnected,
      avgEdgesPerNode: Math.round(avgEdgesPerNode * 100) / 100,
    },
  };
}

/**
 * Load the persisted graph from .gnosys/graph.json.
 */
export async function loadGraph(storePath: string): Promise<GraphJSON | null> {
  try {
    const graphPath = path.join(storePath, "graph.json");
    const raw = await fs.readFile(graphPath, "utf-8");
    return JSON.parse(raw) as GraphJSON;
  } catch {
    return null;
  }
}

/**
 * Format graph stats for display.
 */
export function formatGraphStats(stats: GraphStats): string {
  const lines: string[] = [];
  lines.push(`Wikilink Graph:`);
  lines.push(`  Nodes: ${stats.totalNodes}`);
  lines.push(`  Edges: ${stats.totalEdges}`);
  lines.push(`  Orphan nodes (no links): ${stats.orphanNodes}`);
  lines.push(`  Orphan links (unresolved): ${stats.orphanLinks}`);
  lines.push(`  Avg edges/node: ${stats.avgEdgesPerNode}`);
  if (stats.mostConnected) {
    lines.push(`  Most connected: ${stats.mostConnected.title} (${stats.mostConnected.edges} edges)`);
  }
  return lines.join("\n");
}
