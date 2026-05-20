/**
 * Phase C — snapshot tests for the redesigned settings panel.
 *
 * These exercise the rendering helpers exported from summary.ts directly,
 * which lets us snapshot the panel layout at 80/100/120 cols without
 * spawning a child process.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { DEFAULT_CONFIG, type GnosysConfig } from "../lib/config.js";

beforeAll(() => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

async function load() {
  return await import("../lib/setup/summary.js");
}

function cloneCfg(overrides: Partial<GnosysConfig>): GnosysConfig {
  return { ...DEFAULT_CONFIG, ...overrides } as GnosysConfig;
}

describe("Phase C — settings panel (summary)", () => {
  it("renders panel rows for a fresh anthropic config", async () => {
    const { __test, buildSections } = await load();
    const cfg = cloneCfg({});
    const rows = await __test.renderPanelRows(cfg, buildSections());
    expect(rows.map(strip)).toMatchSnapshot();
  });

  it("renders panel rows after a switch to xai", async () => {
    const { __test, buildSections } = await load();
    const cfg = cloneCfg({
      llm: {
        ...DEFAULT_CONFIG.llm,
        defaultProvider: "xai",
        xai: { ...(DEFAULT_CONFIG.llm.xai ?? {}), model: "grok-4.20" },
      },
    });
    const rows = await __test.renderPanelRows(cfg, buildSections());
    // Section 1 (provider) should now show xai, not anthropic.
    expect(strip(rows[0])).toContain("xai");
    expect(strip(rows[0])).not.toContain("anthropic");
    expect(rows.map(strip)).toMatchSnapshot();
  });

  it("buildTrailingMap marks edited sections with ✓", async () => {
    const { __test, buildSections } = await load();
    const sections = buildSections();
    const updated = new Set<string>(["1", "3"]);
    const trailing = __test.buildTrailingMap(updated, sections);
    // section index 0 (key=1) and index 2 (key=3) should be marked
    expect(strip(trailing[0] ?? "")).toBe("✓");
    expect(strip(trailing[2] ?? "")).toBe("✓");
    expect(trailing[1]).toBeUndefined();
  });

  it("resolveActiveStorePath prefers .gnosys/ when present", async () => {
    const { __test } = await load();
    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-active-"));
    try {
      // No .gnosys/gnosys.json → falls back to global
      const fallback = __test.resolveActiveStorePath(tmp);
      expect(fallback).not.toBe(path.join(tmp, ".gnosys"));

      // After creating .gnosys/gnosys.json → uses project store
      fs.mkdirSync(path.join(tmp, ".gnosys"), { recursive: true });
      fs.writeFileSync(path.join(tmp, ".gnosys", "gnosys.json"), "{}");
      const active = __test.resolveActiveStorePath(tmp);
      expect(active).toBe(path.join(tmp, ".gnosys"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
