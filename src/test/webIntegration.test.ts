/**
 * Web Knowledge Base Integration Tests
 *
 * End-to-end tests that exercise the full pipeline:
 * ingest (directory source) → build index → search via staticSearch.
 * Uses fixture files from src/test/fixtures/web/.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import matter from "gray-matter";
import { buildIndexSync, writeIndex } from "../lib/webIndex.js";
import {
  loadIndex,
  clearIndexCache,
  search,
  getDocument,
  listDocuments,
} from "../lib/staticSearch.js";
import { extractStructuredFrontmatter, computeTfIdf } from "../lib/structuredIngest.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

const FIXTURES = path.resolve(__dirname, "fixtures/web");
let tmpDir: string;
let outputDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-web-int-"));
  outputDir = path.join(tmpDir, "knowledge");
  fs.mkdirSync(outputDir, { recursive: true });
  clearIndexCache();
});

afterEach(async () => {
  clearIndexCache();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** Copy fixture knowledge files to output dir and build + write index. */
async function setupPipeline(): Promise<string> {
  const srcDir = path.join(FIXTURES, "sample-knowledge");
  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    fs.copyFileSync(path.join(srcDir, file), path.join(outputDir, file));
  }
  const index = buildIndexSync(outputDir);
  const indexPath = path.join(outputDir, "gnosys-index.json");
  await writeIndex(index, indexPath);
  return indexPath;
}

// ─── Fixture loading ────────────────────────────────────────────────────

describe("Fixture validation", () => {
  it("sample-index.json is valid and loadable", () => {
    const idx = loadIndex(path.join(FIXTURES, "sample-index.json"));
    expect(idx.version).toBe(1);
    expect(idx.documents.length).toBeGreaterThan(0);
    expect(idx.documentCount).toBe(idx.documents.length);
  });

  it("sample knowledge files have valid frontmatter", () => {
    const knowledgeDir = path.join(FIXTURES, "sample-knowledge");
    const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = fs.readFileSync(path.join(knowledgeDir, file), "utf-8");
      const { data } = matter(content);
      expect(data.id).toBeTruthy();
      expect(data.title).toBeTruthy();
      expect(data.category).toBeTruthy();
      expect(data.relevance).toBeTruthy();
    }
  });

  it("sample HTML pages exist and are valid", () => {
    const pagesDir = path.join(FIXTURES, "sample-pages");
    const files = fs.readdirSync(pagesDir).filter(f => f.endsWith(".html"));
    expect(files.length).toBe(5);

    for (const file of files) {
      const content = fs.readFileSync(path.join(pagesDir, file), "utf-8");
      expect(content).toContain("<html");
      expect(content).toContain("<h1>");
    }
  });

  it("sample MDX files exist", () => {
    const mdxDir = path.join(FIXTURES, "sample-mdx");
    const files = fs.readdirSync(mdxDir).filter(f => f.endsWith(".mdx"));
    expect(files.length).toBe(3);
  });
});

// ─── Directory ingest → index → search pipeline ────────────────────────

describe("Full pipeline: directory ingest → build index → search", () => {
  it("ingests markdown files and builds a searchable index", async () => {
    const indexPath = await setupPipeline();
    expect(fs.existsSync(indexPath)).toBe(true);

    const loaded = loadIndex(indexPath);
    expect(loaded.version).toBe(1);
    expect(loaded.documents.length).toBe(5);
    expect(Object.keys(loaded.invertedIndex).length).toBeGreaterThan(0);

    const results = search(loaded, "automation agents workflow");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.title).toContain("Agentic");
  });

  it("search respects category filter", async () => {
    const indexPath = await setupPipeline();
    const loaded = loadIndex(indexPath);

    const allResults = search(loaded, "knowledge team");
    const landscapeOnly = search(loaded, "knowledge team", { category: "landscape" });
    expect(landscapeOnly.length).toBeLessThanOrEqual(allResults.length);
    for (const r of landscapeOnly) {
      expect(r.document.category).toBe("landscape");
    }
  });

  it("search respects tag filter", async () => {
    const indexPath = await setupPipeline();
    const loaded = loadIndex(indexPath);

    const tagResults = search(loaded, "company team mission", { tags: ["domain:company"] });
    for (const r of tagResults) {
      expect(r.document.tags.some((t: string) => t === "domain:company")).toBe(true);
    }
  });

  it("getDocument retrieves specific document from built index", async () => {
    const indexPath = await setupPipeline();
    const loaded = loadIndex(indexPath);

    const doc = loaded.documents.find(d => d.title.includes("About"));
    expect(doc).toBeTruthy();
    const fetched = getDocument(loaded, doc!.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.title).toBe(doc!.title);
  });

  it("listDocuments filters by category on built index", async () => {
    const indexPath = await setupPipeline();
    const loaded = loadIndex(indexPath);

    const all = listDocuments(loaded);
    const concepts = listDocuments(loaded, { category: "concepts" });
    expect(concepts.length).toBeLessThanOrEqual(all.length);
    for (const doc of concepts) {
      expect(doc.category).toBe("concepts");
    }
  });
});

