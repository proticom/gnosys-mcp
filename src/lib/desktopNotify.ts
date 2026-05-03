/**
 * Cross-platform desktop notification helper.
 *
 * Used by dream mode (and potentially other future surfaces) to alert the
 * user when something requires attention without requiring them to be
 * actively watching a terminal. Quietly degrades to a stderr fallback when
 * desktop notifications aren't available.
 *
 * Platform support:
 *   - macOS: `osascript -e 'display notification ...'`
 *   - Linux: `notify-send` (from libnotify; commonly preinstalled)
 *   - Windows / other: stderr fallback only
 *
 * All commands are spawned with timeouts so a hung notification daemon
 * can't block the calling process.
 */

import { execFile } from "child_process";

export interface NotifyOptions {
  /** Notification title (default: "Gnosys") */
  title?: string;
  /** Optional subtitle (macOS only — ignored on other platforms) */
  subtitle?: string;
  /** Optional sound name (macOS only — e.g. "Submarine"; null for silent) */
  sound?: string | null;
}

/**
 * Send a desktop notification. Always resolves — never throws. Returns
 * true if the notification was dispatched to the system, false if it
 * fell back to stderr.
 */
export function notifyDesktop(message: string, opts: NotifyOptions = {}): Promise<boolean> {
  const title = opts.title ?? "Gnosys";
  return new Promise((resolve) => {
    if (process.platform === "darwin") {
      sendMacNotification(title, message, opts).then(resolve);
    } else if (process.platform === "linux") {
      sendLinuxNotification(title, message).then(resolve);
    } else {
      stderrFallback(title, message);
      resolve(false);
    }
  });
}

function sendMacNotification(title: string, message: string, opts: NotifyOptions): Promise<boolean> {
  const escapedTitle = escapeAppleScript(title);
  const escapedMessage = escapeAppleScript(message);
  const subtitleClause = opts.subtitle
    ? ` subtitle "${escapeAppleScript(opts.subtitle)}"`
    : "";
  const soundClause =
    opts.sound === null
      ? ""
      : ` sound name "${escapeAppleScript(opts.sound ?? "Submarine")}"`;
  const script = `display notification "${escapedMessage}" with title "${escapedTitle}"${subtitleClause}${soundClause}`;

  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 3000 }, (err) => {
      if (err) {
        stderrFallback(title, message);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

function sendLinuxNotification(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("notify-send", [title, message], { timeout: 3000 }, (err) => {
      if (err) {
        stderrFallback(title, message);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

function stderrFallback(title: string, message: string): void {
  process.stderr.write(`[${title}] ${message}\n`);
}

/** Escape a string for safe interpolation into an AppleScript double-quoted string. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
