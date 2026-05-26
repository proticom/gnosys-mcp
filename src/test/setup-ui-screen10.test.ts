/**
 * Screen 10 — `gnosys setup sync-projects` output.
 *
 * Snapshot tests for the pure render helpers in syncProjectsRender.ts.
 * Column width pinned at 80 so output is deterministic across machines.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const ORIGINAL_HOME = process.env.HOME;

const FAKE_HOME = "/home/gnosys-test";

beforeAll(() => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
  // Pin HOME so os.homedir() inside collapsePath is deterministic across
  // dev / CI without hardcoding a specific developer machine path.
  process.env.HOME = FAKE_HOME;
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

async function load() {
  return await import("../lib/setup/syncProjectsRender.js");
}

describe("Screen 10 — sync-projects render", () => {
  it("renders the header with version", async () => {
    const { renderSyncHeader } = await load();
    const out = strip(renderSyncHeader("5.9.3"));
    expect(out).toContain("gnosys");
    expect(out).toContain("upgrading registered projects");
    expect(out).toContain("v5.9.3");
    expect(out.split("\n")).toMatchSnapshot();
  });

  it("collapsePath shortens long absolute paths", async () => {
    const { collapsePath } = await load();
    const short = collapsePath(`${FAKE_HOME}/proj`, FAKE_HOME);
    expect(short).toBe("~/proj");

    const veryLong = `${FAKE_HOME}/Library/Mobile Documents/com~apple~CloudDocs/Documents/Proticom/something/deep`;
    const collapsed = collapsePath(veryLong, FAKE_HOME);
    expect(collapsed.length).toBeLessThanOrEqual(50);
    expect(collapsed.endsWith("/…")).toBe(true);
  });

  it("renders the upgraded section with full project list", async () => {
    const { renderUpgradedSection } = await load();
    const rows = [
      { title: "gnosys-test", fullPath: FAKE_HOME },
      { title: "squat-counter", fullPath: "/Volumes/Dev/projects/squat-counter" },
      { title: "agent-first-site", fullPath: "/Volumes/Dev/projects/agent-first-site" },
    ];
    const lines = renderUpgradedSection(rows).map(strip);
    expect(lines[0]).toContain("upgraded   3 projects");
    expect(lines).toMatchSnapshot();
  });

  it("renders upgraded with overflow collapse (more than 5)", async () => {
    const { renderUpgradedSection } = await load();
    const rows = Array.from({ length: 9 }, (_, i) => ({
      title: `proj-${i}`,
      fullPath: `/tmp/proj-${i}`,
    }));
    const lines = renderUpgradedSection(rows).map(strip);
    // Header + 5 visible + "(N more)"
    expect(lines.length).toBe(7);
    expect(lines[lines.length - 1]).toContain("(4 more)");
  });

  it("renders the skipped section with no .gnosys directory hint", async () => {
    const { renderSkippedSection } = await load();
    const rows = [
      { title: "defrag-me", fullPath: `${FAKE_HOME}/Library/dead-proj` },
    ];
    const lines = renderSkippedSection(rows).map(strip);
    expect(lines[0]).toContain("skipped");
    expect(lines[0]).toContain("no .gnosys directory");
    expect(lines).toMatchSnapshot();
  });

  it("renders the failed section when there are failures", async () => {
    const { renderFailedSection } = await load();
    const rows = [{ title: "weird-proj", fullPath: "/tmp/weird (EACCES)" }];
    const lines = renderFailedSection(rows).map(strip);
    expect(lines[0]).toContain("failed     1 projects");
    expect(lines.length).toBe(2);
  });

  it("renders machines section with older-version warning", async () => {
    const { renderMachinesSection } = await load();
    const rows = [
      { hostname: "EdsMacStudio", version: "5.9.3", lastSeen: "2026-05-19T14:02:00Z", isCurrent: false },
      { hostname: "EdsMBP", version: "5.7.1", lastSeen: "2026-05-12T09:00:00Z", isCurrent: false },
      { hostname: "this-mac", version: "5.9.3", lastSeen: "2026-05-20T08:00:00Z", isCurrent: true },
    ];
    const lines = renderMachinesSection(rows, "5.9.3").map(strip);
    expect(lines[0]).toContain("connected machines");
    // Older machine should be tagged
    const mbpLine = lines.find((l) => l.includes("EdsMBP"));
    expect(mbpLine).toBeDefined();
    expect(mbpLine).toContain("← older");
    expect(lines).toMatchSnapshot();
  });

  it("renders machines section returns empty when only one machine", async () => {
    const { renderMachinesSection } = await load();
    const rows = [
      { hostname: "solo", version: "5.9.3", lastSeen: "2026-05-20T08:00:00Z", isCurrent: true },
    ];
    expect(renderMachinesSection(rows, "5.9.3")).toEqual([]);
  });

  it("renders the done line with version", async () => {
    const { renderDoneLine } = await load();
    const out = strip(renderDoneLine("5.9.3"));
    expect(out).toContain("done");
    expect(out).toContain("central DB stamped v5.9.3");
  });

  it("renders dashboard summary with collapsed paths", async () => {
    const { renderDashboardSummary } = await load();
    const lines = renderDashboardSummary(`${FAKE_HOME}/gnosys-dashboard.html`, `${FAKE_HOME}/gnosys-dashboard.md`).map(strip);
    expect(lines[0]).toContain("portfolio dashboard regenerated");
    expect(lines[1]).toContain("html");
    expect(lines[2]).toContain("md");
  });
});
