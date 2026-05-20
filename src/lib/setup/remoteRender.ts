/**
 * Render helpers for `gnosys setup remote` (Screen 6).
 *
 * The wizard's flow is in `lib/remoteWizard.ts`; this module owns only
 * the pure render functions and the sync-mode picker payload so the
 * layout can be snapshot-tested without spinning up an interactive
 * readline.
 */
import { c, color, glyph } from "./ui/tokens.js";
import { Header } from "./ui/header.js";
import { Status } from "./ui/status.js";

/**
 * Sync mode picked in the hierarchical mode menu. Persisted to the
 * `remote_mode` meta key so other tooling can read it back.
 */
export type SyncMode = "read-write" | "pull-only" | "push-only";

/** Description for each mode — shown as the meta column in the picker. */
export const SYNC_MODE_LABELS: Record<SyncMode, string> = {
  "read-write": "this machine reads and writes",
  "pull-only": "read remote, never write",
  "push-only": "write to remote, never read locally",
};

/**
 * Render the validation summary as a bullet list of `✓`/`✗` rows.
 *
 * Replaces `showValidationSummary` in the wizard. Each check is one
 * Status() line — easier to scan than the old col-aligned text dump.
 */
export interface ValidationSummaryInput {
  pathExists: boolean;
  writable: boolean;
  sqliteCompatible: boolean;
  latencyMs: number | null;
  existing?: { found: boolean; memoryCount: number | null; lastModified: string | null };
  warnings: string[];
  errors: string[];
}

export function renderValidationSummary(v: ValidationSummaryInput): string {
  const lines: string[] = [];
  lines.push(Status(v.pathExists ? "ok" : "fail", "path exists"));
  lines.push(Status(v.writable ? "ok" : "fail", "writable"));
  lines.push(Status(v.sqliteCompatible ? "ok" : "fail", "sqlite compatible"));
  if (v.latencyMs !== null) {
    lines.push(Status("ok", "latency", `${v.latencyMs} ms`));
  }
  if (v.existing?.found) {
    const date = v.existing.lastModified ? v.existing.lastModified.split("T")[0] : "unknown";
    const count = v.existing.memoryCount ?? "?";
    lines.push(Status("ok", "found existing remote", `${count} memories · last write ${date}`));
  }
  for (const w of v.warnings) lines.push(Status("warn", w));
  for (const e of v.errors) lines.push(Status("fail", e));
  return lines.join("\n");
}

/**
 * Render the leading Header + current-status line for the remote wizard.
 * Returns a multi-line string the wizard can print as-is.
 */
export function renderRemoteIntro(
  localActive: number,
  localArchived: number,
  currentRemote: string | null,
): string {
  const lines: string[] = [];
  lines.push(Header(["gnosys", "setup", "remote"]));
  lines.push("");
  lines.push(` ${color(c.text, "Multi-machine sync")}`);
  lines.push(` ${color(c.textDim, "share your memory store across machines via a path on a NAS, iCloud, Dropbox, etc.")}`);
  lines.push("");
  const remoteTxt = currentRemote ?? "not configured";
  lines.push(`   ${color(c.textDim, "local DB")}    ${color(c.text, `~/.gnosys/gnosys.db (${localActive} active, ${localArchived} archived)`)}`);
  lines.push(`   ${color(c.textDim, "current")}     ${color(c.text, remoteTxt)}`);
  return lines.join("\n");
}

/**
 * Render the final Diff block summarizing what changed at the end of
 * the wizard run.
 */
export interface RemoteDiffInput {
  previousRemote: string | null;
  newRemote: string;
  mode: SyncMode;
}

export function renderRemoteDiff(d: RemoteDiffInput): string {
  const lines: string[] = [];
  const indent = "   ";
  const arrow = color(c.textGhost, glyph.arrow);
  const fromR = color(c.textMid, (d.previousRemote ?? "not configured").padEnd(20));
  const labelR = color(c.textDim, "remote".padEnd(8));
  lines.push(`${indent}${labelR}   ${fromR}   ${arrow}   ${color(c.accentHi, d.newRemote)}`);
  const labelM = color(c.textDim, "mode".padEnd(8));
  const fromM = color(c.textMid, "—".padEnd(20));
  lines.push(`${indent}${labelM}   ${fromM}   ${arrow}   ${color(c.accentHi, d.mode)}`);
  return lines.join("\n");
}
