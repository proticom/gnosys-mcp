import { describe, it, expect } from "vitest";
import { applyLens, applyCompoundLens, LensFilter, CompoundLens } from "../lib/lensing.js";
import { Memory, MemoryFrontmatter } from "../lib/store.js";

function makeMem(overrides: Partial<MemoryFrontmatter> & { content?: string } = {}): Memory {
  const { content: body, ...fmOverrides } = overrides;
  const frontmatter: MemoryFrontmatter = {
    id: "test-001",
    title: "Test Memory",
    category: "decisions",
    tags: { domain: ["auth"], type: ["decision"] },
    relevance: "test",
    author: "human",
    authority: "declared",
    confidence: 0.8,
    created: "2026-02-15",
    modified: "2026-02-20",
    status: "active",
    supersedes: null,
    ...fmOverrides,
  };
  return {
    frontmatter,
    content: body ?? "# Test",
    filePath: `/tmp/test/${frontmatter.category}/${frontmatter.id}.md`,
    relativePath: `${frontmatter.category}/${frontmatter.id}.md`,
  };
}

const memories: Memory[] = [
  makeMem({ id: "d1", title: "Auth Decision", category: "decisions", tags: { domain: ["auth", "security"], type: ["decision"] }, confidence: 0.9, author: "human", authority: "declared", created: "2026-01-10", modified: "2026-01-15", status: "active" }),
  makeMem({ id: "d2", title: "DB Choice", category: "decisions", tags: { domain: ["database"], type: ["decision"] }, confidence: 0.85, author: "human+ai", authority: "declared", created: "2026-02-01", modified: "2026-02-10", status: "active" }),
  makeMem({ id: "a1", title: "Three Layers", category: "architecture", tags: { domain: ["backend"], type: ["concept"] }, confidence: 0.7, author: "ai", authority: "observed", created: "2026-02-15", modified: "2026-03-01", status: "active" }),
  makeMem({ id: "c1", title: "Old Concept", category: "concepts", tags: { domain: ["frontend"], type: ["observation"] }, confidence: 0.5, author: "ai", authority: "inferred", created: "2025-12-01", modified: "2025-12-15", status: "superseded" }),
  makeMem({ id: "a2", title: "Archived Arch", category: "architecture", tags: { domain: ["devops"], type: ["convention"] }, confidence: 0.6, author: "human", authority: "declared", created: "2026-01-20", modified: "2026-02-01", status: "archived" }),
];

describe("applyLens — single filters", () => {
  it("filters by category", () => {
    const result = applyLens(memories, { category: "decisions" });
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.frontmatter.id)).toEqual(["d1", "d2"]);
  });

  it("filters by status", () => {
    const result = applyLens(memories, { status: ["active"] });
    expect(result).toHaveLength(3);
  });

  it("filters by multiple statuses", () => {
    const result = applyLens(memories, { status: ["archived", "superseded"] });
    expect(result).toHaveLength(2);
  });

  it("filters by tag (any mode)", () => {
    const result = applyLens(memories, { tags: ["auth", "database"] });
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.frontmatter.id)).toEqual(["d1", "d2"]);
  });

  it("filters by tag (all mode)", () => {
    const result = applyLens(memories, { tags: ["auth", "security"], tagMatchMode: "all" });
    expect(result).toHaveLength(1);
    expect(result[0].frontmatter.id).toBe("d1");
  });

  it("filters by confidence range", () => {
    const result = applyLens(memories, { minConfidence: 0.8, maxConfidence: 0.9 });
    expect(result).toHaveLength(2);
  });

  it("filters by author", () => {
    const result = applyLens(memories, { author: ["ai"] });
    expect(result).toHaveLength(2);
  });

  it("filters by authority", () => {
    const result = applyLens(memories, { authority: ["observed", "inferred"] });
    expect(result).toHaveLength(2);
  });

  it("filters by created date range", () => {
    const result = applyLens(memories, { createdAfter: "2026-02-01", createdBefore: "2026-03-01" });
    expect(result).toHaveLength(2); // d2 and a1
  });

  it("filters by modified date range", () => {
    const result = applyLens(memories, { modifiedAfter: "2026-02-01" });
    expect(result).toHaveLength(3); // d2, a1, a2
  });

  it("empty filter returns all memories", () => {
    const result = applyLens(memories, {});
    expect(result).toHaveLength(5);
  });

  it("combines multiple criteria in one filter", () => {
    const result = applyLens(memories, {
      category: "decisions",
      minConfidence: 0.85,
      status: ["active"],
    });
    expect(result).toHaveLength(2); // d1 (0.9) and d2 (0.85)
  });
});

describe("applyCompoundLens", () => {
  it("AND: all filters must match", () => {
    const compound: CompoundLens = {
      operator: "AND",
      filters: [
        { category: "decisions" },
        { minConfidence: 0.88 },
      ],
    };
    const result = applyCompoundLens(memories, compound);
    expect(result).toHaveLength(1);
    expect(result[0].frontmatter.id).toBe("d1");
  });

  it("OR: any filter can match", () => {
    const compound: CompoundLens = {
      operator: "OR",
      filters: [
        { category: "concepts" },
        { category: "architecture" },
      ],
    };
    const result = applyCompoundLens(memories, compound);
    expect(result).toHaveLength(3); // a1, c1, a2
  });

  it("AND with no overlap returns empty", () => {
    const compound: CompoundLens = {
      operator: "AND",
      filters: [
        { category: "decisions" },
        { category: "architecture" },
      ],
    };
    const result = applyCompoundLens(memories, compound);
    expect(result).toHaveLength(0);
  });

  it("OR deduplicates results", () => {
    const compound: CompoundLens = {
      operator: "OR",
      filters: [
        { status: ["active"] },
        { category: "decisions" }, // d1 and d2 are already in active
      ],
    };
    const result = applyCompoundLens(memories, compound);
    expect(result).toHaveLength(3); // d1, d2, a1 — no duplicates
  });

  it("empty filters array returns all", () => {
    const result = applyCompoundLens(memories, { operator: "AND", filters: [] });
    expect(result).toHaveLength(5);
  });

  it("complex compound: decisions AND high-confidence AND recent", () => {
    const compound: CompoundLens = {
      operator: "AND",
      filters: [
        { category: "decisions" },
        { minConfidence: 0.85 },
        { createdAfter: "2026-01-01" },
      ],
    };
    const result = applyCompoundLens(memories, compound);
    expect(result).toHaveLength(2); // d1 and d2
  });
});
