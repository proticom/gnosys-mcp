/**
 * idFormat — single place that renders memory IDs for the user.
 *
 * v5.7.1 (#14) — display-layer project prefix.
 *
 * Storage stays unchanged: `deci-01HXXJK2…`. Only the *rendered* citation
 * adds the project name. Rationale (see road-009 #14):
 *   - Project renames don't break IDs.
 *   - No multi-user collisions (storage keys remain globally unique ULIDs).
 *   - No breaking schema change.
 *
 * Three formats:
 *   - `raw`    : `deci-01HXXJK2ABCDEFGHIJK`           (no project, full ULID)
 *   - `short`  : `gnosys-ai · deci-01HXXJK2…`         (project + truncated)
 *   - `long`   : `gnosys-ai · deci-01HXXJK2ABCDEFG…`  (project + full ULID)
 *
 * `short` is the default — short-enough for grep, long-enough to be unique
 * across one project. Users who script against IDs should pass `--id-format raw`.
 */

import type { GnosysDB, DbProject } from "./db.js";

export type IdFormat = "short" | "long" | "raw";

const SHORT_ULID_PREFIX = 8;

// ─── OSC8 hyperlink helpers ─────────────────────────────────────────────
//
// v5.8.3 (#91): emit clickable links for memory IDs in OSC8-supporting
// terminals (iTerm2, Ghostty, Kitty, WezTerm, modern gnome-terminal).
// The escape sequence is `\x1b]8;;<URI>\x1b\\<text>\x1b]8;;\x1b\\`. A
// terminal that doesn't understand it ignores the escapes and prints
// only `<text>`, so this is safe everywhere — but we only emit when
// stdout is a TTY to keep pipes/CI logs clean.
//
// URI scheme: `gnosys://memory/<id>`. No OS-level handler is required
// for visual underline/click affordance to render; users who want
// "click → open in gnosys" can register a URL handler later, but the
// out-of-the-box value is the visual hint + copy-URL menu in the
// terminal.

const OSC8_START = "\x1b]8;;";
const OSC8_BREAK = "\x1b\\";
const OSC8_END = "\x1b]8;;\x1b\\";

function isTtyStdout(): boolean {
  return Boolean(process.stdout.isTTY);
}

/** Build the gnosys:// URI for a memory id. Encodes the id defensively. */
export function memoryUri(id: string): string {
  return `gnosys://memory/${encodeURIComponent(id)}`;
}

/** Wrap `display` in OSC8 escapes pointing at `uri`. Caller decides when to use. */
export function osc8Wrap(uri: string, display: string): string {
  return `${OSC8_START}${uri}${OSC8_BREAK}${display}${OSC8_END}`;
}

/**
 * Format a single memory ID for display.
 *
 * `projectName` may be undefined/null when the memory is global or personal
 * scoped, or when lookup failed. In that case the project segment is omitted.
 */
export function formatMemoryId(
  id: string,
  projectName: string | null | undefined,
  format: IdFormat = "short",
): string {
  if (format === "raw") return id;

  let renderedId = id;
  if (format === "short") {
    // Truncate the ULID portion (after `prefix-`) to its first N chars + "…"
    const dashIdx = id.indexOf("-");
    if (dashIdx > 0 && id.length > dashIdx + 1 + SHORT_ULID_PREFIX) {
      renderedId = `${id.slice(0, dashIdx + 1 + SHORT_ULID_PREFIX)}…`;
    }
  }

  if (!projectName) return renderedId;
  return `${projectName} · ${renderedId}`;
}

/**
 * Same as `formatMemoryId`, but wraps the result in an OSC8 hyperlink
 * pointing at `gnosys://memory/<id>` when stdout is a TTY.
 *
 * In OSC8-aware terminals (iTerm2, Ghostty, Kitty, WezTerm) the citation
 * renders underlined and the user can click / cmd-click / right-click-copy
 * the URI. In every other context (pipes, CI logs, `--json` consumers,
 * `less`) the function returns plain text exactly like `formatMemoryId`.
 *
 * Always emits the FULL id in the underlying URI (so right-click-copy
 * gives back something useful) even when the visible text is the
 * truncated `short` form.
 */
export function formatMemoryIdHyperlink(
  id: string,
  projectName: string | null | undefined,
  format: IdFormat = "short",
  options?: { tty?: boolean },
): string {
  const display = formatMemoryId(id, projectName, format);
  const tty = options?.tty ?? isTtyStdout();
  if (!tty) return display;
  return osc8Wrap(memoryUri(id), display);
}

/**
 * Build a single-shot {project_id → project_name} lookup map.
 *
 * Cheap — one SELECT for the projects table, which is small. Use this when
 * formatting many IDs in a list/print loop so we don't hit the DB once per row.
 */
export function buildProjectNameLookup(db: GnosysDB): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.getAllProjects() as DbProject[];
  for (const r of rows) {
    if (r.id && r.name) out.set(r.id, r.name);
  }
  return out;
}

/**
 * Parse `--id-format` value, defaulting to `short`. Throws nothing — returns
 * `short` for unknown inputs so CLI callers don't have to guard.
 */
export function parseIdFormat(value: string | undefined): IdFormat {
  if (value === "raw" || value === "long" || value === "short") return value;
  return "short";
}
