/**
 * Dream pause/resume — abort mid-cycle and clean re-run after completion.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { GnosysDB } from "../lib/db.js";
import type { GnosysConfig } from "../lib/config.js";
import { GnosysDreamEngine } from "../lib/dream.js";

function sqlite(db: GnosysDB) {
  return (db as unknown as {
    db: { pragma: (s: string, opts?: { simple: boolean }) => unknown };
  }).db;
}

function baseConfig(): GnosysConfig {
  return {
    llm: { defaultProvider: "anthropic" },
    dream: { enabled: true },
  } as unknown as GnosysConfig;
}

const decayOnlyDream = {
  enabled: true,
  minMemories: 3,
  selfCritique: false,
  generateSummaries: false,
  discoverRelationships: false,
};

function seedMemories(db: GnosysDB, count: number): void {
  for (let i = 0; i < count; i++) {
    const id = `dream-resume-${String(i).padStart(3, "0")}`;
    db.insertMemory({
      id,
      title: `Dream resume ${i}`,
      category: "decisions",
      content: `Memory body ${i}`,
      summary: null,
      tags: '["dream","resume"]',
      relevance: "dream resume test",
      author: "human+ai",
      authority: "declared",
      confidence: 0.9,
      reinforcement_count: 0,
      content_hash: `hash-${id}`,
      status: "active",
      tier: "active",
      supersedes: null,
      superseded_by: null,
      last_reinforced: null,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      embedding: null,
      source_path: null,
      source_file: null,
      source_page: null,
      source_timerange: null,
      project_id: null,
      scope: "project",
    });
  }
}

let tmp: string;
let db: GnosysDB;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-dream-resume-"));
  db = new GnosysDB(tmp);
  seedMemories(db, 5);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Dream abort and resume", () => {
  it("aborts cleanly at a phase boundary with a consistent DB", async () => {
    const engine = new GnosysDreamEngine(db, baseConfig(), decayOnlyDream);

    const report = await engine.dream((phase) => {
      if (phase === "decay") engine.abort();
    });

    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/abort requested/i);
    expect(sqlite(db).pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.getAllMemories().length).toBe(5);
  });

  it("re-run after a completed cycle picks up cleanly (no corruption or dupes)", async () => {
    const engine = new GnosysDreamEngine(db, baseConfig(), decayOnlyDream);
    const before = db.getAllMemories().length;

    const first = await engine.dream();
    expect(first.errors.filter((e) => !e.includes("Provider unavailable"))).toEqual([]);

    const secondEngine = new GnosysDreamEngine(db, baseConfig(), decayOnlyDream);
    const second = await secondEngine.dream();
    expect(second.errors.filter((e) => !e.includes("Provider unavailable"))).toEqual([]);

    expect(sqlite(db).pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.getAllMemories().length).toBe(before);

    const ids = db.getAllMemories().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
