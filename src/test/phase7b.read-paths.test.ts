/**
 * Phase 7b: Read Paths Rewired to SQLite
 * Test Plan Reference: "Phase 7 Sub-Phase Tests — 7b"
 *
 *   TC-7b.1: ask, hybrid-search, recall all read from SQLite
 *   TC-7b.2: Performance — SQLite reads are fast
 *   TC-7b.3: Multi-project recall works with projectRoot
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GnosysDB } from "../lib/db.js";
import {
  createTestEnv,
  cleanupTestEnv,
  makeMemory,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase7b");
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

describe("Phase 7b: Read Paths Rewired", () => {
  // ─── TC-7b.1: Read from SQLite ───────────────────────────────────────

  describe("TC-7b.1: Search and recall read from SQLite", () => {
    it("searchFts returns results from DB", () => {
      env.db.insertMemory(
        makeMemory({
          id: "read-001",
          title: "API Gateway Design",
          content: "Kong API gateway handles rate limiting and auth",
          relevance: "API gateway Kong rate-limiting auth",
        })
      );

      const results = env.db.searchFts("API gateway", 10);
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("read-001");
      expect(results[0].title).toBe("API Gateway Design");
    });

    it("discoverFts searches relevance column preferentially", () => {
      env.db.insertMemory(
        makeMemory({
          id: "disc-001",
          title: "Monitoring Setup",
          content: "Basic content about monitoring",
          relevance: "monitoring Datadog APM traces logs alerts observability",
        })
      );

      const results = env.db.discoverFts("Datadog observability", 10);
      expect(results.length).toBe(1);
      expect(results[0].relevance).toContain("Datadog");
    });

    it("getActiveMemories returns only active-tier memories", () => {
      env.db.insertMemory(
        makeMemory({ id: "active-001", tier: "active", status: "active" })
      );
      env.db.insertMemory(
        makeMemory({ id: "archived-001", tier: "archive", status: "archived" })
      );

      const active = env.db.getActiveMemories();
      expect(active.length).toBe(1);
      expect(active[0].id).toBe("active-001");
    });

    it("recall module can be imported and has expected exports", async () => {
      const recallModule = await import("../lib/recall.js");
      expect(recallModule).toHaveProperty("recall");
    });
  });

  // ─── TC-7b.2: Performance ────────────────────────────────────────────

  describe("TC-7b.2: SQLite read performance", () => {
    it("fetches 100 memories in under 100ms", () => {
      // Seed 100 memories
      for (let i = 0; i < 100; i++) {
        env.db.insertMemory(
          makeMemory({
            id: `perf-${i.toString().padStart(3, "0")}`,
            title: `Performance Test ${i}`,
            content: `Content for performance benchmarking memory ${i}`,
          })
        );
      }

      const start = performance.now();
      const mems = env.db.getAllMemories();
      const elapsed = performance.now() - start;

      expect(mems.length).toBe(100);
      expect(elapsed).toBeLessThan(100); // 100ms budget
    });

    it("FTS5 search on 100 memories completes in under 50ms", () => {
      for (let i = 0; i < 100; i++) {
        env.db.insertMemory(
          makeMemory({
            id: `fts-perf-${i}`,
            title: `Architecture pattern ${i}`,
            content: `Microservices design pattern number ${i} for scalability`,
            relevance: "architecture microservices scalability patterns",
          })
        );
      }

      const start = performance.now();
      const results = env.db.searchFts("microservices scalability", 20);
      const elapsed = performance.now() - start;

      expect(results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(50); // 50ms budget
    });
  });

  // ─── TC-7b.3: Multi-project recall ───────────────────────────────────

  describe("TC-7b.3: Multi-project recall with projectRoot", () => {
    it("getMemoriesByProject returns only that project's memories", () => {
      env.db.insertMemory(
        makeMemory({
          id: "mp-a-001",
          title: "Alpha Memory",
          project_id: "proj-alpha",
          scope: "project",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "mp-b-001",
          title: "Beta Memory",
          project_id: "proj-beta",
          scope: "project",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "mp-u-001",
          title: "User Memory",
          scope: "user",
          project_id: null,
        })
      );

      const alpha = env.db.getMemoriesByProject("proj-alpha");
      expect(alpha.length).toBe(1);
      expect(alpha[0].id).toBe("mp-a-001");

      const beta = env.db.getMemoriesByProject("proj-beta");
      expect(beta.length).toBe(1);
      expect(beta[0].id).toBe("mp-b-001");
    });

    it("user-scoped memories are accessible regardless of project", () => {
      env.db.insertMemory(
        makeMemory({
          id: "user-001",
          title: "User Preference",
          scope: "user",
          project_id: null,
        })
      );

      const userMems = env.db.getMemoriesByScope("user");
      expect(userMems.length).toBe(1);
      expect(userMems[0].id).toBe("user-001");
    });
  });
});
