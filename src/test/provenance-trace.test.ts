/**
 * Memory provenance — source columns surfaced in read; ingest events in audit log.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { GnosysDB, DbMemory } from "../lib/db.js";
import { auditToDb } from "../lib/dbWrite.js";

const CLI = path.resolve("dist/cli.js");

function makeMemory(overrides: Partial<DbMemory> = {}): DbMemory {
  const now = "2026-05-05T12:00:00.000Z";
  return {
    id: "prov-mem-1",
    title: "Provenance memory",
    category: "decisions",
    content: "Ingested body",
    summary: null,
    tags: "[]",
    relevance: "provenance test",
    author: "human+ai",
    authority: "imported",
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
    source_path: "/tmp/report.pdf",
    source_file: "report.pdf",
    source_page: 3,
    source_timerange: null,
    project_id: null,
    scope: "project",
    ...overrides,
  } as DbMemory;
}

describe("memory provenance walk", () => {
  let tmpHome: string;
  let db: GnosysDB;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-prov-"));
    db = new GnosysDB(tmpHome);
    db.insertMemory(makeMemory());
    auditToDb(db, "ingest", undefined, {
      source_file: "report.pdf",
      fileType: "pdf",
      count: 1,
    });
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(tmpHome, { recursive: true, force: true });
  });

  it("gnosys read surfaces source_file, source_page, and source_path", () => {
    db.close();
    const result = spawnSync("node", [CLI, "read", "prov-mem-1"], {
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
    expect(result.stdout).toContain("source_file: report.pdf (page 3)");
    expect(result.stdout).toContain("source_path: /tmp/report.pdf");
  });

  it("ingest audit row links source_file for provenance walk", () => {
    const ingestEvents = db
      .getAuditEntriesAfter("1970-01-01T00:00:00Z")
      .filter((e) => e.operation === "ingest");
    expect(ingestEvents.length).toBeGreaterThanOrEqual(1);
    const details = JSON.parse(ingestEvents[0].details!);
    expect(details.source_file).toBe("report.pdf");
    expect(details.count).toBe(1);

    const mem = db.getMemory("prov-mem-1");
    expect(mem?.source_file).toBe(details.source_file);
  });
});
