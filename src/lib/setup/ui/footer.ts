/**
 * Footer atom — single right-aligned dim hint at the bottom of long lists,
 * shown immediately before the Prompt.
 */

import { c, color, width } from "./tokens.js";
import { stripAnsi } from "./header.js";

/**
 * Render a right-aligned `text-dim` hint line.
 */
export function Footer(hint: string): string {
  const W = width();
  const txt = color(c.textDim, hint);
  const bare = stripAnsi(txt);
  const pad = " ".repeat(Math.max(1, W - 1 - bare.length));
  return `${pad}${txt}`;
}

/** Convenience: print footer + newline. */
export function printFooter(hint: string): void {
  process.stdout.write(`${Footer(hint)}\n`);
}
