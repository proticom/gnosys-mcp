/**
 * Render helpers for `gnosys setup sync-projects` output (Screen 10).
 *
 * These pure render functions turn the sync result data into the new
 * hierarchical layout from the v5.9.3 design handoff §4 Screen 10:
 *
 *   - Header at the top with breadcrumb + version
 *   - Inline summary spinner line
 *   - Hierarchical sections: upgraded, skipped, machines
 *   - Light dividers between sections
 *   - Paths collapsed to `~/…` when long
 *   - ⚠ + `← older` tag on out-of-date machines
 *
 * Pure string output, no I/O — snapshot-testable.
 */
import os from "os";
import path from "path";
import { c, color, glyph, width } from "./ui/tokens.js";
import { Header } from "./ui/header.js";
import { Status } from "./ui/status.js";

const MAX_PATH_DISPLAY = 50;
const MAX_VISIBLE_ROWS = 5;

/** One project row, as used by the upgraded/skipped sections. */
export interface ProjectRow {
  /** Friendly project name (registry title or basename). */
  title: string;
  /** Full filesystem path. */
  fullPath: string;
}

/** One machine row, as used by the connected-machines callout. */
export interface MachineRow {
  hostname: string;
  version: string;
  lastSeen: string;
  isCurrent: boolean;
}

/**
 * Render the leading Header for the sync-projects screen.
 * Caller follows with a blank line.
 */
export function renderSyncHeader(version: string): string {
  const v = version.startsWith("v") ? version : `v${version}`;
  return Header(["gnosys", "upgrading registered projects"], { version: v });
}

/**
 * Collapse a long path with a leading `~/…` so it fits on screen.
 * Returns the original path unchanged when already short enough.
 */
export function collapsePath(p: string, homeDir: string = os.homedir()): string {
  // Always prefer ~/ shorthand when path is under home.
  let display = p;
  if (homeDir && p.startsWith(homeDir + path.sep)) {
    display = "~" + p.slice(homeDir.length);
  } else if (homeDir && p === homeDir) {
    display = "~";
  }
  if (display.length <= MAX_PATH_DISPLAY) return display;
  // Path is still too long: keep the head + ellipsis.
  const head = display.slice(0, MAX_PATH_DISPLAY - 2);
  return `${head}/…`;
}

/**
 * Render the "upgraded N projects" section. Returns an array of lines
 * (with no trailing newline). Returns [] when there are no rows.
 */
export function renderUpgradedSection(rows: ProjectRow[]): string[] {
  if (rows.length === 0) return [];
  const lines: string[] = [];
  lines.push(` ${color(c.text, `upgraded   ${rows.length} projects`)}`);
  const visible = rows.slice(0, MAX_VISIBLE_ROWS);
  for (const r of visible) {
    lines.push(formatProjectRow("ok", r));
  }
  const remaining = rows.length - visible.length;
  if (remaining > 0) {
    lines.push(`   ${color(c.textDim, `(${remaining} more)`)}`);
  }
  return lines;
}

/**
 * Render the "skipped N projects" section. Same shape as upgraded but
 * uses the hollow dot glyph. Returns [] when empty.
 */
export function renderSkippedSection(rows: ProjectRow[]): string[] {
  if (rows.length === 0) return [];
  const lines: string[] = [];
  lines.push(` ${color(c.text, `skipped    ${rows.length} projects`)} ${color(c.textDim, "· no .gnosys directory")}`);
  const visible = rows.slice(0, MAX_VISIBLE_ROWS);
  for (const r of visible) {
    lines.push(formatProjectRow("skip", r));
  }
  const remaining = rows.length - visible.length;
  if (remaining > 0) {
    lines.push(`   ${color(c.textDim, `(${remaining} more)`)}`);
  }
  return lines;
}

/**
 * Render the "failed N projects" section. Renders all rows (no "more"
 * collapse) since failures matter.
 */
export function renderFailedSection(rows: ProjectRow[]): string[] {
  if (rows.length === 0) return [];
  const lines: string[] = [];
  lines.push(` ${color(c.text, `failed     ${rows.length} projects`)}`);
  for (const r of rows) {
    lines.push(formatProjectRow("fail", r));
  }
  return lines;
}

/**
 * Render the connected-machines callout. Returns [] when there's only
 * one machine (no callout needed).
 */
export function renderMachinesSection(rows: MachineRow[], currentVersion: string): string[] {
  if (rows.length <= 1) return [];
  const lines: string[] = [];
  lines.push(` ${color(c.text, "connected machines")}`);
  lines.push("");
  const nameW = Math.max(...rows.map((r) => r.hostname.length));
  for (const r of rows) {
    const isOlder = r.version !== currentVersion;
    const dot = isOlder ? color(c.warn, glyph.warn) : color(c.ok, glyph.ok);
    const name = color(c.text, r.hostname.padEnd(nameW));
    const versionDisplay = r.isCurrent && !isOlder ? "" : `v${r.version}`;
    const versionCol = color(c.textDim, versionDisplay.padEnd(10));
    const lastSeenDate = r.lastSeen.split("T")[0];
    const lastSeen = r.isCurrent
      ? color(c.textDim, "this machine")
      : color(c.textDim, `last seen ${lastSeenDate}`);
    const tag = isOlder ? `   ${color(c.warn, "← older")}` : "";
    lines.push(`   ${dot}  ${name}   ${versionCol}   ${lastSeen}${tag}`);
  }
  return lines;
}

/** Render a horizontal divider (1-col indent, thin rule). */
export function renderDivider(): string {
  const W = width();
  return ` ${color(c.textGhost, glyph.ruleLight.repeat(Math.max(1, W - 1)))}`;
}

/**
 * Final "done · central DB stamped vX.Y.Z" status line.
 */
export function renderDoneLine(version: string): string {
  const v = version.startsWith("v") ? version : `v${version}`;
  return Status("ok", "done", `central DB stamped ${v}`);
}

/**
 * Build the dashboard summary lines (printed after the divider when
 * regeneration succeeded).
 */
export function renderDashboardSummary(htmlPath: string, mdPath: string): string[] {
  const lines: string[] = [];
  lines.push(` ${color(c.text, "portfolio dashboard regenerated")}`);
  lines.push(`   ${color(c.textDim, "html  ")}  ${color(c.textDim, collapsePath(htmlPath))}`);
  lines.push(`   ${color(c.textDim, "md    ")}  ${color(c.textDim, collapsePath(mdPath))}`);
  return lines;
}

type RowKind = "ok" | "skip" | "fail";

function formatProjectRow(kind: RowKind, r: ProjectRow): string {
  let dot: string;
  switch (kind) {
    case "ok":
      dot = color(c.ok, glyph.ok);
      break;
    case "skip":
      dot = color(c.textDim, glyph.dotHollow);
      break;
    case "fail":
      dot = color(c.fail, glyph.fail);
      break;
  }
  const title = color(c.text, r.title.padEnd(28));
  const fullPath = collapsePath(r.fullPath);
  return `   ${dot}  ${title}  ${color(c.textDim, fullPath)}`;
}
