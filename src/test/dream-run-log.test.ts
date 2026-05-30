import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDreamLock,
  appendDreamRun,
  countChangedMemoriesSince,
  estimateCost,
  estimateTokens,
  fingerprintMemories,
  getDreamLockPath,
  isInsideNightWindow,
  readDreamRuns,
  readDreamState,
  writeDreamState,
  type DreamRunRecord,
} from "../lib/dreamRunLog.js";
import type { DbMemory } from "../lib/db.js";

let tmp: string;
let oldHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-dream-test-"));
  oldHome = process.env.GNOSYS_HOME;
  process.env.GNOSYS_HOME = tmp;
});

afterEach(() => {
  if (oldHome === undefined) {
    delete process.env.GNOSYS_HOME;
  } else {
    process.env.GNOSYS_HOME = oldHome;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function memory(id: string, modified: string): DbMemory {
  return {
    id,
    title: `Memory ${id}`,
    category: "test",
    content: "memory content",
    summary: null,
    tags: "[]",
    relevance: "test",
    author: "ai",
    authority: "observed",
    confidence: 0.8,
    reinforcement_count: 0,
    content_hash: `hash-${id}`,
    status: "active",
    tier: "active",
    supersedes: null,
    superseded_by: null,
    last_reinforced: null,
    created: modified,
    modified,
    embedding: null,
    source_path: null,
    source_file: null,
    source_page: null,
    source_timerange: null,
    project_id: null,
    scope: "project",
  };
}

function runRecord(id: string): DreamRunRecord {
  return {
    id,
    trigger: "scheduled",
    status: "completed",
    startedAt: "2026-05-30T02:00:00.000Z",
    finishedAt: "2026-05-30T02:00:05.000Z",
    durationMs: 5000,
    machine: { hostname: "test" },
    provider: "xai",
    model: "grok-4.3",
    gates: [],
    phases: [],
    llmCalls: [],
    totals: {
      llmCallsMade: 1,
      llmCallsSkipped: 2,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 5,
      estimatedCostUsd: 0.001,
    },
    effectiveness: {
      usefulOutputScore: 2,
      costPerUsefulOutput: 0.0005,
      decaysApplied: 0,
      summariesGenerated: 0,
      summariesUpdated: 0,
      reviewSuggestions: 0,
      relationshipsDiscovered: 1,
    },
    errors: [],
  };
}

describe("dreamRunLog", () => {
  it("writes state and append-only run records", () => {
    writeDreamState({
      lastRunAt: "2026-05-30T02:00:00.000Z",
      analyzedFingerprints: {
        abc: { kind: "relationship", lastAnalyzedAt: "2026-05-30T02:00:00.000Z", memoryIds: ["m1"] },
      },
    });
    expect(readDreamState().analyzedFingerprints.abc.memoryIds).toEqual(["m1"]);

    appendDreamRun(runRecord("one"));
    appendDreamRun({ ...runRecord("two"), status: "skipped" });
    expect(readDreamRuns()).toHaveLength(2);
    expect(readDreamRuns({ status: "skipped" })[0].id).toBe("two");
  });

  it("creates stable fingerprints from memory identity and modification", () => {
    const a = fingerprintMemories("relationship", [memory("a", "2026-01-01"), memory("b", "2026-01-02")]);
    const b = fingerprintMemories("relationship", [memory("b", "2026-01-02"), memory("a", "2026-01-01")]);
    const c = fingerprintMemories("relationship", [memory("a", "2026-01-03"), memory("b", "2026-01-02")]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("checks night window and changed memory counts", () => {
    expect(isInsideNightWindow(new Date("2026-05-30T03:00:00"), { startHour: 2, endHour: 5 })).toBe(true);
    expect(isInsideNightWindow(new Date("2026-05-30T12:00:00"), { startHour: 2, endHour: 5 })).toBe(false);
    expect(isInsideNightWindow(new Date("2026-05-30T23:00:00"), { startHour: 22, endHour: 5 })).toBe(true);
    expect(countChangedMemoriesSince([memory("a", "2026-01-01"), memory("b", "2026-01-03")], "2026-01-02")).toBe(1);
  });

  it("estimates tokens and cost, and prevents overlapping locks", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateCost("grok-4.3", 1_000_000, 1_000_000)).toBeGreaterThan(0);

    const first = acquireDreamLock();
    expect(first.acquired).toBe(true);
    const second = acquireDreamLock();
    expect(second.acquired).toBe(false);
    if (first.acquired) first.release();
    expect(fs.existsSync(getDreamLockPath())).toBe(false);
  });
});
