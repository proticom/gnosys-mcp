/**
 * Screen 3 — `gnosys setup models` diff-row builder.
 *
 * The bulk of Screen 3's rendering reuses atoms already covered by
 * `setup-ui-atoms.test.ts` (Header / Title / Spinner / Diff / Status).
 * This file pins the small diff-row payload helper that decides which
 * rows show up in the pre-save Diff() block.
 */

import { describe, it, expect } from "vitest";

async function load() {
  return await import("../lib/setup/modelsRender.js");
}

describe("Screen 3 — models diff rows", () => {
  it("renders both rows when nothing has changed (cold start)", async () => {
    const { buildModelsDiffRows } = await load();
    const rows = buildModelsDiffRows(undefined, undefined, "anthropic", "claude-sonnet-4-6");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ label: "provider", from: "(unset)", to: "anthropic" });
    expect(rows[1]).toEqual({ label: "model", from: "(unset)", to: "claude-sonnet-4-6" });
  });

  it("returns a single row when only the model changed", async () => {
    const { buildModelsDiffRows } = await load();
    const rows = buildModelsDiffRows("anthropic", "claude-sonnet-4-6", "anthropic", "claude-opus-4-6");
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("model");
    expect(rows[0].from).toBe("claude-sonnet-4-6");
    expect(rows[0].to).toBe("claude-opus-4-6");
  });

  it("returns both rows when the user switched providers", async () => {
    const { buildModelsDiffRows } = await load();
    const rows = buildModelsDiffRows("anthropic", "claude-sonnet-4-6", "xai", "grok-4.20");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual(["provider", "model"]);
    expect(rows[0].from).toBe("anthropic");
    expect(rows[0].to).toBe("xai");
  });

  it("emits both rows as a fallback when nothing differs but config is established", async () => {
    const { buildModelsDiffRows } = await load();
    const rows = buildModelsDiffRows("anthropic", "claude-sonnet-4-6", "anthropic", "claude-sonnet-4-6");
    // Both unchanged — still show the rows so the user has confirmation.
    expect(rows).toHaveLength(2);
    expect(rows[0].from).toBe("anthropic");
    expect(rows[0].to).toBe("anthropic");
  });
});
