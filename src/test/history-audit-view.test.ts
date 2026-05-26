/**
 * Audit-based memory history — DB/audit view kept after git rollback removal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { GnosysDB, type DbMemory } from "../lib/db.js";

const CLI = path.resolve("dist/cli.js");

function makeMemory(id: string): DbMemory {
  const now = "2026-05-05T12:00:00.000Z";
  return {
    id,
    title: "Audit history memory",
    category: "decisions",
    content: "Body",
    summary: null,
    tags: "[]",
    relevance: "history test",
    author: "human+ai",
    authority: "declared",
    confidence: 0.9,
    reinforcement_count: 0,
    content_hash: "hash",
    status: "active",
    tier: "active",
    supersedes: null,
    superseded_by: null,
    last_reinforced: null,
    created: now,
    modified: now,
    embedding: null,
    source_path: null,
    source_file: null,
    source_page: null,
    source_timerange: null,
    project_id: null,
    scope: "project",
  } as DbMemory;
}

describe("audit-based memory history", () => {
  let tmpHome: string;
  let db: GnosysDB;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-history-audit-"));
    db = new GnosysDB(tmpHome);
    db.insertMemory(makeMemory("hist-mem-1"));
    db.logAudit({
      timestamp: "2026-05-05T12:00:00.000Z",
      operation: "write",
      memory_id: "hist-mem-1",
      details: null,
      duration_ms: null,
      trace_id: null,
    });
    db.logAudit({
      timestamp: "2026-05-05T13:00:00.000Z",
      operation: "reinforce",
      memory_id: "hist-mem-1",
      details: '{"signal":"useful"}',
      duration_ms: null,
      trace_id: null,
    });
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it("returns audit entries for a known memory", () => {
    const audits = db.getAuditLog("hist-mem-1", 20);
    expect(audits.length).toBe(2);
    expect(audits.map((e) => e.operation).sort()).toEqual(["reinforce", "write"]);
  });

  it("CLI history prints audit entries for a DB memory", () => {
    db.close();
    const result = spawnSync("node", [CLI, "history", "hist-mem-1"], {
      env: {
        ...process.env,
        HOME: tmpHome,
        GNOSYS_HOME: tmpHome,
        GNOSYS_LOCAL_ONLY: "1",
        VITEST: "true",
      },
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Audit history memory");
    expect(result.stdout).toContain("write");
    expect(result.stdout).toContain("reinforce");
  });

  it("CLI history errors for a missing memory", () => {
    db.close();
    const result = spawnSync("node", [CLI, "history", "missing-id"], {
      env: {
        ...process.env,
        HOME: tmpHome,
        GNOSYS_HOME: tmpHome,
        GNOSYS_LOCAL_ONLY: "1",
        VITEST: "true",
      },
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not found/i);
  });
});
