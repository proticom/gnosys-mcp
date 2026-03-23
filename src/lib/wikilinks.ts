/**
 * Gnosys Wikilinks — Obsidian-compatible cross-references between memories.
 *
 * Scans memory content for [[wikilinks]] and builds a link graph.
 * Supports both [[title]] and [[path|display text]] formats.
 */

import { Memory } from "./store.js";

/** A single link found in a memory. */
export interface WikiLink {
  /** The raw target inside [[ ]] — could be a title or relative path */
  target: string;
  /** Optional display text (from [[target|display]]) */
  displayText: string | null;
  /** The source memory's relative path */
  sourcePath: string;
  /** The source memory's title */
  sourceTitle: string;
}

/** A node in the link graph with both outgoing and incoming links. */
export interface LinkNode {
  /** This memory's relative path */
  path: string;
  /** This memory's title */
  title: string;
  /** Links going OUT from this memory */
  outgoing: WikiLink[];
  /** Backlinks coming IN to this memory */
  incoming: WikiLink[];
}

/** Full link graph across all memories. */
export interface LinkGraph {
  nodes: Map<string, LinkNode>;
  /** Total number of wikilinks found */
  totalLinks: number;
  /** Targets that don't resolve to any known memory */
  orphanedLinks: WikiLink[];
}

// Regex to match [[target]] or [[target|display text]]
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

/**
 * Extract all wikilinks from a memory's content.
 */
export function extractLinks(memory: Memory): WikiLink[] {
  const links: WikiLink[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  WIKILINK_RE.lastIndex = 0;

  while ((match = WIKILINK_RE.exec(memory.content)) !== null) {
    links.push({
      target: match[1].trim(),
      displayText: match[2]?.trim() || null,
      sourcePath: memory.relativePath,
      sourceTitle: memory.frontmatter.title,
    });
  }

  return links;
}

/**
 * Resolve a wikilink target to a memory.
 * Tries matching by: exact relative path, title (case-insensitive), id.
 */
export function resolveLink(
  target: string,
  memories: Memory[]
): Memory | null {
  // 1. Exact relative path match
  const byPath = memories.find((m) => m.relativePath === target);
  if (byPath) return byPath;

  // 2. Path with .md extension
  const withMd = memories.find((m) => m.relativePath === target + ".md");
  if (withMd) return withMd;

  // 3. Filename match (target might be just the filename without category dir)
  const byFilename = memories.find((m) => {
    const filename = m.relativePath.split("/").pop()?.replace(/\.md$/, "");
    return filename === target;
  });
  if (byFilename) return byFilename;

  // 4. Title match (case-insensitive)
  const lowerTarget = target.toLowerCase();
  const byTitle = memories.find(
    (m) => m.frontmatter.title.toLowerCase() === lowerTarget
  );
  if (byTitle) return byTitle;

  // 5. ID match
  const byId = memories.find((m) => m.frontmatter.id === target);
  if (byId) return byId;

  return null;
}

/**
 * Build a full link graph from all memories.
 */
export function buildLinkGraph(memories: Memory[]): LinkGraph {
  const nodes = new Map<string, LinkNode>();
  const orphanedLinks: WikiLink[] = [];
  let totalLinks = 0;

  // Initialize nodes for all memories
  for (const m of memories) {
    nodes.set(m.relativePath, {
      path: m.relativePath,
      title: m.frontmatter.title,
      outgoing: [],
      incoming: [],
    });
  }

  // Extract links and resolve them
  for (const m of memories) {
    const links = extractLinks(m);
    totalLinks += links.length;

    for (const link of links) {
      const resolved = resolveLink(link.target, memories);

      if (resolved) {
        // Add outgoing link to source
        const sourceNode = nodes.get(m.relativePath)!;
        sourceNode.outgoing.push(link);

        // Add backlink to target
        const targetNode = nodes.get(resolved.relativePath)!;
        targetNode.incoming.push(link);
      } else {
        orphanedLinks.push(link);
      }
    }
  }

  return { nodes, totalLinks, orphanedLinks };
}

/**
 * Get backlinks for a specific memory.
 */
export function getBacklinks(
  memories: Memory[],
  targetPath: string
): WikiLink[] {
  const graph = buildLinkGraph(memories);
  const node = graph.nodes.get(targetPath);
  return node?.incoming || [];
}

/**
 * Get outgoing links for a specific memory.
 */
export function getOutgoingLinks(
  memories: Memory[],
  sourcePath: string
): WikiLink[] {
  const graph = buildLinkGraph(memories);
  const node = graph.nodes.get(sourcePath);
  return node?.outgoing || [];
}

/**
 * Format the link graph as a simple text summary.
 */
export function formatGraphSummary(graph: LinkGraph): string {
  const lines: string[] = [];

  lines.push(`Link Graph: ${graph.totalLinks} total links, ${graph.orphanedLinks.length} orphaned\n`);

  // Find most-connected nodes
  const connected = Array.from(graph.nodes.values())
    .filter((n) => n.outgoing.length > 0 || n.incoming.length > 0)
    .sort((a, b) => (b.incoming.length + b.outgoing.length) - (a.incoming.length + a.outgoing.length));

  if (connected.length === 0) {
    lines.push("No cross-references found. Use [[Title]] in memory content to create links.");
    return lines.join("\n");
  }

  for (const node of connected) {
    lines.push(`**${node.title}** (${node.path})`);
    lines.push(`  → ${node.outgoing.length} outgoing, ← ${node.incoming.length} backlinks`);

    if (node.outgoing.length > 0) {
      const targets = node.outgoing.map((l) => l.displayText || l.target).join(", ");
      lines.push(`  Links to: ${targets}`);
    }
    if (node.incoming.length > 0) {
      const sources = node.incoming.map((l) => l.sourceTitle).join(", ");
      lines.push(`  Referenced by: ${sources}`);
    }
    lines.push("");
  }

  if (graph.orphanedLinks.length > 0) {
    lines.push("Orphaned links (targets not found):");
    for (const link of graph.orphanedLinks) {
      lines.push(`  [[${link.target}]] in ${link.sourceTitle}`);
    }
  }

  return lines.join("\n");
}
