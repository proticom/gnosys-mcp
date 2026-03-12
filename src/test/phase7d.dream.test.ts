/**
 * Phase 7d: Dream Mode
 * Test Plan Reference: "Phase 7 Sub-Phase Tests — 7d"
 *
 *   TC-7d.1: Dream Mode config + consolidation engine
 *   TC-7d.2: No CPU hog — runs only when idle
 *   TC-7d.3: Dream notes appear in audit_log
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestEnv,
  cleanupTestEnv,
  makeMemory,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase7d");
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

describe("Phase 7d: Dream Mode", () => {
  // ─── TC-7d.1: Dream engine and config ────────────────────────────────

  describe("TC-7d.1: Dream Mode configuration and engine", () => {
    it("GnosysDreamEngine class is importable", async () => {
      const dreamModule = await import("../lib/dream.js");
      expect(dreamModule).toHaveProperty("GnosysDreamEngine");
      expect(typeof dreamModule.GnosysDreamEngine).toBe("function");
    });

    it("DEFAULT_DREAM_CONFIG has disabled=true by default", async () => {
      const { DEFAULT_DREAM_CONFIG } = await import("../lib/dream.js");
      expect(DEFAULT_DREAM_CONFIG.enabled).toBe(false);
    });

    it("DEFAULT_DREAM_CONFIG has sensible idle threshold", async () => {
      const { DEFAULT_DREAM_CONFIG } = await import("../lib/dream.js");
      expect(DEFAULT_DREAM_CONFIG.idleMinutes).toBeGreaterThan(0);
      expect(DEFAULT_DREAM_CONFIG.maxRuntimeMinutes).toBeGreaterThan(0);
    });

    it("dream config supports self-critique and summary generation flags", async () => {
      const { DEFAULT_DREAM_CONFIG } = await import("../lib/dream.js");
      expect(typeof DEFAULT_DREAM_CONFIG.selfCritique).toBe("boolean");
      expect(typeof DEFAULT_DREAM_CONFIG.generateSummaries).toBe("boolean");
      expect(typeof DEFAULT_DREAM_CONFIG.discoverRelationships).toBe("boolean");
    });
  });

  // ─── TC-7d.2: Resource safety ────────────────────────────────────────

  describe("TC-7d.2: Resource safety (no CPU hog)", () => {
    it("dream config has runtime limits", async () => {
      const { DEFAULT_DREAM_CONFIG } = await import("../lib/dream.js");
      // Max runtime should be bounded
      expect(DEFAULT_DREAM_CONFIG.maxRuntimeMinutes).toBeLessThanOrEqual(60);
      // Min memories threshold prevents running on empty stores
      expect(DEFAULT_DREAM_CONFIG.minMemories).toBeGreaterThan(0);
    });
  });

  // ─── TC-7d.3: Dream notes in audit_log ───────────────────────────────

  describe("TC-7d.3: Dream activity audit logging", () => {
    it("audit_log accepts dream-related entries", () => {
      // Simulate dream engine logging
      env.db.logAudit({
        timestamp: new Date().toISOString(),
        operation: "consolidate",
        memory_id: "dream-mem-001",
        details: JSON.stringify({
          action: "merge",
          sources: ["mem-001", "mem-002"],
          dreamCycle: 1,
        }),
        duration_ms: 1500,
        trace_id: "dream-trace-001",
      });

      env.db.logAudit({
        timestamp: new Date().toISOString(),
        operation: "decay",
        memory_id: "dream-mem-002",
        details: JSON.stringify({
          oldConfidence: 0.8,
          newConfidence: 0.72,
          daysSinceReinforced: 30,
        }),
        duration_ms: 5,
        trace_id: "dream-trace-001",
      });

      // Query audit log for dream entries
      const entries = (env.db as any).db
        .prepare("SELECT * FROM audit_log WHERE trace_id = ?")
        .all("dream-trace-001");

      expect(entries.length).toBe(2);
      expect(entries.map((e: any) => e.operation).sort()).toEqual([
        "consolidate",
        "decay",
      ]);
    });

    it("audit_log entries have correct schema", () => {
      env.db.logAudit({
        timestamp: new Date().toISOString(),
        operation: "maintain",
        memory_id: null,
        details: JSON.stringify({ phase: "dream", dryRun: false }),
        duration_ms: 500,
        trace_id: "schema-check",
      });

      const entry = (env.db as any).db
        .prepare("SELECT * FROM audit_log WHERE trace_id = ?")
        .get("schema-check");

      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("timestamp");
      expect(entry).toHaveProperty("operation");
      expect(entry).toHaveProperty("memory_id");
      expect(entry).toHaveProperty("details");
      expect(entry).toHaveProperty("duration_ms");
      expect(entry).toHaveProperty("trace_id");
    });
  });
});
