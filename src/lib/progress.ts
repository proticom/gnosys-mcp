/**
 * Progress — streaming per-entity progress for long-running CLI commands.
 *
 * Used together with `--verbose`. When verbose is off, every method is a
 * no-op so library code can call `progress.step(...)` unconditionally
 * without performance cost or output pollution.
 *
 * Output channel is stderr so it does not interleave with JSON / piped
 * stdout. TTY-only repaint for `tick`; plain lines for `header` and `step`.
 *
 * Typical wiring inside a long-running lib function:
 *
 *     onProgress?.({ kind: "header", text: "Pushing 42 memories" });
 *     for (const m of memories) {
 *       onProgress?.({ kind: "tick", text: `pushing ${m.id}` });
 *       ...
 *     }
 *     onProgress?.({ kind: "done", text: "Pushed 42" });
 */

export type ProgressEvent =
  | { kind: "header"; text: string }
  | { kind: "step"; text: string }
  | { kind: "tick"; text: string }
  | { kind: "done"; text?: string };

export interface Progress {
  emit(event: ProgressEvent): void;
  /** Convenience helpers — same as emit({kind, text}) */
  header(text: string): void;
  step(text: string): void;
  tick(text: string): void;
  done(text?: string): void;
  /** True if this is a no-op progress instance (verbose off / non-TTY). */
  readonly noop: boolean;
}

const NOOP: Progress = {
  emit: () => {},
  header: () => {},
  step: () => {},
  tick: () => {},
  done: () => {},
  noop: true,
};

function clearLine(): void {
  process.stderr.write("\r\x1b[2K");
}

function isTty(): boolean {
  return Boolean(process.stderr.isTTY);
}

/**
 * Create a Progress reporter.
 *
 * - `verbose: false` → no-op everywhere.
 * - `verbose: true` non-TTY → `header`/`step`/`done` print plain lines;
 *   `tick` is suppressed to keep log output clean.
 * - `verbose: true` TTY → full repaint for `tick`.
 */
export function createProgress(verbose: boolean): Progress {
  if (!verbose) return NOOP;

  const tty = isTty();
  let lastWasTick = false;

  return {
    noop: false,
    emit(event) {
      switch (event.kind) {
        case "header":
          if (lastWasTick && tty) clearLine();
          process.stderr.write(`\n=== ${event.text} ===\n`);
          lastWasTick = false;
          break;
        case "step":
          if (lastWasTick && tty) clearLine();
          process.stderr.write(`${event.text}\n`);
          lastWasTick = false;
          break;
        case "tick":
          if (tty) {
            process.stderr.write(`\r  ${event.text}`);
            lastWasTick = true;
          }
          break;
        case "done":
          if (lastWasTick && tty) clearLine();
          if (event.text) process.stderr.write(`${event.text}\n`);
          lastWasTick = false;
          break;
      }
    },
    header(text) {
      this.emit({ kind: "header", text });
    },
    step(text) {
      this.emit({ kind: "step", text });
    },
    tick(text) {
      this.emit({ kind: "tick", text });
    },
    done(text) {
      this.emit({ kind: "done", text });
    },
  };
}

/** Callback shape passed into lib functions that accept progress. */
export type ProgressCallback = (event: ProgressEvent) => void;
