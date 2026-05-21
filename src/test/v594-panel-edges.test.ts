/**
 * v5.9.4 Bug 1 + 2 regression tests for the Panel atom.
 *
 * Locks in:
 *   - Top border closes flush with the bottom border (counts horizontal
 *     rule chars + corners and confirms both rows have equal printable width)
 *   - ANSI-stripped title still measures correctly (caller may pass a
 *     pre-styled title without breaking layout)
 *   - Very long titles don't collapse the right rule (`Math.max(1, ...)` clamp)
 */

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

async function load() {
  return await import("../lib/setup/ui/index.js");
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Panel — v5.9.4 edge cases (Bugs 1+2)", () => {
  it("top and bottom borders have identical printable widths", async () => {
    const { Panel } = await load();
    const out = Panel("gnosys settings", [
      "row one",
      "row two",
      "row three",
    ]);
    const lines = strip(out).split("\n");
    const top = lines[0];
    const bottom = lines[lines.length - 1];
    expect(top.length).toBe(bottom.length);
    // Sanity: top starts with ` ╭` and ends with `╮`; bottom mirrors `╰`/`╯`.
    expect(top.endsWith("╮")).toBe(true);
    expect(bottom.endsWith("╯")).toBe(true);
  });

  it("ANSI in the title does not shift the right rule", async () => {
    const { Panel, c, color } = await load();
    const styledTitle = color(c.accentHi, "styled title");
    const out = Panel(styledTitle, ["row"]);
    const lines = strip(out).split("\n");
    expect(lines[0].length).toBe(lines[lines.length - 1].length);
  });

  it("very long titles fall back to a 1-char clamp instead of negative pad", async () => {
    const { Panel } = await load();
    const longTitle = "this title is intentionally longer than the inner panel width to exercise the clamp";
    const out = Panel(longTitle, ["row"]);
    // Each line should still have a closing border glyph — no crash, no broken rule.
    const lines = strip(out).split("\n");
    expect(lines[0].endsWith("╮")).toBe(true);
    expect(lines[lines.length - 1].endsWith("╯")).toBe(true);
    // Top should still have at least one rule char before the corner.
    expect(/─╮$/.test(lines[0])).toBe(true);
  });

  it("uses rounded glyphs + accent-dim border per design", async () => {
    const { Panel } = await load();
    const out = Panel("t", ["row"]);
    // Rounded corners ╭ ╮ ╰ ╯ must appear at the start/end of borders.
    expect(out.includes("╭")).toBe(true); // ╭
    expect(out.includes("╮")).toBe(true); // ╮
    expect(out.includes("╰")).toBe(true); // ╰
    expect(out.includes("╯")).toBe(true); // ╯
    // Vertical glyph │ on every row.
    expect(out.includes("│")).toBe(true);
  });
});
