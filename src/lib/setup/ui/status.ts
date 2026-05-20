/**
 * Status atom — one-liner with leading glyph + optional right-aligned meta.
 *
 * Kinds:
 *   ok       ✓ in ok color
 *   warn     ⚠ in warn color
 *   fail     ✗ in fail color
 *   progress ◌ in accent color (use Spinner for animated variants)
 */

import { c, color, glyph, width } from "./tokens.js";
import { stripAnsi } from "./header.js";

export type StatusKind = "ok" | "warn" | "fail" | "progress";

const KIND_TO_GLYPH: Record<StatusKind, string> = {
  ok: glyph.ok,
  warn: glyph.warn,
  fail: glyph.fail,
  progress: glyph.spin0,
};

const KIND_TO_COLOR: Record<StatusKind, string> = {
  ok: c.ok,
  warn: c.warn,
  fail: c.fail,
  progress: c.accent,
};

/**
 * Render a status line. Returns the formatted string (no trailing newline).
 *
 * @param kind  ok | warn | fail | progress
 * @param text  Body, in `text`.
 * @param meta  Optional right-aligned, in `text-dim`.
 */
export function Status(kind: StatusKind, text: string, meta?: string): string {
  const W = width();
  const indent = " ";
  const g = color(KIND_TO_COLOR[kind], KIND_TO_GLYPH[kind]);
  const body = color(c.text, text);
  const left = `${indent}${g} ${body}`;
  if (!meta) return left;
  const metaTxt = color(c.textDim, meta);
  const leftBare = stripAnsi(left);
  const metaBare = stripAnsi(metaTxt);
  const pad = " ".repeat(Math.max(1, W - 1 - leftBare.length - metaBare.length));
  return `${left}${pad}${metaTxt}`;
}

/** Convenience: print a single status line. */
export function printStatus(kind: StatusKind, text: string, meta?: string): void {
  process.stdout.write(`${Status(kind, text, meta)}\n`);
}
