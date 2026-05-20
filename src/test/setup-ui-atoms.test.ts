/**
 * Phase A — Snapshot tests for the v5.9.3 setup/ui atoms.
 *
 * Every atom renders at a fixed 80-col width. We strip ANSI before
 * snapshotting so the snapshots stay stable across terminals and so
 * humans can diff them by eye.
 */

import { describe, it, expect, beforeAll } from "vitest";

// Pin the terminal width BEFORE the tokens module reads it.
beforeAll(() => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

async function load() {
  // Late-import so the COLS constant captures our 80-col override.
  return await import("../lib/setup/ui/index.js");
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("setup/ui atoms — Phase A", () => {
  it("Header renders breadcrumb + version + rule", async () => {
    const { Header } = await load();
    const out = Header(["gnosys", "setup", "models"], { version: "v5.9.3" });
    expect(strip(out)).toMatchSnapshot();
  });

  it("Header without version", async () => {
    const { Header } = await load();
    const out = Header(["gnosys", "setup"]);
    expect(strip(out)).toMatchSnapshot();
  });

  it("Title with subtitle", async () => {
    const { Title } = await load();
    const out = Title("Configure your LLM provider", "currently anthropic · last validated 2m ago");
    expect(strip(out)).toMatchSnapshot();
  });

  it("Title without subtitle", async () => {
    const { Title } = await load();
    const out = Title("Choose a model");
    expect(strip(out)).toMatchSnapshot();
  });

  it("Menu renders numbered items with meta + tag", async () => {
    const { Menu } = await load();
    const out = Menu([
      { n: "1", label: "anthropic (Claude)", meta: "$1.00 – 150.00 /M" },
      { n: "2", label: "openai  (GPT-5.4)", meta: "$0.20 – 180.00 /M" },
      { n: "3", label: "ollama  (local)", meta: "free", tag: "recommended" },
      { n: "4", label: "groq    (fast)", meta: "$0.05 – 0.79  /M" },
      { n: "5", label: "back", dim: true },
    ]);
    expect(strip(out)).toMatchSnapshot();
  });

  it("Menu with only labels (no meta, no tag)", async () => {
    const { Menu } = await load();
    const out = Menu([
      { n: "1", label: "first" },
      { n: "2", label: "second" },
    ]);
    expect(strip(out)).toMatchSnapshot();
  });

  it("Status — ok with meta", async () => {
    const { Status } = await load();
    expect(strip(Status("ok", "model validated", "847 ms"))).toMatchSnapshot();
  });

  it("Status — warn with meta", async () => {
    const { Status } = await load();
    expect(strip(Status("warn", "no anthropic key in env or keychain", "found: xai"))).toMatchSnapshot();
  });

  it("Status — fail", async () => {
    const { Status } = await load();
    expect(strip(Status("fail", "validation failed · 401 unauthorized"))).toMatchSnapshot();
  });

  it("Status — progress", async () => {
    const { Status } = await load();
    expect(strip(Status("progress", "fetching latest pricing…"))).toMatchSnapshot();
  });

  it("Diff renders before/after rows", async () => {
    const { Diff } = await load();
    const out = Diff([
      { label: "provider", from: "anthropic", to: "xai" },
      { label: "model", from: "claude-sonnet-4-6", to: "grok-4.20" },
      { label: "api key", from: "ANTHROPIC_API_KEY", to: "keychain (xai)" },
    ]);
    expect(strip(out)).toMatchSnapshot();
  });

  it("Panel renders rounded box with title and rows", async () => {
    const { Panel } = await load();
    const out = Panel("gnosys settings", [
      "  1   provider            anthropic",
      "  2   models              anthropic / claude-sonnet-4-6",
      "  3   task routing        all anthropic",
      "  4   ide integrations    6 configured",
      "  5   multi-machine sync  /Volumes/Dev/gnosys",
      "  6   dream mode          disabled",
      "  7   user preferences    0 stored",
    ]);
    expect(strip(out)).toMatchSnapshot();
  });

  it("Footer renders right-aligned hint", async () => {
    const { Footer } = await load();
    expect(strip(Footer("q · quit anytime · ^C exits cleanly"))).toMatchSnapshot();
  });

  it("stripAnsi removes ANSI escapes", async () => {
    const { stripAnsi } = await load();
    expect(stripAnsi("\x1b[1mbold\x1b[0m and \x1b[38;5;167mcolor\x1b[0m")).toBe("bold and color");
  });

  it("tokens — color() wraps text with reset", async () => {
    const { color, c } = await load();
    const out = color(c.accent, "x");
    expect(out.endsWith("\x1b[0m")).toBe(true);
    expect(out.includes("x")).toBe(true);
  });
});
