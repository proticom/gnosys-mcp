/**
 * Screen 7 — `gnosys setup dream` three grouped sub-screens.
 *
 * Snapshot tests for the pure helpers in dreamRender.ts. The full
 * three-step interactive flow lives in setup.ts and is harness-tested
 * via the larger setup integration tests; here we only pin the layout
 * payloads.
 */

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

async function load() {
  return await import("../lib/setup/dreamRender.js");
}

describe("Screen 7 — dream render", () => {
  it("builds the diff rows for a first-time enable", async () => {
    const { buildDreamDiffRows } = await load();
    const rows = buildDreamDiffRows(null, {
      provider: "ollama",
      model: "llama3.2",
      machine: "EdsMacStudio",
      idleMinutes: 10,
      maxRuntimeMinutes: 30,
      selfCritique: true,
      generateSummaries: true,
      discoverRelationships: true,
    });
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.label)).toEqual([
      "provider",
      "machine",
      "idle threshold",
      "max runtime",
    ]);
    // First-time enable — all `from` columns should be `—`
    expect(rows[0].from).toBe("—");
    expect(rows[0].to).toBe("ollama / llama3.2");
    expect(rows[2].to).toBe("10 min");
    expect(rows).toMatchSnapshot();
  });

  it("builds the diff rows showing what changed on a re-run", async () => {
    const { buildDreamDiffRows } = await load();
    const rows = buildDreamDiffRows(
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        machine: "old-machine",
        idleMinutes: 5,
        maxRuntimeMinutes: 15,
      },
      {
        provider: "ollama",
        model: "llama3.2",
        machine: "EdsMacStudio",
        idleMinutes: 10,
        maxRuntimeMinutes: 30,
        selfCritique: true,
        generateSummaries: true,
        discoverRelationships: true,
      },
    );
    expect(rows[0].from).toBe("anthropic / claude-haiku-4-5");
    expect(rows[1].from).toBe("old-machine");
    expect(rows[2].from).toBe("5 min");
    expect(rows[3].from).toBe("15 min");
  });

  it("renders the thresholds block with default values inside [N ] fields", async () => {
    const { renderThresholdsBlock } = await load();
    const lines = renderThresholdsBlock(10, 30, 10, {
      selfCritique: true,
      generateSummaries: true,
      discoverRelationships: true,
    });
    expect(lines.some((l) => l.includes("[10 ]"))).toBe(true);
    expect(lines.some((l) => l.includes("[30 ]"))).toBe(true);
    expect(lines.some((l) => l.includes("self-critique"))).toBe(true);
    expect(lines.some((l) => l.includes("✓"))).toBe(true);
    expect(lines).toMatchSnapshot();
  });

  it("renders sub-tasks with ○ when disabled", async () => {
    const { renderThresholdsBlock } = await load();
    const lines = renderThresholdsBlock(10, 30, 10, {
      selfCritique: false,
      generateSummaries: true,
      discoverRelationships: false,
    });
    const subTaskLines = lines.filter((l) => l.includes("self-critique") || l.includes("discover"));
    for (const line of subTaskLines) {
      expect(line).toContain("○");
    }
  });
});
