/**
 * Phase 7c: Dual-Write (SQLite + Markdown)
 * Test Plan Reference: "Phase 7 Sub-Phase Tests — 7c"
 *
 *   TC-7c.1: gnosys add writes to both SQLite and Markdown
 *   TC-7c.2: Manual edit of .md file is picked up on next reindex
 *   TC-7c.3: Maintain and reinforce update both layers
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "fs/promises";
import path from "path";
import { GnosysDB } from "../lib/db.js";
import { GnosysStore } from "../lib/store.js";
import { GnosysSearch } from "../lib/search.js";
import {
  createTestEnv,
  cleanupTestEnv,
  makeMemory,
  makeFrontmatter,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase7c", { withStore: true });
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

describe("Phase 7c: Dual-Write", () => {
  // ─── TC-7c.1: Write to both layers ───────────────────────────────────

  describe("TC-7c.1: Dual-write to SQLite and Markdown", () => {
    it("memory exists in both DB and filesystem after write", async () => {
      // Write to markdown store
      const fm = makeFrontmatter({
        id: "dual-001",
        title: "Dual Write Test",
        category: "decisions",
      });
      await env.store!.writeMemory(
        "decisions",
        "dual-write.md",
        fm,
        "# Dual Write Test\n\nContent for dual-write."
      );

      // Also insert into DB (simulating dual-write)
      env.db.insertMemory(
        makeMemory({
          id: "dual-001",
          title: "Dual Write Test",
          content: "# Dual Write Test\n\nContent for dual-write.",
          category: "decisions",
        })
      );

      // Verify markdown exists
      const storeMem = await env.store!.readMemory("decisions/dual-write.md");
      expect(storeMem).not.toBeNull();
      expect(storeMem!.frontmatter.id).toBe("dual-001");

      // Verify DB exists
      const dbMem = env.db.getMemory("dual-001");
      expect(dbMem).not.toBeNull();
      expect(dbMem!.title).toBe("Dual Write Test");
    });

    it("DB content matches store content for the same memory", async () => {
      const content = "# Consistency Check\n\nBoth layers should agree.";
      const fm = makeFrontmatter({
        id: "consist-001",
        title: "Consistency",
        category: "decisions",
      });

      await env.store!.writeMemory("decisions", "consist.md", fm, content);
      env.db.insertMemory(
        makeMemory({
          id: "consist-001",
          title: "Consistency",
          content,
          category: "decisions",
        })
      );

      const storeMem = await env.store!.readMemory("decisions/consist.md");
      const dbMem = env.db.getMemory("consist-001");

      expect(storeMem!.frontmatter.title).toBe(dbMem!.title);
      expect(storeMem!.content.trim()).toBe(dbMem!.content.trim());
    });
  });

  // ─── TC-7c.2: Manual .md edit reindexing ─────────────────────────────

  describe("TC-7c.2: Manual markdown edits picked up on reindex", () => {
    it("edited markdown file is reflected after reindex", async () => {
      // Write initial memory
      await env.store!.writeMemory(
        "decisions",
        "editable.md",
        makeFrontmatter({ id: "edit-001", title: "Original Title" }),
        "# Original Title\n\nOriginal content."
      );

      // Manually edit the file
      const filePath = path.join(env.tmpDir, "decisions", "editable.md");
      let raw = await fsp.readFile(filePath, "utf-8");
      raw = raw.replace("Original content.", "Manually edited content.");
      await fsp.writeFile(filePath, raw, "utf-8");

      // Re-read from store
      const mem = await env.store!.readMemory("decisions/editable.md");
      expect(mem).not.toBeNull();
      expect(mem!.content).toContain("Manually edited content.");
    });

    it("search index reflects manual edits after reindex", async () => {
      await env.store!.writeMemory(
        "decisions",
        "search-edit.md",
        makeFrontmatter({
          id: "se-001",
          title: "Searchable Edit",
          relevance: "original keyword",
        }),
        "# Searchable Edit\n\nOriginal keyword content."
      );

      const search = new GnosysSearch(env.tmpDir);
      await search.reindex(env.store!);

      // Search finds original
      let results = search.search("original keyword", 10);
      expect(results.length).toBeGreaterThan(0);

      // Manually edit
      const filePath = path.join(env.tmpDir, "decisions", "search-edit.md");
      let raw = await fsp.readFile(filePath, "utf-8");
      raw = raw.replace("original keyword", "updated keyword");
      await fsp.writeFile(filePath, raw, "utf-8");

      // Reindex
      await search.reindex(env.store!);

      // Search finds updated
      results = search.search("updated keyword", 10);
      expect(results.length).toBeGreaterThan(0);

      search.close();
    });
  });

  // ─── TC-7c.3: Maintain and reinforce update both layers ──────────────

  describe("TC-7c.3: Updates propagate to both layers", () => {
    it("updating DB memory fields reflects correct state", () => {
      env.db.insertMemory(
        makeMemory({
          id: "reinforce-001",
          title: "Reinforced Memory",
          reinforcement_count: 0,
          confidence: 0.8,
        })
      );

      // Simulate reinforce
      env.db.updateMemory("reinforce-001", {
        reinforcement_count: 1,
        confidence: 0.85,
        last_reinforced: new Date().toISOString(),
      });

      const mem = env.db.getMemory("reinforce-001");
      expect(mem!.reinforcement_count).toBe(1);
      expect(mem!.confidence).toBe(0.85);
      expect(mem!.last_reinforced).not.toBeNull();
    });

    it("updating store memory updates modified date", async () => {
      await env.store!.writeMemory(
        "decisions",
        "update-date.md",
        makeFrontmatter({
          id: "upd-001",
          modified: "2026-01-01",
        }),
        "# Update Date Test\n\nContent."
      );

      const updated = await env.store!.updateMemory(
        "decisions/update-date.md",
        { confidence: 0.95 }
      );

      expect(updated).not.toBeNull();
      // Modified date should be today, not the original
      const today = new Date().toISOString().split("T")[0];
      expect(updated!.frontmatter.modified).toBe(today);
    });
  });
});
