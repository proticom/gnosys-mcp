/**
 * Title atom — screen-level heading + optional subtitle.
 */

import { c, color } from "./tokens.js";

/**
 * Render a title + optional subtitle. Caller follows with the standard
 * blank line via normal flow.
 *
 * @param title  Bold, `text-hi`.
 * @param sub    Optional, `text-mid`, rendered on the next line.
 */
export function Title(title: string, sub?: string): string {
  const indent = " ";
  const line1 = `${indent}${color(c.textHi, title)}`;
  if (!sub) return line1;
  const line2 = `${indent}${color(c.textMid, sub)}`;
  return `${line1}\n${line2}`;
}

/** Convenience: print title + trailing blank line to stdout. */
export function printTitle(title: string, sub?: string): void {
  process.stdout.write(`${Title(title, sub)}\n\n`);
}
