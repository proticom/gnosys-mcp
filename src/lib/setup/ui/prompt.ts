/**
 * Prompt atom — single helper that wraps every readline question call.
 *
 * Catches `AbortError` from readline's signal/SIGINT path, prints a clean
 * cancellation message in `text-dim`, closes the readline, and exits with
 * code 130 (standard SIGINT exit). This is the *only* place SIGINT cleanup
 * should live — every other site routes through here.
 */

import type { Interface as ReadlineInterface } from "readline/promises";
import { c, color, glyph, width } from "./tokens.js";
import { stripAnsi } from "./header.js";
import { safeQuestion } from "./safePrompt.js";

export interface PromptOptions {
  /** Right-aligned dim hint (`1–8 · pick    q · quit`). */
  hint?: string;
  /** Lead-in text shown after the prompt glyph (`press enter to begin`). */
  lead?: string;
  /** What to print on cancel. Default: `cancelled · no changes written`. */
  cancelMessage?: string;
  /** Skip the actual `process.exit(130)`. Used by some integration tests. */
  skipExitOnCancel?: boolean;
}

/**
 * Render the prompt line and await user input. On `AbortError`, prints the
 * cancellation message and exits 130 (unless `skipExitOnCancel`).
 *
 * @returns The user's input, trimmed. Returns the empty string on Enter.
 */
export async function Prompt(
  rl: ReadlineInterface,
  opts: PromptOptions = {},
): Promise<string> {
  const W = width();
  const indent = " ";
  const glyphPart = color(c.accent, glyph.prompt);
  const lead = opts.lead ? ` ${color(c.text, opts.lead)}` : "";
  const head = `${indent}${glyphPart}${lead} `;

  // If a hint is present, print it right-aligned ABOVE the prompt line.
  // This matches the design's "hint on the line above the cursor".
  if (opts.hint) {
    const hint = color(c.textDim, opts.hint);
    const hintBare = stripAnsi(hint);
    const pad = " ".repeat(Math.max(1, W - 1 - hintBare.length));
    process.stdout.write(`${pad}${hint}\n`);
  }

  const raw = await safeQuestion(rl, head, {
    cancelMessage: opts.cancelMessage,
    skipExitOnCancel: opts.skipExitOnCancel,
  });
  return raw.trim();
}
