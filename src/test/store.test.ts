/**
 * Tests for GnosysStore — core read/write operations on atomic memory files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { GnosysStore, MemoryFrontmatter } from "../lib/store.js";

let tmpDir: string;
let store: GnosysStore;

function makeFrontmatter(overrides: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter {
  return {
    id: "test-001",
    title: "Test Memory",
    category: "decisions",
    tags: { domain: ["testing"], type: ["decision"] },
    relevance: "test unit testing vitest store",
    author: "human",
    authority: "declared",
    confidence: 0.9,
    created: "2026-03-06",
    modified: "2026-03-06",
    last_reviewed: "2026-03-06",
    status: "active",
    supersedes: null,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-test-"));
  store = new GnosysStore(tmpDir);
  await store.init();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GnosysStore", () => {
  describe("init", () => {
    it("creates .config internal directory", async () => {
      const stat = await fs.stat(path.join(tmpDir, ".config"));
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("writeMemory + readMemory", () => {
    it("writes and reads a memory with correct frontmatter", async () => {
      const fm = makeFrontmatter();
      const content = "# Test Memory\n\nThis is test content.";
      const relPath = await store.writeMemory("decisions", "test.md", fm, content);

      expect(relPath).toBe("decisions/test.md");

      const memory = await store.readMemory(relPath);
      expect(memory).not.toBeNull();
      expect(memory!.frontmatter.id).toBe("test-001");
      expect(memory!.frontmatter.title).toBe("Test Memory");
      expect(memory!.frontmatter.relevance).toBe("test unit testing vitest store");
      expect(memory!.frontmatter.status).toBe("active");
      expect(memory!.content).toContain("This is test content.");
    });

    it("returns null for non-existent memory", async () => {
      const memory = await store.readMemory("nope/doesnt-exist.md");
      expect(memory).toBeNull();
    });

    it("returns null for files without id frontmatter", async () => {
      const filePath = path.join(tmpDir, "no-id.md");
      await fs.writeFile(filePath, "---\ntitle: No ID\n---\nContent", "utf-8");
      const memory = await store.readMemory("no-id.md");
      expect(memory).toBeNull();
    });
  });

  describe("getAllMemories", () => {
    it("returns all valid memories, ignores non-memory files", async () => {
      // Write two valid memories
      await store.writeMemory(
        "decisions",
        "a.md",
        makeFrontmatter({ id: "deci-001", title: "Decision A" }),
        "# Decision A\n\nContent A"
      );
      await store.writeMemory(
        "concepts",
        "b.md",
        makeFrontmatter({ id: "conc-001", title: "Concept B", category: "concepts" }),
        "# Concept B\n\nContent B"
      );

      // Write a non-memory file (no id)
      await fs.mkdir(path.join(tmpDir, "misc"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, "misc", "random.md"),
        "---\ntitle: Random\n---\nNot a memory",
        "utf-8"
      );

      const memories = await store.getAllMemories();
      expect(memories.length).toBe(2);
      const titles = memories.map((m) => m.frontmatter.title).sort();
      expect(titles).toEqual(["Concept B", "Decision A"]);
    });

    it("ignores CHANGELOG.md and MANIFEST.md", async () => {
      await fs.writeFile(
        path.join(tmpDir, "CHANGELOG.md"),
        "---\nid: skip\n---\nShould be ignored",
        "utf-8"
      );
      await store.writeMemory(
        "decisions",
        "real.md",
        makeFrontmatter(),
        "# Real\n\nContent"
      );

      const memories = await store.getAllMemories();
      expect(memories.length).toBe(1);
      expect(memories[0].frontmatter.title).toBe("Test Memory");
    });
  });

  describe("updateMemory", () => {
    it("updates frontmatter fields and preserves content", async () => {
      await store.writeMemory(
        "decisions",
        "update-test.md",
        makeFrontmatter(),
        "# Test\n\nOriginal content"
      );

      const updated = await store.updateMemory("decisions/update-test.md", {
        title: "Updated Title",
        confidence: 0.5,
        status: "archived",
      });

      expect(updated).not.toBeNull();
      expect(updated!.frontmatter.title).toBe("Updated Title");
      expect(updated!.frontmatter.confidence).toBe(0.5);
      expect(updated!.frontmatter.status).toBe("archived");
      expect(updated!.content).toContain("Original content");
      // modified should be updated to today
      expect(updated!.frontmatter.modified).toBe(
        new Date().toISOString().split("T")[0]
      );
    });

    it("can replace content", async () => {
      await store.writeMemory(
        "decisions",
        "content-test.md",
        makeFrontmatter(),
        "# Old\n\nOld content"
      );

      const updated = await store.updateMemory(
        "decisions/content-test.md",
        {},
        "# New\n\nNew content"
      );

      expect(updated).not.toBeNull();
      expect(updated!.content).toContain("New content");
      expect(updated!.content).not.toContain("Old content");
    });

    it("returns null for non-existent memory", async () => {
      const result = await store.updateMemory("nope.md", { title: "X" });
      expect(result).toBeNull();
    });
  });

  describe("getCategories", () => {
    it("returns only directories, excludes hidden and node_modules", async () => {
      await fs.mkdir(path.join(tmpDir, "decisions"), { recursive: true });
      await fs.mkdir(path.join(tmpDir, "concepts"), { recursive: true });
      // .config already exists from init

      const cats = await store.getCategories();
      expect(cats).toContain("decisions");
      expect(cats).toContain("concepts");
      expect(cats).not.toContain(".config");
    });
  });

  describe("generateId", () => {
    it("generates sequential IDs with category prefix", async () => {
      const id1 = await store.generateId("decisions");
      expect(id1).toBe("deci-001");

      await store.writeMemory(
        "decisions",
        "first.md",
        makeFrontmatter({ id: id1 }),
        "# First\n\nContent"
      );

      const id2 = await store.generateId("decisions");
      expect(id2).toBe("deci-002");
    });
  });

  describe("supersession fields", () => {
    it("writes and reads supersedes/superseded_by fields", async () => {
      const fm = makeFrontmatter({
        id: "deci-002",
        supersedes: "deci-001",
        superseded_by: null,
      });
      await store.writeMemory("decisions", "v2.md", fm, "# V2\n\nNew version");

      const memory = await store.readMemory("decisions/v2.md");
      expect(memory!.frontmatter.supersedes).toBe("deci-001");
      expect(memory!.frontmatter.superseded_by).toBeNull();
    });
  });
});
