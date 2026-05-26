/**
 * Heartbeat — always-on liveness indicator for long-running CLI ops.
 *
 * Behaviour:
 * - TTY-only. In pipes, CI logs, or non-interactive shells it stays silent
 *   so log output is not polluted with control codes.
 * - 500ms grace period before showing anything. Fast operations leave no trace.
 * - Animated spinner + elapsed seconds, repainted in place with `\r`.
 * - Safe to start/stop repeatedly. `stop()` clears the line completely.
 *
 * Wire into commands that can block on I/O:
 *   status / sync / reindex / bootstrap / import / migrate-db / dream / doctor.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
const GRACE_MS = 500;

interface Heartbeat {
  /** Update the message shown next to the spinner. Safe to call repeatedly. */
  setMessage(msg: string): void;
  /** Stop the spinner and clear the line. */
  stop(): void;
}

interface State {
  message: string;
  stopped: boolean;
  paintTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  frameIdx: number;
  started: number;
  visible: boolean;
}

function isTty(): boolean {
  return Boolean(process.stderr.isTTY);
}

function clearLine(): void {
  process.stderr.write("\r\x1b[2K");
}

function paint(state: State): void {
  if (state.stopped) return;
  const elapsed = ((Date.now() - state.started) / 1000).toFixed(1);
  const frame = FRAMES[state.frameIdx % FRAMES.length];
  state.frameIdx++;
  process.stderr.write(`\r${frame} ${state.message} (${elapsed}s)`);
}

/**
 * Start a heartbeat. Returns a handle with `setMessage` and `stop`.
 *
 * In non-TTY contexts (pipes, CI), returns a no-op handle.
 */
function startHeartbeat(message: string): Heartbeat {
  if (!isTty()) {
    return {
      setMessage: () => {},
      stop: () => {},
    };
  }

  const state: State = {
    message,
    stopped: false,
    paintTimer: null,
    graceTimer: null,
    frameIdx: 0,
    started: Date.now(),
    visible: false,
  };

  state.graceTimer = setTimeout(() => {
    if (state.stopped) return;
    state.visible = true;
    paint(state);
    state.paintTimer = setInterval(() => paint(state), FRAME_MS);
  }, GRACE_MS);

  return {
    setMessage(msg: string) {
      state.message = msg;
      if (state.visible && !state.stopped) paint(state);
    },
    stop() {
      if (state.stopped) return;
      state.stopped = true;
      if (state.graceTimer) clearTimeout(state.graceTimer);
      if (state.paintTimer) clearInterval(state.paintTimer);
      if (state.visible) clearLine();
    },
  };
}

/**
 * Run an async function with a heartbeat wrapped around it. The heartbeat
 * is always stopped, even on error.
 */
export async function withHeartbeat<T>(
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  const hb = startHeartbeat(message);
  try {
    return await fn();
  } finally {
    hb.stop();
  }
}
