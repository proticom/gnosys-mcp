/**
 * Tests for structuredIngest.ts — No-LLM fallback for web knowledge base.
 */

import { describe, it, expect } from "vitest";
import {
  extractStructuredFrontmatter,
  computeTfIdf,
} from "../lib/structuredIngest.js";

// ─── extractStructuredFrontmatter ────────────────────────────────────────

describe("extractStructuredFrontmatter", () => {
  const defaultCategories: Record<string, string> = {
    "/blog/*": "blog",
    "/services/*": "services",
    "/products/*": "products",
    "/about*": "company",
  };

  it("extracts title from <h1>", () => {
    const fm = extractStructuredFrontmatter(
      "<html><body><h1>My Great Post</h1><p>content</p></body></html>",
      "https://example.com/blog/my-post",
      defaultCategories
    );
    expect(fm.title).toBe("My Great Post");
  });

  it("extracts title from <title> when no <h1>", () => {
    const fm = extractStructuredFrontmatter(
      "<html><head><title>Page Title</title></head><body><p>content</p></body></html>",
      "https://example.com/page",
      defaultCategories
    );
    expect(fm.title).toBe("Page Title");
  });

  it("extracts title from markdown heading", () => {
    const fm = extractStructuredFrontmatter(
      "# Markdown Title\n\nSome content here.",
      "https://example.com/docs/intro",
      defaultCategories
    );
    expect(fm.title).toBe("Markdown Title");
  });

  it("falls back to filename-derived title", () => {
    const fm = extractStructuredFrontmatter(
      "<p>No headings here</p>",
      "https://example.com/my-awesome-page",
      defaultCategories
    );
    expect(fm.title).toBe("My Awesome Page");
  });

  it("maps URL to category using config patterns", () => {
    const fm = extractStructuredFrontmatter(
      "<h1>Blog Post</h1>",
      "https://example.com/blog/my-post",
      defaultCategories
    );
    expect(fm.category).toBe("blog");
  });

  it("maps /services/* to services category", () => {
    const fm = extractStructuredFrontmatter(
      "<h1>Our Service</h1>",
      "https://example.com/services/consulting",
      defaultCategories
    );
    expect(fm.category).toBe("services");
  });

  it("maps /about* to company category", () => {
    const fm = extractStructuredFrontmatter(
      "<h1>About Us</h1>",
      "https://example.com/about-us",
      defaultCategories
    );
    expect(fm.category).toBe("company");
  });

  it('uses "general" category for unmatched URLs', () => {
    const fm = extractStructuredFrontmatter(
      "<h1>Random Page</h1>",
      "https://example.com/random/page",
      defaultCategories
    );
    expect(fm.category).toBe("general");
  });

  it("extracts keywords from <meta> tags", () => {
    const fm = extractStructuredFrontmatter(
      '<html><head><meta name="keywords" content="AI, chatbot, automation"></head><body><h1>AI</h1></body></html>',
      "https://example.com/blog/ai",
      defaultCategories
    );
    expect(fm.tags.domain).toContain("ai");
    expect(fm.tags.domain).toContain("chatbot");
    expect(fm.tags.domain).toContain("automation");
  });

  it("infers type tag from URL path", () => {
    const blogFm = extractStructuredFrontmatter(
      "<h1>Post</h1>",
      "https://example.com/blog/post",
      defaultCategories
    );
    expect(blogFm.tags.type).toContain("article");

    const productFm = extractStructuredFrontmatter(
      "<h1>Product</h1>",
      "https://example.com/products/widget",
      defaultCategories
    );
    expect(productFm.tags.type).toContain("product");
  });

  it("sets correct default field values", () => {
    const fm = extractStructuredFrontmatter(
      "<h1>Test</h1>",
      "https://example.com/test",
      defaultCategories
    );
    expect(fm.author).toBe("auto-structured");
    expect(fm.authority).toBe("imported");
    expect(fm.confidence).toBe(0.7);
    expect(fm.status).toBe("active");
    expect(fm.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("generates a valid id from URL and category", () => {
    const fm = extractStructuredFrontmatter(
      "<h1>My Post</h1>",
      "https://example.com/blog/my-post",
      defaultCategories
    );
    expect(fm.id).toBe("blog-my-post");
  });

  it("validates against expected structure", () => {
    const fm = extractStructuredFrontmatter(
      "<h1>Test</h1><p>Content</p>",
      "https://example.com/blog/test",
      defaultCategories
    );
    expect(fm).toHaveProperty("id");
    expect(fm).toHaveProperty("title");
    expect(fm).toHaveProperty("category");
    expect(fm).toHaveProperty("tags");
    expect(fm).toHaveProperty("tags.domain");
    expect(fm).toHaveProperty("tags.type");
    expect(fm).toHaveProperty("relevance");
    expect(fm).toHaveProperty("author");
    expect(fm).toHaveProperty("authority");
    expect(fm).toHaveProperty("confidence");
    expect(fm).toHaveProperty("created");
    expect(fm).toHaveProperty("status");
  });
});

// ─── computeTfIdf ────────────────────────────────────────────────────────

describe("computeTfIdf", () => {
  it("returns correct term scores across corpus", () => {
    const docs = [
      { id: "d1", content: "PostgreSQL database backend storage persistence" },
      { id: "d2", content: "React frontend components UI rendering" },
      { id: "d3", content: "PostgreSQL database queries optimization indexing" },
    ];

    const results = computeTfIdf(docs);
    expect(results.size).toBe(3);

    // "postgresql" appears in d1 and d3, so it has lower IDF than "frontend" (only d2)
    const d2Terms = results.get("d2")!;
    const frontendScore = d2Terms.find((t) => t.term === "frontend")?.score;
    expect(frontendScore).toBeDefined();
    expect(frontendScore!).toBeGreaterThan(0);
  });

  it("handles single-document corpus", () => {
    const docs = [
      { id: "d1", content: "machine learning artificial intelligence deep learning" },
    ];

    const results = computeTfIdf(docs);
    expect(results.size).toBe(1);
    const terms = results.get("d1")!;
    expect(terms.length).toBeGreaterThan(0);

    // "learning" appears twice, should have higher TF
    const learningTerm = terms.find((t) => t.term === "learning");
    expect(learningTerm).toBeDefined();
  });

  it("filters stop words", () => {
    const docs = [
      { id: "d1", content: "the quick brown fox jumps over the lazy dog" },
    ];

    const results = computeTfIdf(docs);
    const terms = results.get("d1")!;
    const termNames = terms.map((t) => t.term);
    expect(termNames).not.toContain("the");
    expect(termNames).not.toContain("was");
    expect(termNames).toContain("quick");
    expect(termNames).toContain("brown");
  });

  it("selects top N terms per document", () => {
    const longContent = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const docs = [{ id: "d1", content: longContent }];

    const results = computeTfIdf(docs, 10);
    const terms = results.get("d1")!;
    expect(terms.length).toBeLessThanOrEqual(10);
  });

  it("returns empty map for empty input", () => {
    const results = computeTfIdf([]);
    expect(results.size).toBe(0);
  });

  it("assigns higher scores to distinctive terms", () => {
    const docs = [
      { id: "d1", content: "kubernetes container orchestration deployment scaling" },
      { id: "d2", content: "kubernetes deployment yaml configuration management" },
      { id: "d3", content: "react component rendering virtual DOM optimization" },
    ];

    const results = computeTfIdf(docs);

    // "react" only appears in d3, should have higher IDF than "kubernetes" which appears in d1 and d2
    const d3Terms = results.get("d3")!;
    const d1Terms = results.get("d1")!;

    const reactScore = d3Terms.find((t) => t.term === "react")?.score || 0;
    const k8sScoreInD1 = d1Terms.find((t) => t.term === "kubernetes")?.score || 0;

    // React (appears in 1/3 docs) should have higher IDF than kubernetes (appears in 2/3 docs)
    expect(reactScore).toBeGreaterThan(k8sScoreInD1);
  });
});
