/**
 * Phase 7a: GnosysDB + Migration
 * Test Plan Reference: "Phase 7 Sub-Phase Tests — 7a"
 *
 *   TC-7a.1: gnosys migrate moves memories to gnosys.db
 *   TC-7a.2: Old commands (ask, dashboard) still work unchanged
 *   TC-7a.3: gnosys doctor shows migration status
 *   TC-7a.4: Schema is correct (6 tables, all columns present)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { GnosysDB, DbMemory } from "../lib/db.js";
import { GnosysStore } from "../lib/store.js";
import {
  createTestEnv,
  cleanupTestEnv,
  makeMemory,
  makeFrontmatter,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase7a", { withStore: true });
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

describe("Phase 7a: GnosysDB + Migration", () => {
  // ─── TC-7a.1: Migration ───────────────────────────────────────────────

  describe("TC-7a.1: Migration of markdown memories to SQLite", () => {
    it("migrate module can be imported", async () => {
      const migrateModule = await import("../lib/migrate.js");
      expect(migrateModule).toHaveProperty("migrate");
    });

    it("memories written to store can be read into DB via migrate", async () => {
      // Write memories to the markdown store
      await env.store!.writeMemory(
        "decisions",
        "migrate-a.md",
        makeFrontmatter({ id: "deci-001", title: "Decision Alpha" }),
        "# Decision Alpha\n\nWe chose TypeScript."
      );
      await env.store!.writeMemory(
        "concepts",
        "migrate-b.md",
        makeFrontmatter({
          id: "conc-001",
          title: "Concept Beta",
          category: "concepts",
        }),
        "# Concept Beta\n\nExplanation of the beta concept."
      );

      const { migrate } = await import("../lib/migrate.js");
      const stats = await migrate(env.tmpDir);

      expect(stats.memoriesMigrated).toBe(2);
      expect(stats.ftsBuild).toBe(true);

      // Verify memories are in DB
      const mem1 = env.db.getMemory("deci-001");
      expect(mem1).not.toBeNull();
      expect(mem1!.title).toBe("Decision Alpha");

      const mem2 = env.db.getMemory("conc-001");
      expect(mem2).not.toBeNull();
      expect(mem2!.title).toBe("Concept Beta");
    });

    it("migration is idempotent (re-migrate skips existing)", async () => {
      await env.store!.writeMemory(
        "decisions",
        "idempotent.md",
        makeFrontmatter({ id: "deci-010", title: "Idempotent Test" }),
        "# Idempotent\n\nShould only import once."
      );

      const { migrate } = await import("../lib/migrate.js");
      const stats1 = await migrate(env.tmpDir);
      expect(stats1.memoriesMigrated).toBe(1);

      // Migrate again
      const stats2 = await migrate(env.tmpDir);
      // Should not duplicate — either 0 or still 1 total
      const count = env.db.getMemoryCount();
      expect(count.total).toBe(1);
    });
  });

  // ─── TC-7a.2: Old commands still work ─────────────────────────────────

  describe("TC-7a.2: Post-migration command compatibility", () => {
    it("DB search works after inserting memories", () => {
      env.db.insertMemory(
        makeMemory({
          id: "compat-001",
          title: "Compat Check",
          content: "Verifying old commands work after migration",
          relevance: "compatibility migration verification",
        })
      );

      const results = env.db.searchFts("compatibility", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("compat-001");
    });

    it("getMemoryCount returns correct totals after migration", () => {
      env.db.insertMemory(
        makeMemory({ id: "cnt-001", status: "active", tier: "active" })
      );
      env.db.insertMemory(
        makeMemory({ id: "cnt-002", status: "active", tier: "active" })
      );

      const counts = env.db.getMemoryCount();
      expect(counts.total).toBe(2);
      expect(counts.active).toBe(2);
    });
  });

  // ─── TC-7a.3: Doctor / migration status ───────────────────────────────

  describe("TC-7a.3: Migration status detection", () => {
    it("isMigrated returns false for empty DB, true after adding data", () => {
      // isMigrated checks for data presence (count > 0)
      expect(env.db.isMigrated()).toBe(false);

      // Add a memory, now it should be "migrated"
      env.db.insertMemory(
        makeMemory({ id: "migration-check", title: "Migration Check" })
      );
      expect(env.db.isMigrated()).toBe(true);
    });

    it("getSchemaVersion returns current version", () => {
      const version = env.db.getSchemaVersion();
      expect(version).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── TC-7a.4: Schema correctness ─────────────────────────────────────

  describe("TC-7a.4: Schema validation", () => {
    it("has all 6 tables (memories, fts, relationships, summaries, audit_log, projects)", () => {
      // Query sqlite_master for tables
      const tables = (env.db as any).db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all()
        .map((r: any) => r.name);

      expect(tables).toContain("memories");
      expect(tables).toContain("memories_fts");
      expect(tables).toContain("relationships");
      expect(tables).toContain("summaries");
      expect(tables).toContain("audit_log");
      expect(tables).toContain("projects");
    });

    it("memories table has project_id and scope columns", () => {
      const columns = (env.db as any).db
        .prepare("PRAGMA table_info(memories)")
        .all()
        .map((c: any) => c.name);

      expect(columns).toContain("id");
      expect(columns).toContain("title");
      expect(columns).toContain("category");
      expect(columns).toContain("content");
      expect(columns).toContain("confidence");
      expect(columns).toContain("project_id");
      expect(columns).toContain("scope");
      expect(columns).toContain("embedding");
      expect(columns).toContain("tier");
    });

    it("projects table has correct columns", () => {
      const columns = (env.db as any).db
        .prepare("PRAGMA table_info(projects)")
        .all()
        .map((c: any) => c.name);

      expect(columns).toContain("id");
      expect(columns).toContain("name");
      expect(columns).toContain("working_directory");
      expect(columns).toContain("user");
      expect(columns).toContain("agent_rules_target");
      expect(columns).toContain("obsidian_vault");
      expect(columns).toContain("created");
      expect(columns).toContain("modified");
    });

    it("FTS5 virtual table is set up with porter tokenizer", () => {
      // Verify FTS works by inserting and searching
      env.db.insertMemory(
        makeMemory({
          id: "fts-check",
          title: "FTS Schema Check",
          content: "Verifying FTS5 porter tokenizer works",
        })
      );

      // Porter stemming should match "verifying" with "verify"
      const results = env.db.searchFts("verify", 10);
      expect(results.length).toBeGreaterThan(0);
    });

    it("audit_log table accepts entries", () => {
      env.db.logAudit({
        timestamp: new Date().toISOString(),
        operation: "test",
        memory_id: null,
        details: JSON.stringify({ test: true }),
        duration_ms: 10,
        trace_id: "test-trace-001",
      });

      // Verify it was inserted
      const entries = (env.db as any).db
        .prepare("SELECT * FROM audit_log WHERE trace_id = ?")
        .all("test-trace-001");
      expect(entries.length).toBe(1);
      expect(entries[0].operation).toBe("test");
    });
  });
});
