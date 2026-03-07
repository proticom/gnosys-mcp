import { describe, it, expect } from "vitest";
import {
  extractLinks,
  resolveLink,
  buildLinkGraph,
  getBacklinks,
  getOutgoingLinks,
  formatGraphSummary,
} from "../lib/wikilinks.js";
import { Memory, MemoryFrontmatter } from "../lib/store.js";

function makeMem(
  overrides: Partial<MemoryFrontmatter> & { content?: string } = {}
): Memory {
  const { content: body, ...fmOverrides } = overrides;
  const frontmatter: MemoryFrontmatter = {
    id: "test-001",
    title: "Test Memory",
    category: "decisions",
    tags: { domain: ["testing"] },
    relevance: "test",
    author: "human",
    authority: "declared",
    confidence: 0.8,
    created: "2026-02-15",
    modified: "2026-02-15",
    status: "active",
    supersedes: null,
    ...fmOverrides,
  };
  return {
    frontmatter,
    content: body ?? "# Test",
    filePath: `/tmp/${frontmatter.category}/${frontmatter.id}.md`,
    relativePath: `${frontmatter.category}/${frontmatter.id}.md`,
  };
}

const memories: Memory[] = [
  makeMem({
    id: "auth-decision",
    title: "Auth Decision",
    category: "decisions",
    content: "# Auth Decision\n\nWe chose JWT. See [[DB Choice]] and [[architecture/three-layers]].",
  }),
  makeMem({
    id: "db-choice",
    title: "DB Choice",
    category: "decisions",
    content: "# DB Choice\n\nPostgres. Related to [[Auth Decision|our auth approach]].",
  }),
  makeMem({
    id: "three-layers",
    title: "Three Layers",
    category: "architecture",
    content: "# Three Layers\n\nPresentation, domain, data.",
  }),
  makeMem({
    id: "frontend-guide",
    title: "Frontend Guide",
    category: "conventions",
    content: "# Frontend Guide\n\nSee [[Nonexistent Memory]] and [[Auth Decision]].",
  }),
];

describe("extractLinks", () => {
  it("extracts simple wikilinks", () => {
    const links = extractLinks(memories[0]);
    expect(links).toHaveLength(2);
    expect(links[0].target).toBe("DB Choice");
    expect(links[0].displayText).toBeNull();
    expect(links[1].target).toBe("architecture/three-layers");
  });

  it("extracts wikilinks with display text", () => {
    const links = extractLinks(memories[1]);
    expect(links).toHaveLength(1);
    expect(links[0].target).toBe("Auth Decision");
    expect(links[0].displayText).toBe("our auth approach");
  });

  it("returns empty array for content with no links", () => {
    const links = extractLinks(memories[2]);
    expect(links).toHaveLength(0);
  });

  it("includes source info", () => {
    const links = extractLinks(memories[0]);
    expect(links[0].sourcePath).toBe("decisions/auth-decision.md");
    expect(links[0].sourceTitle).toBe("Auth Decision");
  });
});

describe("resolveLink", () => {
  it("resolves by title (case-insensitive)", () => {
    const result = resolveLink("DB Choice", memories);
    expect(result?.frontmatter.id).toBe("db-choice");
  });

  it("resolves by title case-insensitively", () => {
    const result = resolveLink("db choice", memories);
    expect(result?.frontmatter.id).toBe("db-choice");
  });

  it("resolves by relative path", () => {
    const result = resolveLink("architecture/three-layers.md", memories);
    expect(result?.frontmatter.id).toBe("three-layers");
  });

  it("resolves by filename without extension", () => {
    const result = resolveLink("three-layers", memories);
    expect(result?.frontmatter.id).toBe("three-layers");
  });

  it("resolves by id", () => {
    const result = resolveLink("auth-decision", memories);
    expect(result?.frontmatter.id).toBe("auth-decision");
  });

  it("returns null for non-existent target", () => {
    const result = resolveLink("Nonexistent Memory", memories);
    expect(result).toBeNull();
  });
});

describe("buildLinkGraph", () => {
  it("builds graph with correct link counts", () => {
    const graph = buildLinkGraph(memories);
    expect(graph.totalLinks).toBe(5); // 2 + 1 + 0 + 2
  });

  it("tracks outgoing links", () => {
    const graph = buildLinkGraph(memories);
    const authNode = graph.nodes.get("decisions/auth-decision.md");
    expect(authNode?.outgoing).toHaveLength(2);
  });

  it("tracks backlinks (incoming)", () => {
    const graph = buildLinkGraph(memories);
    // Auth Decision is linked to by DB Choice and Frontend Guide
    const authNode = graph.nodes.get("decisions/auth-decision.md");
    expect(authNode?.incoming).toHaveLength(2);
    const sources = authNode?.incoming.map((l) => l.sourceTitle);
    expect(sources).toContain("DB Choice");
    expect(sources).toContain("Frontend Guide");
  });

  it("identifies orphaned links", () => {
    const graph = buildLinkGraph(memories);
    expect(graph.orphanedLinks).toHaveLength(1);
    expect(graph.orphanedLinks[0].target).toBe("Nonexistent Memory");
    expect(graph.orphanedLinks[0].sourceTitle).toBe("Frontend Guide");
  });

  it("handles memories with no links", () => {
    const graph = buildLinkGraph(memories);
    const layersNode = graph.nodes.get("architecture/three-layers.md");
    expect(layersNode?.outgoing).toHaveLength(0);
    // But it has incoming from Auth Decision
    expect(layersNode?.incoming).toHaveLength(1);
  });

  it("handles empty memory list", () => {
    const graph = buildLinkGraph([]);
    expect(graph.totalLinks).toBe(0);
    expect(graph.orphanedLinks).toHaveLength(0);
    expect(graph.nodes.size).toBe(0);
  });
});

describe("getBacklinks", () => {
  it("returns backlinks for a target", () => {
    const backlinks = getBacklinks(memories, "decisions/auth-decision.md");
    expect(backlinks).toHaveLength(2);
  });

  it("returns empty for memory with no backlinks", () => {
    const backlinks = getBacklinks(memories, "conventions/frontend-guide.md");
    expect(backlinks).toHaveLength(0);
  });
});

describe("getOutgoingLinks", () => {
  it("returns outgoing links for a source", () => {
    const outgoing = getOutgoingLinks(memories, "decisions/auth-decision.md");
    expect(outgoing).toHaveLength(2);
  });

  it("returns empty for memory with no outgoing links", () => {
    const outgoing = getOutgoingLinks(memories, "architecture/three-layers.md");
    expect(outgoing).toHaveLength(0);
  });
});

describe("formatGraphSummary", () => {
  it("produces a readable summary", () => {
    const graph = buildLinkGraph(memories);
    const summary = formatGraphSummary(graph);
    expect(summary).toContain("5 total links");
    expect(summary).toContain("1 orphaned");
    expect(summary).toContain("Auth Decision");
    expect(summary).toContain("Nonexistent Memory");
  });

  it("handles empty graph", () => {
    const graph = buildLinkGraph([]);
    const summary = formatGraphSummary(graph);
    expect(summary).toContain("0 total links");
    expect(summary).toContain("No cross-references found");
  });
});
