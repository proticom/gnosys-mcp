/**
 * Tests for webIngest.ts — Site crawling and content extraction.
 *
 * Uses mock filesystem and avoids real network calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import matter from "gray-matter";
import {
  ingestSite,
  ingestUrl,
  ingestDirectory,
  removeKnowledge,
} from "../lib/webIngest.js";
import type { WebIngestConfig } from "../lib/webIngest.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let outputDir: string;
let contentDir: string;

function defaultConfig(overrides: Partial<WebIngestConfig> = {}): WebIngestConfig {
  return {
    source: "directory",
    contentDir,
    outputDir,
    categories: {
      "/blog/*": "blog",
      "/services/*": "services",
      "/products/*": "products",
      "/about*": "company",
    },
    llmEnrich: false,
    prune: false,
    concurrency: 1,
    crawlDelayMs: 0,
    ...overrides,
  };
}

function writeContentFile(name: string, content: string, subdir?: string): void {
  const dir = subdir ? path.join(contentDir, subdir) : contentDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, "utf-8");
}

function writeMdContent(name: string, frontmatter: Record<string, unknown>, body: string, subdir?: string): void {
  const fmLines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    fmLines.push(`${key}: ${JSON.stringify(value)}`);
  }
  fmLines.push("---", "", body);
  writeContentFile(name, fmLines.join("\n"), subdir);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-webingest-"));
  outputDir = path.join(tmpDir, "knowledge");
  contentDir = path.join(tmpDir, "content");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(contentDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── Directory source tests ─────────────────────────────────────────────

describe("ingestSite with directory source", () => {
  it("reads local markdown files and creates knowledge files", async () => {
    writeContentFile("post.md", "# My Blog Post\n\nThis is blog content about AI and automation.");

    const result = await ingestSite(defaultConfig());
    expect(result.added.length).toBe(1);
    expect(result.errors).toEqual([]);

    // Verify knowledge file was created
    const files = fs.readdirSync(outputDir, { recursive: true }) as string[];
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    expect(mdFiles.length).toBe(1);
  });

  it("handles .md source files with existing frontmatter", async () => {
    writeMdContent("existing.md", { title: "Existing Post", author: "human" }, "Content with existing frontmatter.");

    const result = await ingestSite(defaultConfig());
    expect(result.added.length).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("handles .html source files by converting to markdown", async () => {
    writeContentFile(
      "page.html",
      "<html><body><article><h1>HTML Page</h1><p>This is <strong>bold</strong> content.</p></article></body></html>"
    );

    const result = await ingestSite(defaultConfig());
    expect(result.added.length).toBe(1);

    // Verify the output has markdown content
    const files = fs.readdirSync(outputDir, { recursive: true }) as string[];
    const mdFile = files.find((f) => f.endsWith(".md"));
    expect(mdFile).toBeDefined();
    const content = fs.readFileSync(path.join(outputDir, mdFile!), "utf-8");
    expect(content).toContain("HTML Page");
  });

  it("strips MDX components from .mdx files", async () => {
    writeContentFile(
      "component.mdx",
      "---\ntitle: MDX Page\n---\n\nimport MyComp from './MyComp'\n\n# MDX Content\n\n<MyComp />\n\nRegular markdown here."
    );

    const result = await ingestSite(defaultConfig());
    expect(result.added.length).toBe(1);

    const files = fs.readdirSync(outputDir, { recursive: true }) as string[];
    const mdFile = files.find((f) => f.endsWith(".md"));
    const content = fs.readFileSync(path.join(outputDir, mdFile!), "utf-8");
    expect(content).not.toContain("<MyComp");
    expect(content).not.toContain("import MyComp");
    expect(content).toContain("Regular markdown here");
  });

  it("skips unchanged pages on re-ingest (content hash match)", async () => {
    writeContentFile("stable.md", "# Stable Content\n\nThis won't change.");

    const result1 = await ingestSite(defaultConfig());
    expect(result1.added.length).toBe(1);

    const result2 = await ingestSite(defaultConfig());
    expect(result2.unchanged.length).toBe(1);
    expect(result2.added.length).toBe(0);
    expect(result2.updated.length).toBe(0);
  });

  it("updates changed pages on re-ingest", async () => {
    writeContentFile("changing.md", "# Version 1\n\nOriginal content.");

    const result1 = await ingestSite(defaultConfig());
    expect(result1.added.length).toBe(1);

    // Modify the source file
    writeContentFile("changing.md", "# Version 2\n\nUpdated content with new information.");

    const result2 = await ingestSite(defaultConfig());
    expect(result2.updated.length).toBe(1);
    expect(result2.added.length).toBe(0);
  });

  it("creates category subdirectories in output", async () => {
    // The directory source creates files with category paths
    writeContentFile("post.md", "# Post\n\nContent.");

    await ingestSite(defaultConfig());

    // Output should have subdirectories
    const entries = fs.readdirSync(outputDir, { recursive: true });
    expect(entries.length).toBeGreaterThan(0);
  });

  it("handles empty content directory", async () => {
    const result = await ingestSite(defaultConfig());
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("returns correct IngestResult counts", async () => {
    writeContentFile("a.md", "# File A\n\nContent A.");
    writeContentFile("b.md", "# File B\n\nContent B.");
    writeContentFile("c.html", "<html><body><h1>File C</h1><p>Content C.</p></body></html>");

    const result = await ingestSite(defaultConfig());
    expect(result.added.length).toBe(3);
    expect(result.updated.length).toBe(0);
    expect(result.unchanged.length).toBe(0);
    expect(result.errors.length).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

// ─── Dry run ─────────────────────────────────────────────────────────────

describe("dry run mode", () => {
  it("does not write files in dry-run mode", async () => {
    writeContentFile("post.md", "# Dry Run Test\n\nContent.");

    const result = await ingestSite(defaultConfig({ dryRun: true }));
    expect(result.added.length).toBe(1);

    // Output dir should be empty (except the dir itself)
    const files = fs.readdirSync(outputDir, { recursive: true }) as string[];
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    expect(mdFiles.length).toBe(0);
  });
});

// ─── Pruning ─────────────────────────────────────────────────────────────

describe("pruning", () => {
  it("removes orphaned knowledge files when prune is enabled", async () => {
    writeContentFile("keep.md", "# Keep\n\nKeep this.");
    await ingestSite(defaultConfig());

    // Add an orphan file directly to output
    fs.writeFileSync(
      path.join(outputDir, "general", "orphan.md"),
      "---\nid: orphan\n---\nOrphan content",
      "utf-8"
    );

    const result = await ingestSite(defaultConfig({ prune: true }));
    expect(result.removed.length).toBe(1);
    expect(result.removed[0]).toContain("orphan.md");
  });

  it("preserves orphaned files when prune is disabled", async () => {
    writeContentFile("keep.md", "# Keep\n\nKeep this.");
    await ingestSite(defaultConfig());

    // Add an orphan
    const orphanDir = path.join(outputDir, "general");
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "orphan.md"), "orphan", "utf-8");

    const result = await ingestSite(defaultConfig({ prune: false }));
    expect(result.removed.length).toBe(0);
    expect(fs.existsSync(path.join(orphanDir, "orphan.md"))).toBe(true);
  });
});

// ─── URL source tests ───────────────────────────────────────────────────

describe("ingestUrl", () => {
  it("processes a single URL (mocked)", async () => {
    // Mock fetch for URL-based ingestion
    const mockHtml = "<html><body><article><h1>Test Page</h1><p>Page content here.</p></article></body></html>";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(mockHtml, { status: 200, headers: { "content-type": "text/html" } })
    );

    const result = await ingestUrl(
      "https://example.com/blog/test-page",
      defaultConfig({ source: "urls" })
    );

    expect(result.added.length).toBe(1);
    expect(result.errors).toEqual([]);
  });
});

// ─── Sitemap tests ───────────────────────────────────────────────────────

describe("ingestSite with sitemap", () => {
  it("fetches and parses sitemap XML", async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/blog/post-1</loc></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>`;

    const pageHtml = "<html><body><article><h1>Page</h1><p>Content.</p></article></body></html>";

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(sitemapXml, { status: 200 }))
      .mockResolvedValueOnce(new Response(pageHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(pageHtml, { status: 200 }));

    const result = await ingestSite(
      defaultConfig({
        source: "sitemap",
        sitemapUrl: "https://example.com/sitemap.xml",
      })
    );

    expect(result.added.length).toBe(2);
  });

  it("respects exclude patterns", async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://example.com/blog/post-1</loc></url>
  <url><loc>https://example.com/api/v1/data</loc></url>
  <url><loc>https://example.com/admin/dashboard</loc></url>
</urlset>`;

    const pageHtml = "<html><body><article><h1>Page</h1><p>Content.</p></article></body></html>";

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(sitemapXml, { status: 200 }))
      .mockResolvedValueOnce(new Response(pageHtml, { status: 200 }));

    const result = await ingestSite(
      defaultConfig({
        source: "sitemap",
        sitemapUrl: "https://example.com/sitemap.xml",
        exclude: ["/api", "/admin"],
      })
    );

    expect(result.added.length).toBe(1); // Only blog post
  });

  it("handles fetch errors gracefully", async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://example.com/good</loc></url>
  <url><loc>https://example.com/bad</loc></url>
</urlset>`;

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(sitemapXml, { status: 200 }))
      .mockResolvedValueOnce(new Response("<html><body><h1>Good</h1></body></html>", { status: 200 }))
      .mockResolvedValueOnce(new Response("Not Found", { status: 404, statusText: "Not Found" }));

    const result = await ingestSite(
      defaultConfig({
        source: "sitemap",
        sitemapUrl: "https://example.com/sitemap.xml",
      })
    );

    expect(result.added.length).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].url).toContain("/bad");
  });

  it("handles sitemap index files", async () => {
    const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex>
  <sitemap><loc>https://example.com/sitemap-blog.xml</loc></sitemap>
</sitemapindex>`;

    const childSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://example.com/blog/post-1</loc></url>
</urlset>`;

    const pageHtml = "<html><body><article><h1>Post</h1><p>Content.</p></article></body></html>";

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(sitemapIndex, { status: 200 }))
      .mockResolvedValueOnce(new Response(childSitemap, { status: 200 }))
      .mockResolvedValueOnce(new Response(pageHtml, { status: 200 }));

    const result = await ingestSite(
      defaultConfig({
        source: "sitemap",
        sitemapUrl: "https://example.com/sitemap.xml",
      })
    );

    expect(result.added.length).toBe(1);
  });
});

// ─── removeKnowledge ─────────────────────────────────────────────────────

describe("removeKnowledge", () => {
  it("removes the knowledge directory", async () => {
    const knowledgePath = path.join(tmpDir, "to-remove");
    fs.mkdirSync(knowledgePath);
    fs.writeFileSync(path.join(knowledgePath, "test.md"), "test");

    await removeKnowledge(knowledgePath);
    expect(fs.existsSync(knowledgePath)).toBe(false);
  });

  it("handles non-existent directory gracefully", async () => {
    await expect(removeKnowledge("/nonexistent/path")).resolves.not.toThrow();
  });
});

// ─── ingestDirectory convenience ─────────────────────────────────────────

describe("ingestDirectory", () => {
  it("wraps ingestSite with directory source", async () => {
    writeContentFile("test.md", "# Test\n\nContent.");

    const result = await ingestDirectory(contentDir, defaultConfig());
    expect(result.added.length).toBe(1);
  });
});
