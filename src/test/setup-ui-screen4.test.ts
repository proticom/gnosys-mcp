/**
 * Screen 4 — `gnosys setup routing` cost-tier table + diff renderers.
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
  return await import("../lib/setup/routingRender.js");
}

describe("Screen 4 — routing render", () => {
  it("classifyCost: ollama and lmstudio are always free", async () => {
    const { classifyCost } = await load();
    expect(classifyCost("ollama", "llama3.2")).toBe("free");
    expect(classifyCost("lmstudio", "default")).toBe("free");
  });

  it("classifyCost: anthropic sonnet is mid-tier", async () => {
    const { classifyCost } = await load();
    // sonnet avg = (3 + 15) / 2 = 9 → $$$ (over 5.0)
    expect(classifyCost("anthropic", "claude-sonnet-4-6")).toBe("$$$");
  });

  it("classifyCost: groq small is cheap", async () => {
    const { classifyCost } = await load();
    // (.05 + .08) / 2 = 0.065 → $
    expect(classifyCost("groq", "llama-3.1-8b-instant")).toBe("$");
  });

  it("classifyCost: unknown model defaults to $$ (conservative)", async () => {
    const { classifyCost } = await load();
    expect(classifyCost("anthropic", "made-up-model")).toBe("$$");
  });

  it("renders the routing table with the cost column", async () => {
    const { renderRoutingTable } = await load();
    const rows = [
      { task: "synthesis", uses: "anthropic / claude-sonnet-4-6", cost: "$$$" as const },
      { task: "structuring", uses: "anthropic / claude-sonnet-4-6", cost: "$$$" as const },
      { task: "dream", uses: "ollama / llama3.2", cost: "free" as const },
    ];
    const out = strip(renderRoutingTable(rows));
    expect(out).toContain("task");
    expect(out).toContain("uses");
    expect(out).toContain("cost");
    expect(out).toContain("synthesis");
    expect(out).toContain("free");
    expect(out.split("\n")).toMatchSnapshot();
  });

  it("renders the routing table with ▶ markers on changed rows", async () => {
    const { renderRoutingTable } = await load();
    const rows = [
      { task: "synthesis", uses: "groq / llama-3.1-70b", cost: "$" as const, changed: true },
      { task: "structuring", uses: "anthropic / claude-sonnet-4-6", cost: "$$$" as const, changed: false },
    ];
    const out = strip(renderRoutingTable(rows));
    // The first task should be flagged with ▶
    const lines = out.split("\n");
    const synthesisLine = lines.find((l) => l.includes("synthesis"));
    expect(synthesisLine).toContain("▶");
    const structLine = lines.find((l) => l.includes("structuring"));
    expect(structLine).not.toContain("▶");
  });

  it("renders the diff block with → for changes and (unchanged) otherwise", async () => {
    const { renderRoutingDiff } = await load();
    const entries = [
      { task: "synthesis", from: "anthropic / claude-sonnet-4-6", to: "groq / llama-3.1-70b" },
      { task: "dream", from: "ollama / llama3.2", to: null },
    ];
    const out = strip(renderRoutingDiff(entries));
    expect(out).toContain("synthesis");
    expect(out).toContain("→");
    expect(out).toContain("groq / llama-3.1-70b");
    expect(out).toContain("dream");
    expect(out).toContain("(unchanged)");
    expect(out.split("\n")).toMatchSnapshot();
  });

  it("renderRoutingDiff returns empty string when no entries", async () => {
    const { renderRoutingDiff } = await load();
    expect(renderRoutingDiff([])).toBe("");
  });
});
