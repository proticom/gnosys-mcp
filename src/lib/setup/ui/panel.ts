/**
 * Panel atom — rounded `╭─╮ │ ╰─╯` box in `accent-dim`.
 *
 * Used ONLY for summary views (settings overview, completion screen).
 * Flow screens use Header + Title + content + Prompt — no box. The
 * design handoff is strict about this.
 */

import { c, color, glyph, width } from "./tokens.js";
import { stripAnsi } from "./header.js";

export interface PanelOptions {
  /** Right-side glyph on a row (e.g. `✓` to mark "edited this session"). */
  trailing?: Record<number, string>;
}

/**
 * Render a panel. Each row is a string (already formatted/colored). The
 * panel wraps each row in `│ … │` with `accent-dim` border. The title
 * sits in the top border: `╭─ title ────╮`.
 *
 * Width is fixed to the lesser of W or 68 cols of inner content (matches
 * the spec mockup) so summary panels never spill on wider terminals.
 */
export function Panel(title: string, rows: string[], opts: PanelOptions = {}): string {
  const W = width();
  const indent = " ";
  // Inner content width: target 66 chars inner (between `│  ` and `  │`),
  // clamp by terminal width.
  const innerW = Math.min(66, Math.max(40, W - 4));
  const border = c.accentDim;

  // Top border: `╭─ title ──────╮` — must match the bottom border's total
  // visible width of `innerW + 4` (corners + innerW+2 rule chars). The
  // title segment `╭─ <title> ` already costs 4 + title chars, leaving
  // `innerW - 1 - title` rule chars before the closing `╮` corner.
  //
  // v5.9.4 Bug 1 — pre-strip ANSI from the caller-supplied title so
  // bolded / coloured titles still measure correctly; clamp `topPadLen`
  // with `Math.max(1, ...)` so narrow widths never collapse the rule.
  const titleStyled = color(c.textHi, title);
  const titleBareLen = stripAnsi(title).length;
  const topHead = `${color(border, `${glyph.boxTL}${glyph.boxH} `)}${titleStyled} `;
  const topPadLen = Math.max(1, innerW - 1 - titleBareLen);
  const top = `${indent}${topHead}${color(border, `${glyph.boxH.repeat(topPadLen)}${glyph.boxTR}`)}`;

  // Each row: `│  <content>  │` — pad content to innerW.
  const left = color(border, `${glyph.boxV} `);
  const right = color(border, ` ${glyph.boxV}`);
  const middle: string[] = [];
  rows.forEach((rowStyled, idx) => {
    const bare = stripAnsi(rowStyled);
    const trail = opts.trailing?.[idx] ?? "";
    const trailBare = stripAnsi(trail);
    // Reserve room for the optional trailing glyph (e.g. ✓), right-aligned.
    const usable = innerW - bare.length - (trailBare ? trailBare.length + 1 : 0);
    const padContent = " ".repeat(Math.max(0, usable));
    const trailingPart = trail ? ` ${trail}` : "";
    middle.push(`${indent}${left}${rowStyled}${padContent}${trailingPart}${right}`);
  });

  // Bottom border: `╰──────────────╯`
  const bottom = `${indent}${color(border, `${glyph.boxBL}${glyph.boxH.repeat(innerW + 2)}${glyph.boxBR}`)}`;

  return [top, ...middle, bottom].join("\n");
}

/** Convenience: print panel + trailing blank line. */
export function printPanel(title: string, rows: string[], opts: PanelOptions = {}): void {
  process.stdout.write(`${Panel(title, rows, opts)}\n\n`);
}
