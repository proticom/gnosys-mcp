import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { discoverFiles, parseFileForImport, bootstrap, BootstrapOptions } from "../lib/bootstrap.js";
import { GnosysStore } from "../lib/store.js";

let tempDir: string;
let sourceDir: string;
let storeDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-bootstrap-test-"));
  sourceDir = path.join(tempDir, "source");
  storeDir = path.join(tempDir, "store");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(storeDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("discoverFiles", () => {
  it("finds markdown files", async () => {
    await fs.writeFile(path.join(sourceDir, "doc1.md"), "# Doc 1");
    await fs.writeFile(path.join(sourceDir, "doc2.md"), "# Doc 2");
    await fs.writeFile(path.join(sourceDir, "readme.txt"), "Not markdown");

    const files = await discoverFiles(sourceDir);
    expect(files).toHaveLength(2);
    expect(files).toContain("doc1.md");
    expect(files).toContain("doc2.md");
  });

  it("finds files in subdirectories", async () => {
    await fs.mkdir(path.join(sourceDir, "decisions"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "decisions", "auth.md"), "# Auth");

    const files = await discoverFiles(sourceDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("decisions/auth.md");
  });

  it("supports custom patterns", async () => {
    await fs.writeFile(path.join(sourceDir, "doc.md"), "# Doc");
    await fs.writeFile(path.join(sourceDir, "notes.txt"), "Notes");

    const files = await discoverFiles(sourceDir, ["**/*.md", "**/*.txt"]);
    expect(files).toHaveLength(2);
  });

  it("returns empty for empty directory", async () => {
    const files = await discoverFiles(sourceDir);
    expect(files).toHaveLength(0);
  });

  it("deduplicates files across patterns", async () => {
    await fs.writeFile(path.join(sourceDir, "doc.md"), "# Doc");

    const files = await discoverFiles(sourceDir, ["**/*.md", "*.md"]);
    expect(files).toHaveLength(1);
  });
});

describe("parseFileForImport", () => {
  const defaultOpts: BootstrapOptions = {
    sourceDir: "/tmp",
    defaultCategory: "imported",
    preserveFrontmatter: false,
  };

  it("extracts title from H1 heading", () => {
    const { frontmatter } = parseFileForImport("# My Decision\n\nContent here.", "doc.md", defaultOpts);
    expect(frontmatter.title).toBe("My Decision");
  });

  it("falls back to filename for title", () => {
    const { frontmatter } = parseFileForImport("No heading here.", "my-cool-doc.md", defaultOpts);
    expect(frontmatter.title).toBe("My Cool Doc");
  });

  it("infers category from directory structure", () => {
    const { frontmatter } = parseFileForImport("# Test", "decisions/auth.md", defaultOpts);
    expect(frontmatter.category).toBe("decisions");
  });

  it("uses default category for root files", () => {
    const { frontmatter } = parseFileForImport("# Test", "doc.md", defaultOpts);
    expect(frontmatter.category).toBe("imported");
  });

  it("preserves existing frontmatter when option is set", () => {
    const content = `---
title: Custom Title
category: architecture
confidence: 0.95
author: human
---
# Custom Title

Content here.`;

    const { frontmatter } = parseFileForImport(content, "doc.md", {
      ...defaultOpts,
      preserveFrontmatter: true,
    });
    expect(frontmatter.title).toBe("Custom Title");
    expect(frontmatter.category).toBe("architecture");
    expect(frontmatter.confidence).toBe(0.95);
    expect(frontmatter.author).toBe("human");
  });

  it("uses defaults when not preserving frontmatter", () => {
    const content = `---
title: Custom Title
category: architecture
---
# Custom Title`;

    const { frontmatter } = parseFileForImport(content, "doc.md", defaultOpts);
    // Should NOT preserve even though frontmatter exists
    expect(frontmatter.category).toBe("imported");
    expect(frontmatter.authority).toBe("imported");
  });

  it("strips frontmatter from body", () => {
    const content = `---
title: Test
---
# Test

Body content.`;

    const { body } = parseFileForImport(content, "doc.md", defaultOpts);
    expect(body).toBe("# Test\n\nBody content.");
    expect(body).not.toContain("---");
  });
});

describe("bootstrap", () => {
  it("imports files into the store", async () => {
    await fs.writeFile(path.join(sourceDir, "doc1.md"), "# First Doc\n\nContent one.");
    await fs.writeFile(path.join(sourceDir, "doc2.md"), "# Second Doc\n\nContent two.");

    const store = new GnosysStore(storeDir);
    await store.init();

    const result = await bootstrap(store, {
      sourceDir,
      defaultCategory: "imported",
    });

    expect(result.totalScanned).toBe(2);
    expect(result.imported).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    // Verify files were written
    const memories = await store.getAllMemories();
    expect(memories).toHaveLength(2);
  });

  it("skips existing memories when skipExisting is true", async () => {
    const store = new GnosysStore(storeDir);
    await store.init();

    // Write a memory first
    await store.writeMemory("imported", "first-doc.md", {
      id: "existing-1",
      title: "First Doc",
      category: "imported",
      tags: { domain: [] },
      relevance: "",
      author: "human",
      authority: "imported",
      confidence: 0.7,
      created: "2026-03-01",
      modified: "2026-03-01",
      status: "active",
      supersedes: null,
    }, "# First Doc\n\nExisting content.");

    // Now try to bootstrap with the same title
    await fs.writeFile(path.join(sourceDir, "doc1.md"), "# First Doc\n\nNew content.");
    await fs.writeFile(path.join(sourceDir, "doc2.md"), "# Second Doc\n\nContent two.");

    const result = await bootstrap(store, {
      sourceDir,
      skipExisting: true,
      defaultCategory: "imported",
    });

    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toBe("doc1.md");
  });

  it("supports dry run mode", async () => {
    await fs.writeFile(path.join(sourceDir, "doc1.md"), "# Test\n\nContent.");

    const store = new GnosysStore(storeDir);
    await store.init();

    const result = await bootstrap(store, {
      sourceDir,
      dryRun: true,
    });

    expect(result.imported).toHaveLength(1);

    // Verify nothing was actually written
    const memories = await store.getAllMemories();
    expect(memories).toHaveLength(0);
  });

  it("handles empty source directory", async () => {
    const store = new GnosysStore(storeDir);
    await store.init();

    const result = await bootstrap(store, { sourceDir });
    expect(result.totalScanned).toBe(0);
    expect(result.imported).toHaveLength(0);
  });

  it("respects custom patterns", async () => {
    await fs.writeFile(path.join(sourceDir, "doc.md"), "# MD");
    await fs.writeFile(path.join(sourceDir, "notes.txt"), "TXT content");

    const store = new GnosysStore(storeDir);
    await store.init();

    const result = await bootstrap(store, {
      sourceDir,
      patterns: ["**/*.txt"],
    });

    expect(result.totalScanned).toBe(1);
    expect(result.imported).toHaveLength(1);
  });

  it("preserves category from subdirectory structure", async () => {
    await fs.mkdir(path.join(sourceDir, "architecture"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "architecture", "layers.md"), "# Three Layers\n\nContent.");

    const store = new GnosysStore(storeDir);
    await store.init();

    await bootstrap(store, { sourceDir });

    const memories = await store.getAllMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0].frontmatter.category).toBe("architecture");
  });
});
