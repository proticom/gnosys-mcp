/**
 * Phase 1.5 — audit_log sync between local and remote.
 *
 * The audit_log table is append-only with autoincrement IDs. Sync uses the
 * latest timestamp on each side as the high-water mark; entries newer than
 * that get pushed/pulled. We don't carry the local id across — the remote
 * assigns its own — so identical content can theoretically be inserted twice
 * if both machines log the same event simultaneously. Acceptable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GnosysDB } from "../lib/db.js";
import { RemoteSync } from "../lib/remote.js";

let local: GnosysDB;
let localTmp: string;
let remoteTmp: string;
let sync: RemoteSync;

beforeEach(() => {
  localTmp = mkdtempSync(join(tmpdir(), "gnosys-local-"));
  remoteTmp = mkdtempSync(join(tmpdir(), "gnosys-remote-"));
  local = new GnosysDB(localTmp);
  // Configure remote pointing at remoteTmp
  local.setMeta("remote_path", remoteTmp);
  // Ensure the remote DB exists so getRemoteDb() can open it
  new GnosysDB(remoteTmp).close();
  sync = new RemoteSync(local, remoteTmp);
});

afterEach(() => {
  local.close();
  rmSync(localTmp, { recursive: true, force: true });
  rmSync(remoteTmp, { recursive: true, force: true });
});

describe("audit_log sync", () => {
  it("push copies local audit entries to remote", async () => {
    local.logAudit({
      timestamp: "2026-05-05T12:00:00.000Z",
      operation: "write",
      memory_id: "mem-1",
      details: null,
      duration_ms: null,
      trace_id: null,
    });
    local.logAudit({
      timestamp: "2026-05-05T12:01:00.000Z",
      operation: "read",
      memory_id: "mem-1",
      details: '{"who":"agent"}',
      duration_ms: 42,
      trace_id: "trace-001",
    });

    const result = await sync.push();
    expect(result.errors).toEqual([]);
    expect(result.auditPushed).toBe(2);

    const remote = new GnosysDB(remoteTmp);
    const remoteEntries = remote.queryAuditLog({ limit: 10 });
    expect(remoteEntries).toHaveLength(2);
    expect(remoteEntries.map((e) => e.operation).sort()).toEqual(["read", "write"]);
    remote.close();
  });

  it("pull copies remote-only audit entries to local", async () => {
    const remote = new GnosysDB(remoteTmp);
    remote.logAudit({
      timestamp: "2026-05-05T12:00:00.000Z",
      operation: "dream_complete",
      memory_id: null,
      details: '{"durationMs":123}',
      duration_ms: 123,
      trace_id: null,
    });
    remote.close();

    const result = await sync.pull();
    expect(result.errors).toEqual([]);
    expect(result.auditPulled).toBe(1);

    const localEntries = local.queryAuditLog({ limit: 10 });
    expect(localEntries.find((e) => e.operation === "dream_complete")).toBeDefined();
    expect(localEntries.some((e) => e.operation === "remote_pull")).toBe(true);
  });

  it("does not double-push entries already on the remote", async () => {
    local.logAudit({
      timestamp: "2026-05-05T12:00:00.000Z",
      operation: "write",
      memory_id: "mem-1",
      details: null,
      duration_ms: null,
      trace_id: null,
    });

    const first = await sync.push();
    expect(first.auditPushed).toBe(1);

    // Second push should find no new entries
    const second = await sync.push();
    expect(second.auditPushed).toBeUndefined();
  });

  it("first push sends ALL local entries regardless of remote contents (full convergence)", async () => {
    // Seed remote with one entry — irrelevant to push logic since we use a
    // per-direction cursor, not the remote's high-water mark.
    const remote = new GnosysDB(remoteTmp);
    remote.logAudit({
      timestamp: "2026-05-05T10:00:00.000Z",
      operation: "write",
      memory_id: "remote-only",
      details: null,
      duration_ms: null,
      trace_id: null,
    });
    remote.close();

    // Local has 3 entries — first sync should push all of them.
    local.logAudit({
      timestamp: "2026-05-05T09:00:00.000Z",
      operation: "write",
      memory_id: "older-than-remote",
      details: null,
      duration_ms: null,
      trace_id: null,
    });
    local.logAudit({
      timestamp: "2026-05-05T11:00:00.000Z",
      operation: "write",
      memory_id: "new1",
      details: null,
      duration_ms: null,
      trace_id: null,
    });
    local.logAudit({
      timestamp: "2026-05-05T12:00:00.000Z",
      operation: "write",
      memory_id: "new2",
      details: null,
      duration_ms: null,
      trace_id: null,
    });

    const result = await sync.push();
    expect(result.auditPushed).toBe(3);
  });

  it("full sync (push + pull) merges audit entries from both sides", async () => {
    local.logAudit({
      timestamp: "2026-05-05T11:00:00.000Z",
      operation: "write",
      memory_id: "from-local",
      details: null,
      duration_ms: null,
      trace_id: null,
    });

    const remote = new GnosysDB(remoteTmp);
    remote.logAudit({
      timestamp: "2026-05-05T11:30:00.000Z",
      operation: "read",
      memory_id: "from-remote",
      details: null,
      duration_ms: null,
      trace_id: null,
    });
    remote.close();

    const result = await sync.sync();

    // After sync, both sides should see both memory-audit entries; local also
    // records machine-local remote_push / remote_pull observability rows.
    const localEntries = local.queryAuditLog({ limit: 10 });
    const memoryAudits = localEntries.filter((e) => e.operation === "write" || e.operation === "read");
    expect(memoryAudits).toHaveLength(2);

    const remote2 = new GnosysDB(remoteTmp);
    const remoteEntries = remote2.queryAuditLog({ limit: 10 });
    expect(remoteEntries).toHaveLength(2);
    remote2.close();

    expect(result.errors).toEqual([]);
  });
});
