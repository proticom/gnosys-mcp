/**
 * safeQuestion — a thin migration shim that gives every existing
 * `rl.question(...)` call site clean Ctrl+C handling without forcing
 * a rewrite to the full Prompt() atom.
 *
 * Behavior:
 *   - On normal input, returns the raw string (caller decides about trim).
 *   - On SIGINT (Ctrl+C), prints `cancelled · no changes written` in
 *     `text-dim`, closes the readline, exits 130.
 *
 * The SIGINT handler is installed lazily on the first call and remembered
 * via a module-level flag so the same readline can be questioned many
 * times without leaking listeners.
 *
 * v5.9.3 Phase B uses this everywhere the old helpers wrap `rl.question`.
 * New screens compose Prompt() from `index.js` instead.
 */

import type { Interface as ReadlineInterface } from "readline/promises";
import { c, color } from "./tokens.js";

export interface SafeQuestionOptions {
  cancelMessage?: string;
  skipExitOnCancel?: boolean;
}

/**
 * Track which readline interfaces we've already wired SIGINT cleanup
 * to. We use a WeakSet so a closed/GC'd interface drops out automatically.
 */
const sigintWired = new WeakSet<ReadlineInterface>();

function wireSigint(
  rl: ReadlineInterface,
  cancelMessage: string,
  skipExit: boolean,
): void {
  if (sigintWired.has(rl)) return;
  sigintWired.add(rl);

  const handler = (): void => {
    process.stdout.write(`\n ${color(c.textDim, cancelMessage)}\n`);
    try {
      rl.close();
    } catch {
      // already closed — fine
    }
    if (!skipExit) {
      process.exit(130);
    }
  };

  // `rl.on('SIGINT', …)` fires when the user hits Ctrl+C with readline
  // listening — Node's readline already emits SIGINT before bubbling to
  // process. This is the load-bearing wire.
  rl.on("SIGINT", handler);
}

export async function safeQuestion(
  rl: ReadlineInterface,
  prompt: string,
  opts: SafeQuestionOptions = {},
): Promise<string> {
  const message = opts.cancelMessage ?? "cancelled · no changes written";
  wireSigint(rl, message, opts.skipExitOnCancel ?? false);

  try {
    return await rl.question(prompt);
  } catch (err) {
    // Defensive: still catch AbortError for callers that pass their own
    // AbortSignal through (e.g. test harness).
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || /aborted|signal/i.test(err.message ?? ""));
    if (!isAbort) throw err;

    process.stdout.write(`\n ${color(c.textDim, message)}\n`);
    try {
      rl.close();
    } catch {
      // Already closed — fine.
    }
    if (!opts.skipExitOnCancel) {
      process.exit(130);
    }
    throw err;
  }
}
