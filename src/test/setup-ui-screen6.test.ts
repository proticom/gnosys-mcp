/**
 * Screen 6 — `gnosys setup remote` render helpers.
 *
 * Snapshot tests for the pure helpers in remoteRender.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

async function load() {
  return await import("../lib/setup/remoteRender.js");
}

describe("Screen 6 — remote render", () => {
  it("renders the intro with `not configured` when no remote", async () => {
    const { renderRemoteIntro } = await load();
    const out = strip(renderRemoteIntro(120, 5, null));
    expect(out).toContain("gnosys");
    expect(out).toContain("Multi-machine sync");
    expect(out).toContain("not configured");
    expect(out).toContain("120 active");
    expect(out).toContain("5 archived");
    expect(out.split("\n")).toMatchSnapshot();
  });

  it("renders the intro with the remote path when configured", async () => {
    const { renderRemoteIntro } = await load();
    const out = strip(renderRemoteIntro(42, 0, "/Volumes/NAS/gnosys"));
    expect(out).toContain("/Volumes/NAS/gnosys");
  });

  it("renders validation summary with all checks ok", async () => {
    const { renderValidationSummary } = await load();
    const out = strip(
      renderValidationSummary({
        pathExists: true,
        writable: true,
        sqliteCompatible: true,
        latencyMs: 42,
        existing: { found: false, memoryCount: null, lastModified: null },
        warnings: [],
        errors: [],
      }),
    );
    expect(out).toContain("path exists");
    expect(out).toContain("writable");
    expect(out).toContain("sqlite compatible");
    expect(out).toContain("42 ms");
    expect(out).toMatchSnapshot();
  });

  it("renders validation summary with existing DB and warnings", async () => {
    const { renderValidationSummary } = await load();
    const out = strip(
      renderValidationSummary({
        pathExists: true,
        writable: true,
        sqliteCompatible: true,
        latencyMs: 80,
        existing: { found: true, memoryCount: 4237, lastModified: "2026-05-19T10:22:00Z" },
        warnings: ["high latency"],
        errors: [],
      }),
    );
    expect(out).toContain("found existing remote");
    expect(out).toContain("4237 memories");
    expect(out).toContain("last write 2026-05-19");
    expect(out).toContain("high latency");
  });

  it("renders validation summary with failures", async () => {
    const { renderValidationSummary } = await load();
    const out = strip(
      renderValidationSummary({
        pathExists: false,
        writable: false,
        sqliteCompatible: false,
        latencyMs: null,
        warnings: [],
        errors: ["permission denied"],
      }),
    );
    expect(out).toContain("✗");
    expect(out).toContain("permission denied");
  });

  it("renders the diff with previous → new", async () => {
    const { renderRemoteDiff } = await load();
    const out = strip(
      renderRemoteDiff({
        previousRemote: null,
        newRemote: "/Volumes/NAS/gnosys",
        mode: "read-write",
      }),
    );
    expect(out).toContain("remote");
    expect(out).toContain("not configured");
    expect(out).toContain("/Volumes/NAS/gnosys");
    expect(out).toContain("mode");
    expect(out).toContain("read-write");
    expect(out.split("\n")).toMatchSnapshot();
  });

  it("SYNC_MODE_LABELS covers all three modes", async () => {
    const { SYNC_MODE_LABELS } = await load();
    expect(SYNC_MODE_LABELS["read-write"]).toContain("reads and writes");
    expect(SYNC_MODE_LABELS["pull-only"]).toContain("never write");
    expect(SYNC_MODE_LABELS["push-only"]).toContain("never read");
  });
});
