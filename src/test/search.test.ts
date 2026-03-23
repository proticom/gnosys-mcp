/**
 * Tests for GnosysSearch — FTS5 index, search, and discover operations.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { GnosysStore, MemoryFrontmatter } from "../lib/store.js";
import { GnosysSearch } from "../lib/search.js";

let tmpDir: string;
let store: GnosysStore;
let search: GnosysSearch;

function makeFrontmatter(overrides: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter {
  return {
    id: "test-001",
    title: "Test Memory",
    category: "decisions",
    tags: { domain: ["testing"], type: ["decision"] },
    relevance: "test unit testing vitest search",
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-search-test-"));
  store = new GnosysStore(tmpDir);
  await store.init();
  search = new GnosysSearch(tmpDir);
});

afterEach(async () => {
  search.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GnosysSearch", () => {
  describe("reindex + search", () => {
    it("indexes memories and finds them by keyword", async () => {
      await store.writeMemory(
        "decisions",
        "auth.md",
        makeFrontmatter({
          id: "deci-001",
          title: "Authentication Decision",
          relevance: "auth JWT tokens login session OAuth",
        }),
        "# Authentication Decision\n\nWe use JWT tokens for auth."
      );
      await store.writeMemory(
        "concepts",
        "caching.md",
        makeFrontmatter({
          id: "conc-001",
          title: "Caching Strategy",
          category: "concepts",
          relevance: "cache Redis in-memory TTL invalidation",
        }),
        "# Caching Strategy\n\nRedis is used for caching."
      );

      await search.reindex(store);

      const results = search.search("JWT tokens", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe("Authentication Decision");
    });

    it("returns empty array for no matches", async () => {
      await search.reindex(store);
      const results = search.search("nonexistent-query-xyz", 10);
      expect(results).toEqual([]);
    });

    it("handles empty query", async () => {
      const results = search.search("", 10);
      expect(results).toEqual([]);
    });
  });

  describe("discover", () => {
    it("discovers memories via relevance keyword cloud", async () => {
      await store.writeMemory(
        "decisions",
        "auth.md",
        makeFrontmatter({
          id: "deci-001",
          title: "Authentication Decision",
          relevance: "auth JWT tokens login session OAuth SSO identity credentials",
        }),
        "# Auth\n\nBasic content."
      );
      await store.writeMemory(
        "decisions",
        "db.md",
        makeFrontmatter({
          id: "deci-002",
          title: "Database Choice",
          relevance: "database PostgreSQL SQL schema migration ORM",
        }),
        "# DB\n\nBasic content."
      );

      await search.reindex(store);

      const results = search.discover("OAuth login", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe("Authentication Decision");
      expect(results[0].relevance).toContain("OAuth");
    });

    it("falls back to full-text when column filter finds nothing", async () => {
      await store.writeMemory(
        "decisions",
        "hidden.md",
        makeFrontmatter({
          id: "deci-001",
          title: "Unrelated Title",
          relevance: "unrelated keywords",
        }),
        "# Unrelated\n\nThis content mentions PostgreSQL deep inside."
      );

      await search.reindex(store);

      // "PostgreSQL" is in content, not in relevance/title/tags
      const results = search.discover("PostgreSQL", 10);
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("multi-store indexing", () => {
    it("indexes multiple stores with label prefixes", async () => {
      // Create a second store
      const tmpDir2 = await fs.mkdtemp(
        path.join(os.tmpdir(), "gnosys-search-test2-")
      );
      const store2 = new GnosysStore(tmpDir2);
      await store2.init();

      await store.writeMemory(
        "decisions",
        "a.md",
        makeFrontmatter({ id: "deci-001", title: "Store 1 Memory" }),
        "# Store 1\n\nContent"
      );
      await store2.writeMemory(
        "decisions",
        "b.md",
        makeFrontmatter({ id: "deci-002", title: "Store 2 Memory" }),
        "# Store 2\n\nContent"
      );

      search.clearIndex();
      await search.addStoreMemories(store, "project");
      await search.addStoreMemories(store2, "personal");

      const results = search.search("Memory", 10);
      expect(results.length).toBe(2);

      const paths = results.map((r) => r.relative_path);
      expect(paths.some((p) => p.startsWith("project:"))).toBe(true);
      expect(paths.some((p) => p.startsWith("personal:"))).toBe(true);

      await fs.rm(tmpDir2, { recursive: true, force: true });
    });
  });

  describe("clearIndex", () => {
    it("removes all entries from the index", async () => {
      await store.writeMemory(
        "decisions",
        "a.md",
        makeFrontmatter({ id: "deci-001" }),
        "# A\n\nContent"
      );
      await search.reindex(store);

      expect(search.search("Content", 10).length).toBeGreaterThan(0);

      search.clearIndex();
      expect(search.search("Content", 10).length).toBe(0);
    });
  });
});
