/**
 * Render helpers for `gnosys setup routing` (Screen 4).
 *
 * Provides the cost-tier table + diff renderers used by the wizard. Pure
 * string output for snapshot-testability.
 */
import { c, color, glyph, width } from "./ui/tokens.js";
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
 */
export function renderRoutingTable(rows: TaskRow[]): string {
  const W = width();
  const taskW = Math.max("task".length, ...rows.map((r) => r.task.length)) + 2;
  const usesW = Math.max("uses".length, ...rows.map((r) => r.uses.length)) + 2;
  const indent = "   ";
  const lines: string[] = [];
  const head = `${indent}${color(c.textDim, "task".padEnd(taskW))}${color(c.textDim, "uses".padEnd(usesW))}${color(c.textDim, "cost".padStart(6))}`;
  lines.push(head);
  // Rule under the header.
  const ruleLen = Math.max(1, W - indent.length);
  lines.push(`${indent}${color(c.textGhost, glyph.ruleLight.repeat(ruleLen - 2))}`);
  for (const r of rows) {
    const marker = r.changed ? color(c.accentHi, glyph.selection) : " ";
    const taskTxt = r.changed
      ? color(c.accentHi, r.task.padEnd(taskW - 2))
      : color(c.text, r.task.padEnd(taskW - 2));
    const usesTxt = r.changed
      ? color(c.accentHi, r.uses.padEnd(usesW))
      : color(c.text, r.uses.padEnd(usesW));
    const costTxt = color(costColor(r.cost), r.cost.padStart(6));
    lines.push(`${indent}${marker} ${taskTxt}${usesTxt}${costTxt}`);
  }
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
