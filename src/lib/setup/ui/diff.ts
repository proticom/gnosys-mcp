/**
 * Diff atom — `label    from  →  to` table shown after any mutation.
 *
 * Replaces the silent "Configuration saved" messages with a visible
 * before/after summary. `to` is rendered in `accent-hi` to draw the eye.
 */

import { c, color, glyph } from "./tokens.js";

export interface DiffRow {
  label: string;
  from: string;
  to: string;
}

/**
 * Render a diff block. Columns are auto-sized by widest entry in each
 * column. Caller follows with the success line / next status.
 */
export function Diff(rows: DiffRow[]): string {
  if (rows.length === 0) return "";
  const labelW = Math.max(...rows.map((r) => r.label.length));
  const fromW = Math.max(...rows.map((r) => r.from.length));
  const indent = "   ";
  const arrow = color(c.textGhost, glyph.arrow);
  const lines: string[] = [];
  for (const r of rows) {
    const label = color(c.textDim, r.label.padEnd(labelW));
    const from = color(c.textMid, r.from.padEnd(fromW));
    const to = color(c.accentHi, r.to);
    lines.push(`${indent}${label}   ${from}   ${arrow}   ${to}`);
  }
  return lines.join("\n");
}

/** Convenience: print diff + trailing blank line. */
export function printDiff(rows: DiffRow[]): void {
  if (rows.length === 0) return;
  process.stdout.write(`${Diff(rows)}\n\n`);
}
