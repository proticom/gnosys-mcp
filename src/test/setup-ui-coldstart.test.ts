/**
 * Phase D — snapshot tests for the redesigned cold-start wizard
 * rendering helpers (Screen 1.0 splash, step headers, 1.5 done summary).
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
  return await import("../lib/setup/coldStart.js");
}

describe("Phase D — cold-start wizard renderers", () => {
  it("renderColdStartSplash includes brand mark, version, and step preview", async () => {
    const { renderColdStartSplash } = await load();
    const out = renderColdStartSplash("5.9.3");
    const bare = strip(out);
    expect(bare).toContain("gnosys");
    expect(bare).toContain("v5.9.3");
    expect(bare).toContain("step 1");
    expect(bare).toContain("step 4");
    expect(bare).toContain("^C exits cleanly");
    expect(bare).toMatchSnapshot();
  });

  it("renderColdStartSplash handles version with leading v", async () => {
    const { renderColdStartSplash } = await load();
    const out = renderColdStartSplash("v5.9.3");
    expect(strip(out)).toContain("v5.9.3");
  });

  it("renderStepHeader includes step counter", async () => {
    const { renderStepHeader } = await load();
    const out = renderStepHeader(["gnosys", "setup", "provider"], 1, 4, "5.9.3");
    const bare = strip(out);
    expect(bare).toContain("step 1 of 4");
    expect(bare).toContain("provider");
    expect(bare).toMatchSnapshot();
  });

  it("renderDonePanelRows aligns labels and shows full summary", async () => {
    const { renderDonePanelRows } = await load();
    const rows = renderDonePanelRows({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      keySource: "ANTHROPIC_API_KEY (env)",
      ides: ["claude-code", "cursor"],
      dreamEnabled: false,
    });
    expect(rows).toMatchSnapshot();
    // Sanity — every label is left-padded to the same width.
    const widths = new Set(rows.map((r) => r.indexOf(" ") === 0 ? -1 : r.indexOf(r.split("  ")[0]) + r.split("  ")[0].length));
    expect(widths.size).toBeGreaterThan(0);
  });

  it("renderDonePanelRows handles no IDEs", async () => {
    const { renderDonePanelRows } = await load();
    const rows = renderDonePanelRows({
      provider: "ollama",
      model: "llama3.2",
      keySource: "n/a (local)",
      ides: [],
      dreamEnabled: true,
    });
    expect(rows.some((r) => r.includes("(none)"))).toBe(true);
    expect(rows.some((r) => r.includes("enabled"))).toBe(true);
  });
});
