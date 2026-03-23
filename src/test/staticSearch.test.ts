/**
 * Tests for staticSearch.ts — Zero-dependency runtime search module.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import {
  loadIndex,
  clearIndexCache,
  search,
  getDocument,
  listDocuments,
} from "../lib/staticSearch.js";
import type { GnosysWebIndex, DocumentManifest } from "../lib/staticSearch.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

function makeIndex(overrides: Partial<GnosysWebIndex> = {}): GnosysWebIndex {
  return {
    version: 1,
    generated: new Date().toISOString(),
    documentCount: 0,
    documents: [],
    invertedIndex: {},
    ...overrides,
  };
}

function makeDoc(overrides: Partial<DocumentManifest> = {}): DocumentManifest {
  return {
    id: "doc-001",
    path: "general/doc.md",
    title: "Test Document",
    category: "general",
    tags: ["test"],
    relevance: "test document general",
    contentHash: "abc123",
    contentLength: 100,
    created: "2026-03-01",
    status: "active",
    ...overrides,
  };
}

function makeSampleIndex(): GnosysWebIndex {
  const docs: DocumentManifest[] = [
    makeDoc({
      id: "blog-001",
      path: "blog/ai-chatbot.md",
      title: "Building AI Chatbots",
      category: "blog",
      tags: ["ai", "chatbot"],
      relevance: "artificial intelligence chatbot conversational agent",
    }),
    makeDoc({
      id: "svc-001",
      path: "services/automation.md",
      title: "Agentic Automation",
      category: "services",
      tags: ["automation", "ai"],
      relevance: "automation agentic workflow process",
    }),
    makeDoc({
      id: "prod-001",
      path: "products/mavenn.md",
      title: "Mavenn Platform",
      category: "products",
      tags: ["product", "saas"],
      relevance: "mavenn platform saas product",
    }),
    makeDoc({
      id: "faq-001",
      path: "company/faqs.md",
      title: "Frequently Asked Questions",
      category: "company",
      tags: ["faq", "support"],
      relevance: "faq questions answers support help",
      created: new Date().toISOString(), // recent
    }),
    makeDoc({
      id: "arch-001",
      path: "blog/archived-post.md",
      title: "Old Post",
      category: "blog",
      tags: ["blog"],
      relevance: "old archived legacy",
      status: "archived",
    }),
  ];

  // Build a simple inverted index
  const invertedIndex: Record<string, Array<{ docIndex: number; score: number }>> = {};

  function addToken(token: string, docIndex: number, score: number) {
    if (!invertedIndex[token]) invertedIndex[token] = [];
    invertedIndex[token].push({ docIndex, score });
  }

  // blog-001 (index 0)
  addToken("artificial", 0, 2.1);
  addToken("intelligence", 0, 2.1);
  addToken("chatbot", 0, 3.5);
  addToken("conversational", 0, 2.1);
  addToken("agent", 0, 2.1);
  addToken("building", 0, 1.5);

  // svc-001 (index 1)
  addToken("automation", 1, 3.5);
  addToken("agentic", 1, 2.1);
  addToken("workflow", 1, 2.1);
  addToken("process", 1, 2.1);

  // prod-001 (index 2)
  addToken("mavenn", 2, 3.5);
  addToken("platform", 2, 3.5);
  addToken("saas", 2, 3.5);
  addToken("product", 2, 3.5);

  // faq-001 (index 3)
  addToken("faq", 3, 3.5);
  addToken("questions", 3, 3.5);
  addToken("answers", 3, 2.1);
  addToken("support", 3, 3.5);
  addToken("help", 3, 2.1);

  // arch-001 (index 4)
  addToken("old", 4, 2.1);
  addToken("archived", 4, 2.1);
  addToken("legacy", 4, 2.1);

  return makeIndex({
    documentCount: docs.length,
    documents: docs,
    invertedIndex,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-static-search-"));
  clearIndexCache();
});

afterEach(async () => {
  clearIndexCache();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ─── loadIndex ───────────────────────────────────────────────────────────

describe("loadIndex", () => {
  it("loads from a file path", () => {
    const index = makeSampleIndex();
    const filePath = path.join(tmpDir, "gnosys-index.json");
    fs.writeFileSync(filePath, JSON.stringify(index), "utf-8");

    const loaded = loadIndex(filePath);
    expect(loaded.version).toBe(1);
    expect(loaded.documentCount).toBe(5);
  });

  it("loads from a JSON string", () => {
    const index = makeSampleIndex();
    const loaded = loadIndex(JSON.stringify(index));
    expect(loaded.version).toBe(1);
    expect(loaded.documentCount).toBe(5);
  });

  it("caches repeated calls with same source", () => {
    const index = makeSampleIndex();
    const json = JSON.stringify(index);
    const loaded1 = loadIndex(json);
    const loaded2 = loadIndex(json);
    expect(loaded1).toBe(loaded2); // same reference
  });

  it("throws on invalid JSON", () => {
    expect(() => loadIndex("{not valid json")).toThrow("Invalid JSON");
  });

  it("throws on missing version field", () => {
    expect(() => loadIndex(JSON.stringify({ documents: [] }))).toThrow("missing or invalid version");
  });

  it("throws on unsupported version", () => {
    const index = makeIndex({ version: 99 });
    expect(() => loadIndex(JSON.stringify(index))).toThrow("version 99 is not supported");
  });

  it("throws on missing file", () => {
    expect(() => loadIndex("/nonexistent/path/index.json")).toThrow("not found");
  });
});

// ─── search ──────────────────────────────────────────────────────────────

describe("search", () => {
  let index: GnosysWebIndex;

  beforeEach(() => {
    index = makeSampleIndex();
  });

  it("returns empty array for no matches", () => {
    const results = search(index, "xyznonexistent");
    expect(results).toEqual([]);
  });

  it("returns results sorted by score descending", () => {
    const results = search(index, "chatbot agent");
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("respects limit option", () => {
    const results = search(index, "support help faq questions", { limit: 1 });
    expect(results.length).toBe(1);
  });

  it("respects minScore threshold", () => {
    const results = search(index, "chatbot", { minScore: 100 });
    expect(results).toEqual([]);
  });

  it("filters by category", () => {
    const results = search(index, "chatbot agent automation", { category: "services" });
    for (const r of results) {
      expect(r.document.category).toBe("services");
    }
  });

  it("filters by tags", () => {
    const results = search(index, "chatbot automation mavenn support", { tags: ["ai"] });
    for (const r of results) {
      expect(r.document.tags).toContain("ai");
    }
  });

  it("matches relevance keywords", () => {
    const results = search(index, "mavenn");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.id).toBe("prod-001");
  });

  it("handles multi-word queries", () => {
    const results = search(index, "artificial intelligence chatbot");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchedTokens.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty for single-character queries", () => {
    const results = search(index, "a");
    expect(results).toEqual([]);
  });

  it("is case-insensitive", () => {
    const lower = search(index, "chatbot");
    const upper = search(index, "CHATBOT");
    expect(lower.length).toBe(upper.length);
    if (lower.length > 0) {
      expect(lower[0].document.id).toBe(upper[0].document.id);
    }
  });

  it("strips punctuation from query", () => {
    const clean = search(index, "chatbot");
    const punctuated = search(index, "chatbot!!!");
    expect(clean.length).toBe(punctuated.length);
  });

  it("returns matchedTokens in results", () => {
    const results = search(index, "chatbot agent");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchedTokens).toContain("chatbot");
  });

  it("boosts recent documents when boostRecent is true", () => {
    // faq-001 has a recent created date
    const withoutBoost = search(index, "support help", { boostRecent: false });
    const withBoost = search(index, "support help", { boostRecent: true });

    // Both should return faq-001
    expect(withoutBoost.length).toBeGreaterThan(0);
    expect(withBoost.length).toBeGreaterThan(0);

    // Boosted score should be higher
    const faqWithout = withoutBoost.find((r) => r.document.id === "faq-001");
    const faqWith = withBoost.find((r) => r.document.id === "faq-001");
    if (faqWithout && faqWith) {
      expect(faqWith.score).toBeGreaterThan(faqWithout.score);
    }
  });

  it("returns empty array for empty query", () => {
    expect(search(index, "")).toEqual([]);
    expect(search(index, "   ")).toEqual([]);
  });
});

// ─── getDocument ─────────────────────────────────────────────────────────

describe("getDocument", () => {
  let index: GnosysWebIndex;

  beforeEach(() => {
    index = makeSampleIndex();
  });

  it("returns document by ID", () => {
    const doc = getDocument(index, "blog-001");
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("Building AI Chatbots");
  });

  it("returns document by path", () => {
    const doc = getDocument(index, "blog/ai-chatbot.md");
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe("blog-001");
  });

  it("returns null for non-existent document", () => {
    expect(getDocument(index, "nonexistent")).toBeNull();
  });
});

// ─── listDocuments ───────────────────────────────────────────────────────

describe("listDocuments", () => {
  let index: GnosysWebIndex;

  beforeEach(() => {
    index = makeSampleIndex();
  });

  it("returns all documents with no filter", () => {
    const docs = listDocuments(index);
    expect(docs.length).toBe(5);
  });

  it("filters by category", () => {
    const docs = listDocuments(index, { category: "blog" });
    expect(docs.length).toBe(2);
    for (const d of docs) expect(d.category).toBe("blog");
  });

  it("filters by tags (any match)", () => {
    const docs = listDocuments(index, { tags: ["ai"] });
    expect(docs.length).toBe(2); // blog-001, svc-001
    for (const d of docs) expect(d.tags).toContain("ai");
  });

  it("filters by status", () => {
    const docs = listDocuments(index, { status: "archived" });
    expect(docs.length).toBe(1);
    expect(docs[0].id).toBe("arch-001");
  });

  it("combines multiple filters (AND logic)", () => {
    const docs = listDocuments(index, { category: "blog", status: "active" });
    expect(docs.length).toBe(1);
    expect(docs[0].id).toBe("blog-001");
  });

  it("returns empty array when no documents match filter", () => {
    const docs = listDocuments(index, { category: "nonexistent" });
    expect(docs).toEqual([]);
  });
});
