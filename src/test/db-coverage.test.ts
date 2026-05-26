/**
 * CC.4 — Coverage for audit/dream-result query helpers in db.ts
 * (getRecentDreamRuns, getLastSuccessfulDreamRun).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { GnosysDB } from "../lib/db.js";

let tmp: string;
let db: GnosysDB;

function logComplete(
  db: GnosysDB,
  timestamp: string,
  details: Record<string, unknown> | string,
  duration_ms: number | null = 1000,
): void {
  db.logAudit({
    timestamp,
    operation: "dream_complete",
    memory_id: null,
    details: typeof details === "string" ? details : JSON.stringify(details),
    duration_ms,
    trace_id: null,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-cc4-"));
  db = new GnosysDB(tmp);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("getRecentDreamRuns", () => {
  it("returns runs ordered DESC and parses details", () => {
    logComplete(db, "2026-01-01T00:00:00Z", { startedAt: "2026-01-01T00:00:00Z", summariesGenerated: 1 }, 1200);
    logComplete(db, "2026-01-02T00:00:00Z", { startedAt: "2026-01-02T00:00:00Z", summariesGenerated: 2 }, 1500);
    const out = db.getRecentDreamRuns();
    expect(out.length).toBe(2);
    expect(out[0].completed).toBe("2026-01-02T00:00:00Z");
    expect(out[0].durationMs).toBe(1500);
    expect((out[0].details as { summariesGenerated?: number }).summariesGenerated).toBe(2);
    expect(out[1].completed).toBe("2026-01-01T00:00:00Z");
  });

  it("truncates results with limit", () => {
    for (let i = 1; i <= 5; i++) {
      const day = String(i).padStart(2, "0");
      logComplete(db, `2026-01-${day}T00:00:00Z`, { startedAt: `2026-01-${day}T00:00:00Z` });
    }
    const out = db.getRecentDreamRuns(2);
    expect(out.length).toBe(2);
    expect(out[0].completed).toBe("2026-01-05T00:00:00Z");
    expect(out[1].completed).toBe("2026-01-04T00:00:00Z");
  });

  it("filters by sinceIso", () => {
    logComplete(db, "2026-01-01T00:00:00Z", { startedAt: "2026-01-01T00:00:00Z" });
    logComplete(db, "2026-01-02T00:00:00Z", { startedAt: "2026-01-02T00:00:00Z" });
    logComplete(db, "2026-01-03T00:00:00Z", { startedAt: "2026-01-03T00:00:00Z" });
    logComplete(db, "2026-01-04T00:00:00Z", { startedAt: "2026-01-04T00:00:00Z" });
    const out = db.getRecentDreamRuns(20, { sinceIso: "2026-01-02T00:00:00Z" });
    expect(out.length).toBe(3);
    expect(out.map((r) => r.completed)).toEqual([
      "2026-01-04T00:00:00Z",
      "2026-01-03T00:00:00Z",
      "2026-01-02T00:00:00Z",
    ]);
  });

  it("returns details: {} when audit details is not valid JSON", () => {
    logComplete(db, "2026-01-01T00:00:00Z", "not valid json");
    const out = db.getRecentDreamRuns();
    expect(out.length).toBe(1);
    expect(out[0].details).toEqual({});
  });

  it("failuresOnly filters by errors > 0 OR providerUnreachable", () => {
    logComplete(db, "2026-01-01T00:00:00Z", { startedAt: "2026-01-01T00:00:00Z", errors: 0 });
    logComplete(db, "2026-01-02T00:00:00Z", { startedAt: "2026-01-02T00:00:00Z", errors: 2 });
    logComplete(db, "2026-01-03T00:00:00Z", {
      startedAt: "2026-01-03T00:00:00Z",
      errors: 0,
      providerUnreachable: true,
    });
    const out = db.getRecentDreamRuns(20, { failuresOnly: true });
    expect(out.length).toBe(2);
    expect(out.map((r) => r.completed)).toEqual(
      expect.arrayContaining(["2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"]),
    );
  });

  it("failuresOnly false returns all runs including successes", () => {
    logComplete(db, "2026-01-01T00:00:00Z", { startedAt: "2026-01-01T00:00:00Z", errors: 0 });
    logComplete(db, "2026-01-02T00:00:00Z", { startedAt: "2026-01-02T00:00:00Z", errors: 2 });
    const out = db.getRecentDreamRuns(20, { failuresOnly: false });
    expect(out.length).toBe(2);
  });

  it("uses timestamp as started fallback when startedAt is missing", () => {
    logComplete(db, "2026-01-01T00:00:00Z", { summariesGenerated: 1 });
    const out = db.getRecentDreamRuns();
    expect(out.length).toBe(1);
    expect(out[0].started).toBe("2026-01-01T00:00:00Z");
  });

  it("returns three runs with default limit when seeded", () => {
    logComplete(db, "2026-01-01T00:00:00Z", { startedAt: "2026-01-01T00:00:00Z" });
    logComplete(db, "2026-01-02T00:00:00Z", { startedAt: "2026-01-02T00:00:00Z" });
    logComplete(db, "2026-01-03T00:00:00Z", { startedAt: "2026-01-03T00:00:00Z" });
    const out = db.getRecentDreamRuns();
    expect(out.length).toBe(3);
    expect(out[0].started).toBe("2026-01-03T00:00:00Z");
    expect(out[0].completed).toBe("2026-01-03T00:00:00Z");
    expect(out[0].durationMs).toBe(1000);
  });
});

describe("getLastSuccessfulDreamRun", () => {
  it("returns null when audit_log is empty", () => {
    expect(db.getLastSuccessfulDreamRun()).toBeNull();
  });

  it("returns null when only failed runs exist", () => {
    logComplete(db, "2026-01-01T00:00:00Z", {
      errors: 1,
      decayUpdated: 0,
      summariesGenerated: 0,
      relationshipsDiscovered: 0,
    });
    expect(db.getLastSuccessfulDreamRun()).toBeNull();
  });

  it("returns the most recent successful run when mixed", () => {
    logComplete(db, "2026-01-01T00:00:00Z", { summariesGenerated: 1 });
    logComplete(db, "2026-01-02T00:00:00Z", { errors: 2 });
    logComplete(db, "2026-01-03T00:00:00Z", { decayUpdated: 5 });
    const result = db.getLastSuccessfulDreamRun();
    expect(result).not.toBeNull();
    expect(result?.completed).toBe("2026-01-03T00:00:00Z");
  });

  it("counts decay-only runs as successful", () => {
    logComplete(db, "2026-01-01T00:00:00Z", {
      decayUpdated: 5,
      summariesGenerated: 0,
      relationshipsDiscovered: 0,
    });
    const result = db.getLastSuccessfulDreamRun();
    expect(result).not.toBeNull();
    expect(result?.completed).toBe("2026-01-01T00:00:00Z");
    expect((result?.details as { decayUpdated?: number }).decayUpdated).toBe(5);
  });

  it("counts relationships-only runs as successful", () => {
    logComplete(db, "2026-01-01T00:00:00Z", {
      relationshipsDiscovered: 1,
      summariesGenerated: 0,
      decayUpdated: 0,
    });
    const result = db.getLastSuccessfulDreamRun();
    expect(result).not.toBeNull();
    expect(result?.completed).toBe("2026-01-01T00:00:00Z");
  });

  it("counts summaries-only runs as successful", () => {
    logComplete(db, "2026-01-01T00:00:00Z", { summariesGenerated: 3 });
    const result = db.getLastSuccessfulDreamRun();
    expect(result).not.toBeNull();
    expect((result?.details as { summariesGenerated?: number }).summariesGenerated).toBe(3);
  });
});
