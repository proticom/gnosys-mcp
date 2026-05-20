/**
 * Spinner atom — animated `◌ ◐ ◑ ◒ ◓` for any operation > 200 ms.
 *
 * Same line is rewritten in place via `\r` (carriage return). On `ok` /
 * `fail` / `update`, the spinner stops cleanly and replaces the line with
 * a final Status-style line. No newlines are emitted until resolution.
 */

import { c, color, glyph } from "./tokens.js";
import { Status, type StatusKind } from "./status.js";

export interface SpinnerHandle {
  /** Replace the spinner with a `✓ text · meta` line and stop. */
  ok(text: string, meta?: string): void;
  /** Replace the spinner with a `✗ text · meta` line and stop. */
  fail(text: string, meta?: string): void;
  /** Update the in-progress label (spinner keeps animating). */
  update(label: string): void;
  /** Stop without printing a final line (for callers that handle output). */
  stop(): void;
}

const FRAMES = [glyph.spin0, glyph.spin1, glyph.spin2, glyph.spin3, glyph.spin4];
const FRAME_MS = 125; // ~8 fps

/**
 * Start an animated spinner. Returns a handle. The spinner immediately
 * writes its first frame. Caller MUST eventually call one of `ok`/`fail`/
 * `stop` to release the line.
 *
 * When stdout isn't a TTY (CI, test capture), the spinner falls back to a
 * single static `◌ label` line and the `ok/fail` calls print final lines
 * directly — no `\r` redraw.
 */
export function Spinner(label: string): SpinnerHandle {
  let currentLabel = label;
  const isTTY = process.stdout.isTTY;
  let frame = 0;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  function draw(): void {
    if (stopped) return;
    if (!isTTY) {
      // Non-TTY: print one static line only, do NOT animate.
      return;
    }
    const g = color(c.accent, FRAMES[frame % FRAMES.length]);
    const txt = color(c.text, currentLabel);
    process.stdout.write(`\r ${g} ${txt}`);
  }

  function clearLine(): void {
    if (isTTY) {
      // Move to start of line, clear to end.
      process.stdout.write("\r\x1b[2K");
    }
  }

  function final(kind: StatusKind, text: string, meta?: string): void {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    clearLine();
    process.stdout.write(`${Status(kind, text, meta)}\n`);
  }

  // First frame (or static line for non-TTY).
  if (isTTY) {
    draw();
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      draw();
    }, FRAME_MS);
    // Unref so the timer never blocks process exit on its own.
    timer.unref?.();
  } else {
    process.stdout.write(`${Status("progress", currentLabel)}\n`);
  }

  return {
    ok(text: string, meta?: string): void {
      final("ok", text, meta);
    },
    fail(text: string, meta?: string): void {
      final("fail", text, meta);
    },
    update(nextLabel: string): void {
      currentLabel = nextLabel;
      draw();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      clearLine();
    },
  };
}
