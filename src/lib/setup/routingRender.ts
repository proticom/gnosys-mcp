/**
 * Render helpers for `gnosys setup routing` (Screen 4).
 *
 * Provides the cost-tier table + diff renderers used by the wizard. Pure
 * string output for snapshot-testability. v5.9.4 — the columnar table is
 * now produced by the generic `Table` atom (arch-004); only the row-marker
 * decoration is still local.
 */
import { c, color, glyph } from "./ui/tokens.js";
import { renderTable, type TableColumn } from "./ui/table.js";
import { PROVIDER_TIERS } from "../setup.js";

/** Cost-tier bucket. `free` = ollama / lmstudio (always $0). */
export type CostTier = "free" | "$" | "$$" | "$$$";

/**
 * Classify a provider/model pair into a `$ / $$ / $$$ / free` bucket. The
 * heuristic is the average of input + output pricing from PROVIDER_TIERS:
 *
 *   free               local providers (ollama, lmstudio) and any model
 *                      whose registered cost is 0/0
 *   $                  avg < 1.0    (cheap cloud — groq, gpt-mini, xai-mini)
 *   $$                 avg < 5.0    (mid — sonnet, gpt-5, grok-flagship)
 *   $$$                otherwise   (premium — opus, mistral-large)
 *
 * Falls back to `$$` when the model isn't registered (unknown — conservative
 * mid-tier so the user notices unknown spend).
 */
export function classifyCost(provider: string, model: string): CostTier {
  if (provider === "ollama" || provider === "lmstudio") return "free";
  const tiers = PROVIDER_TIERS[provider] ?? [];
  const tier = tiers.find((t) => t.model === model);
  if (!tier) return "$$";
  const avg = (tier.input + tier.output) / 2;
  if (avg === 0) return "free";
  if (avg < 1.0) return "$";
  if (avg < 5.0) return "$$";
  return "$$$";
}

/** One row in the task-routing table. */
export interface TaskRow {
  task: string;
  /** "provider / model" — pre-formatted. */
  uses: string;
  cost: CostTier;
  /** When true, the row gets a `▶` marker in accent-hi (changed). */
  changed?: boolean;
}

/**
 * Render the task-routing table block (title + columnar table). Returns
 * the full multi-line string with no trailing newline.
 *
 * Built on the generic `Table` atom; the only routing-specific bits are
 * the optional `▶` change marker (via `rowFormatter`) and the cost-tier
 * colouring (different ANSI per tier).
 */
export function renderRoutingTable(rows: TaskRow[]): string {
  const columns: TableColumn<TaskRow>[] = [
    {
      header: "task",
      render: (r) => r.task,
      color: c.text,
    },
    {
      header: "uses",
      render: (r) => r.uses,
      color: c.text,
    },
    {
      // Cost cells colour themselves so the tier hue (green / yellow / red)
      // is preserved — column-level `color` would override every cell.
      header: "cost",
      align: "right",
      render: (r) => color(costColor(r.cost), r.cost),
      color: "",
    },
  ];
  const lines = renderTable(rows, columns, {
    indent: 3,
    gap: 2,
    rowFormatter: (row, line) => {
      if (!row.changed) return line;
      // Replace the leading indent with the `▶` selection marker so the
      // changed row stays column-aligned with the others.
      return `${color(c.accentHi, glyph.selection)}  ${line.slice(3)}`;
    },
  });
  return lines.join("\n");
}

/**
 * Render the final diff block — one row per task, showing either
 * `from → to` (changed) or `(unchanged)`. Always emits a row per task
 * so the user has a full picture.
 */
export interface DiffEntry {
  task: string;
  /** "provider / model" before the edit. */
  from: string;
  /** "provider / model" after the edit, or null when unchanged. */
  to: string | null;
}

export function renderRoutingDiff(entries: DiffEntry[]): string {
  if (entries.length === 0) return "";
  const taskW = Math.max(...entries.map((e) => e.task.length));
  const fromW = Math.max(...entries.map((e) => e.from.length));
  const indent = "   ";
  const arrow = color(c.textGhost, glyph.arrow);
  const lines: string[] = [];
  for (const e of entries) {
    const taskTxt = color(c.textDim, e.task.padEnd(taskW));
    if (e.to === null || e.to === e.from) {
      lines.push(`${indent}${taskTxt}   ${color(c.textMid, e.from.padEnd(fromW))}   ${color(c.textDim, "(unchanged)")}`);
    } else {
      lines.push(`${indent}${taskTxt}   ${color(c.textMid, e.from.padEnd(fromW))}   ${arrow}   ${color(c.accentHi, e.to)}`);
    }
  }
  return lines.join("\n");
}

function costColor(t: CostTier): string {
  switch (t) {
    case "free":
      return c.ok;
    case "$":
      return c.text;
    case "$$":
      return c.warn;
    case "$$$":
      return c.fail;
  }
}
