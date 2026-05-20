/**
 * Menu atom — the single numbered-menu format the redesign uses.
 *
 * 3-col number gutter, lowercase labels by convention, right-aligned
 * meta column, optional `◂ tag` (recommended | current | detected) to
 * the right of meta.
 */

import { c, color, glyph, width } from "./tokens.js";
import { stripAnsi } from "./header.js";

export interface MenuItem {
  /** The shortcut digit/letter (`1`, `2`, `b`, `q`, …). */
  n: string;
  /** Primary label text. */
  label: string;
  /** Optional right-side metadata (price, status, etc.). */
  meta?: string;
  /** Optional `◂ recommended` / `◂ current` / `◂ detected` style tag. */
  tag?: string;
  /** Render the whole row in `text-dim` (used for skip / back). */
  dim?: boolean;
}

/**
 * Render a numbered menu as a single string (no trailing newline).
 * Caller follows with one blank line then a Prompt/Footer.
 */
export function Menu(items: MenuItem[]): string {
  const W = width();
  // Column layout:
  //   col 1: " " indent (content lives at col 2 per the spec)
  //   col 2-4: 3-char gutter for number, right-aligned
  //   col 5: " "
  //   col 6+: label
  //   meta is right-aligned within W-2
  //   tag (◂ ...) follows meta, right-aligned at the very right
  const indent = "    "; // menu items at col 4 — 4-space indent (1 base + 3)

  const lines: string[] = [];
  for (const it of items) {
    // Numbers are always text-dim per design §3 (numbered-menu spec).
    const labelColor = it.dim ? c.textDim : c.text;
    const metaColor = it.dim ? c.textDim : c.textMid;
    const tagColor = c.accentHi;

    const num = color(c.textDim, it.n.padStart(2, " "));
    const label = color(labelColor, it.label);
    const meta = it.meta ? color(metaColor, it.meta) : "";
    const tag = it.tag ? color(tagColor, `${glyph.tag} ${it.tag}`) : "";

    // Build the inner content then right-pad meta + tag.
    const leftSide = `${indent}${num}  ${label}`;
    const leftBare = stripAnsi(leftSide);

    // Reserve room: leftBare | gap | meta | gap | tag, ending at col W-1.
    const tagBare = it.tag ? `${glyph.tag} ${it.tag}` : "";
    const metaBare = it.meta ?? "";
    const tagWidth = tagBare.length;
    const metaWidth = metaBare.length;

    // tag occupies the rightmost slot if present; meta column ends before
    // the tag with a one-space gap. If no tag, meta ends at col W-1.
    const rightEnd = W - 1;
    let line: string;
    if (it.tag && it.meta) {
      const tagStart = rightEnd - tagWidth;
      const metaEnd = tagStart - 1; // one space between meta and tag
      const metaStart = metaEnd - metaWidth;
      const gap1 = " ".repeat(Math.max(1, metaStart - leftBare.length));
      const gap2 = " ";
      line = `${leftSide}${gap1}${meta}${gap2}${tag}`;
    } else if (it.tag) {
      const tagStart = rightEnd - tagWidth;
      const gap = " ".repeat(Math.max(1, tagStart - leftBare.length));
      line = `${leftSide}${gap}${tag}`;
    } else if (it.meta) {
      const metaStart = rightEnd - metaWidth;
      const gap = " ".repeat(Math.max(1, metaStart - leftBare.length));
      line = `${leftSide}${gap}${meta}`;
    } else {
      line = leftSide;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Convenience: print menu + trailing blank line. */
export function printMenu(items: MenuItem[]): void {
  process.stdout.write(`${Menu(items)}\n\n`);
}
