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
