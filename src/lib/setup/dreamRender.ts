/**
 * Render helpers for `gnosys setup dream` (Screen 7).
 *
 * The wizard runs inside `runDreamSetup` (in `setup.ts`); this module
 * owns only the pure helpers that are easy to snapshot-test:
 *
 *   - buildDreamDiffRows: the 4-row before/after summary printed at the
 *     end of the three-step flow
 *   - renderThresholdsBlock: the static "thresholds + sub-tasks" panel
 *     rendered on screen 7.2 with default values inside fake `[N ]`
 *     fields
 */

export interface DreamDiffRow {
  label: string;
  from: string;
  to: string;
}

export interface DreamSettings {
  provider: string;
  model?: string;
  machine: string;
  idleMinutes: number;
  maxRuntimeMinutes: number;
  selfCritique: boolean;
  generateSummaries: boolean;
  discoverRelationships: boolean;
}

/**
 * Build the four canonical rows for the post-save Diff block. Always
 * emits the same four labels so users have a consistent footprint
 * across machines.
 */
export function buildDreamDiffRows(prev: Partial<DreamSettings> | null, next: DreamSettings): DreamDiffRow[] {
  const prevProvider = prev?.provider ? `${prev.provider}${prev.model ? " / " + prev.model : ""}` : "—";
  const nextProvider = `${next.provider}${next.model ? " / " + next.model : ""}`;
  return [
    { label: "provider", from: prevProvider, to: nextProvider },
    { label: "machine", from: prev?.machine ?? "—", to: next.machine },
    {
      label: "idle threshold",
      from: prev?.idleMinutes !== undefined ? `${prev.idleMinutes} min` : "—",
      to: `${next.idleMinutes} min`,
    },
    {
      label: "max runtime",
      from: prev?.maxRuntimeMinutes !== undefined ? `${prev.maxRuntimeMinutes} min` : "—",
      to: `${next.maxRuntimeMinutes} min`,
    },
  ];
}

/**
 * Render the static thresholds/sub-tasks block from screen 7.2. Returns
 * an array of lines (no trailing newline). The wizard prints these
 * before asking for `enter | e`.
 */
export function renderThresholdsBlock(
  idleMinutes: number,
  maxRuntimeMinutes: number,
  minMemories: number,
  subs: { selfCritique: boolean; generateSummaries: boolean; discoverRelationships: boolean },
): string[] {
  const fmt = (n: number): string => String(n).padEnd(3);
  return [
    `   when to run`,
    `     idle threshold    [${fmt(idleMinutes)}] minutes      wait this long before starting`,
    `     max runtime       [${fmt(maxRuntimeMinutes)}] minutes      cap each cycle to avoid runaway`,
    `     min memories      [${fmt(minMemories)}]              only run if there's enough new material`,
    "",
    `   what to do`,
    `     ${subs.selfCritique ? "✓" : "○"}  self-critique         review and re-rank existing memories`,
    `     ${subs.generateSummaries ? "✓" : "○"}  generate summaries    produce a "what changed today" digest`,
    `     ${subs.discoverRelationships ? "✓" : "○"}  discover relationships  link related memories explicitly`,
  ];
}