// ─── Structured ingest pipeline ─────────────────────────────────────────

describe("Structured ingest: HTML → frontmatter extraction", () => {
  it("extracts title and category from HTML content", () => {
    const html = fs.readFileSync(
      path.join(FIXTURES, "sample-pages/about-page.html"),
      "utf-8"
    );
    const result = extractStructuredFrontmatter(html, "https://example.com/about", {
      "/about*": "company",
      "/blog/*": "blog",
    });
    expect(result.title).toContain("About");
    expect(result.category).toBe("company");
  });

  it("extracts category from URL patterns for blog posts", () => {
    const html = fs.readFileSync(
      path.join(FIXTURES, "sample-pages/blog-post.html"),
      "utf-8"
    );
    const result = extractStructuredFrontmatter(
      html,
      "https://example.com/blog/building-in-public",
      { "/blog/*": "blog", "/services/*": "services" }
    );
    expect(result.category).toBe("blog");
  });

  it("falls back to general category for unmatched URLs", () => {
    const result = extractStructuredFrontmatter(
      "<html><body><h1>Random</h1></body></html>",
      "https://example.com/random/page",
      { "/blog/*": "blog" }
    );
    expect(result.category).toBe("general");
  });
});

// ─── TF-IDF across fixture corpus ───────────────────────────────────────

describe("TF-IDF on fixture knowledge files", () => {
  it("computes distinctive terms for each document", () => {
    const knowledgeDir = path.join(FIXTURES, "sample-knowledge");
    const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith(".md"));
    const docs = files.map(f => ({
      id: f.replace(".md", ""),
      content: fs.readFileSync(path.join(knowledgeDir, f), "utf-8"),
    }));

    const tfidf = computeTfIdf(docs, 10);
    expect(tfidf.size).toBe(docs.length);

    for (const [_id, terms] of tfidf) {
      expect(terms.length).toBeGreaterThan(0);
      expect(terms.length).toBeLessThanOrEqual(10);
    }
  });

  it("automation doc gets automation-related terms", () => {
    const knowledgeDir = path.join(FIXTURES, "sample-knowledge");
    const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith(".md"));
    const docs = files.map(f => ({
      id: f.replace(".md", ""),
      content: fs.readFileSync(path.join(knowledgeDir, f), "utf-8"),
    }));

    const tfidf = computeTfIdf(docs, 15);
    const automationTerms = tfidf.get("web-agentic-automation") || [];
    const allTerms = automationTerms.map(t => t.term).join(" ").toLowerCase();
    expect(
      allTerms.includes("automation") ||
      allTerms.includes("agentic") ||
      allTerms.includes("workflow")
    ).toBe(true);
  });
});

// ─── MDX handling ───────────────────────────────────────────────────────

describe("MDX content handling", () => {
  it("MDX fixtures contain content that should be processable", () => {
    const mdxDir = path.join(FIXTURES, "sample-mdx");
    const content = fs.readFileSync(path.join(mdxDir, "features.mdx"), "utf-8");
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(0);
  });
});

// ─── Index determinism ──────────────────────────────────────────────────

describe("Index build determinism", () => {
  it("building index twice produces identical output", () => {
    const srcDir = path.join(FIXTURES, "sample-knowledge");
    for (const file of fs.readdirSync(srcDir)) {
      fs.copyFileSync(path.join(srcDir, file), path.join(outputDir, file));
    }

    const index1 = buildIndexSync(outputDir);
    const index2 = buildIndexSync(outputDir);

    expect(index1.documents.map(d => d.id)).toEqual(index2.documents.map(d => d.id));
    expect(Object.keys(index1.invertedIndex).sort()).toEqual(
      Object.keys(index2.invertedIndex).sort()
    );
  });
});

// ─── Bundle isolation ───────────────────────────────────────────────────

describe("Bundle isolation: gnosys/web has no native deps", () => {
  it("staticSearch.ts only imports from Node.js fs", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../lib/staticSearch.ts"),
      "utf-8"
    );
    // Extract all import lines
    const imports = source.match(/^import\s+.+from\s+["'].+["']/gm) || [];
    for (const imp of imports) {
      const from = imp.match(/from\s+["'](.+)["']/)?.[1];
      if (!from) continue;
      // Only allow Node.js built-ins
      expect(
        from === "fs" || from === "path" || from.startsWith("node:"),
        `staticSearch.ts imports "${from}" which is not a Node.js built-in`
      ).toBe(true);
    }
  });

  it("staticSearch.ts has no import type that would pull runtime deps", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../lib/staticSearch.ts"),
      "utf-8"
    );
    // No non-type imports from project files
    const runtimeImports = source.match(/^import\s+(?!type\s).*from\s+["']\.\/.+["']/gm) || [];
    expect(runtimeImports.length).toBe(0);
  });
});
