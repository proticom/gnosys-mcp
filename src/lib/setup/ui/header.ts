/**
 * Header atom — breadcrumb + thin rule on every redesigned screen.
 *
 * Renders two lines: breadcrumb `⬢ gnosys ▸ setup ▸ models` (left) with a
 * right-aligned version label, followed by a full-width `─` rule. Caller
 * is responsible for following with one blank line via the normal flow.
 */

import { c, color, glyph, width, RESET } from "./tokens.js";

export interface HeaderOptions {
  /** Version label, right-aligned. Pass `undefined` to omit. */
  version?: string;
}

/**
 * Render a header for the given breadcrumb segments. Returns the full
 * 2-line string (no trailing newline).
 *
 * @param crumbs  Path segments. First should always be `gnosys`.
 * @param opts    Optional version label.
 */
export function Header(crumbs: string[], opts: HeaderOptions = {}): string {
  const W = width();
  const brand = color(c.accent, glyph.brand);
  const head = `${brand} ${color(c.textHi, crumbs[0] ?? "gnosys")}`;
  const tail = crumbs
    .slice(1)
    .map((s) => `${color(c.textDim, glyph.sep)} ${color(c.textDim, s)}`)
    .join(" ");
  const left = tail ? `${head} ${tail}` : head;

  // Pad the right-aligned version. We measure printable width without ANSI.
  const versionTxt = opts.version ? color(c.textDim, opts.version) : "";
  const leftBare = stripAnsi(left);
  const versionBare = opts.version ?? "";
  // 1-col indent on the left ("content at col 2"), plus one space before the
  // version, plus the version. Pad with spaces to push version to col W-1.
  const indent = " ";
  const usable = W - indent.length - leftBare.length - versionBare.length;
  const pad = " ".repeat(Math.max(1, usable));
  const line1 = `${indent}${left}${pad}${versionTxt}`;

  // Rule line — full width with single space indent for alignment.
  const ruleLen = Math.max(1, W - indent.length);
  const line2 = `${indent}${color(c.textGhost, glyph.ruleLight.repeat(ruleLen))}`;

  return `${line1}\n${line2}`;
}

/** Strip ANSI escapes so we can measure printable width. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Public re-export for callers/tests that need printable measurement. */
export { stripAnsi };

/** Convenience: print header + trailing blank line to stdout. */
export function printHeader(crumbs: string[], opts: HeaderOptions = {}): void {
  process.stdout.write(`${Header(crumbs, opts)}\n\n`);
}

// Unused export to keep tree-shakers from yelling.
void RESET;
