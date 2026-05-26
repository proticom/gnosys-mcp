/**
 * Dream-state reconciler (v5.9.4 Bugs 7 + 8).
 *
 * Three sources of truth need to agree before we can display "dream mode
 * is enabled · machine X" with confidence:
 *
 *   1. `cfg.dream.enabled` / `cfg.dream.provider` / `cfg.dream.model`
 *      live in gnosys.json
 *   2. `dream_machine_id` lives in the LOCAL central DB meta table
 *   3. `dream_machine_id` may ALSO live in the REMOTE DB (when multi-machine
 *      sync is configured)
 *
 * Before v5.9.4 the summary panel only checked (1) and re-entry into the
 * dream wizard only checked (2). Switching machines or enabling dream from
 * a different machine caused both screens to show stale "no designated
 * machine" or "dream mode disabled" messages.
 *
 * `getDreamState()` is the single source of truth used by every caller.
 */

import type { GnosysDB } from "../db.js";
import type { GnosysConfig } from "../config.js";

/** Where the active dream state came from. */
type DreamStateSource = "config" | "local-db" | "remote-db" | "default";

export interface DreamState {
  /** True if any source advertises dream mode as active. */
  enabled: boolean;
  /** Designated dream machine id, or null when nothing claims the role. */
  machineId: string | null;
  /** Effective dream provider name (e.g. anthropic, ollama). */
  provider: string;
  /** Effective dream model name (may be empty when provider has no default). */
  model: string;
  /** Which source we trusted for the `enabled` + `machineId` fields. */
  source: DreamStateSource;
}

/**
 * Reconcile dream state across config + local DB meta + (optional) remote DB
 * meta. `dream.enabled` is treated as a positive signal from any of the
 * sources — a designated machine id in EITHER DB beats `cfg.dream.enabled: false`
 * because that indicates a real session enabled it elsewhere.
 *
 * Source precedence for the `machineId` field:
 *   - local DB wins when set
 *   - remote DB falls in next (for first-time setup on a new machine)
 *   - config still drives provider/model regardless
 */
export function getDreamState(
  cfg: GnosysConfig,
  localDb: GnosysDB | null,
  remoteDb: GnosysDB | null = null,
): DreamState {
  const configEnabled = !!cfg.dream?.enabled;
  const provider = cfg.dream?.provider ?? "ollama";
  const model = cfg.dream?.model ?? "";

  const localMachineId = safeReadDreamMachineId(localDb);
  const remoteMachineId = safeReadDreamMachineId(remoteDb);

  let machineId: string | null = null;
  let source: DreamStateSource = configEnabled ? "config" : "default";
  if (localMachineId) {
    machineId = localMachineId;
    source = "local-db";
  } else if (remoteMachineId) {
    machineId = remoteMachineId;
    source = "remote-db";
  }

  const enabled = configEnabled || machineId !== null;
  return { enabled, machineId, provider, model, source };
}

/** Describe a dream state in one line for the settings summary panel. */
export function describeDreamState(state: DreamState): string {
  if (!state.enabled) return "disabled";
  const machinePart = state.machineId ? ` · ${state.machineId}` : "";
  const modelPart = state.model ? `${state.provider} / ${state.model}` : state.provider;
  return `${modelPart}${machinePart}`;
}

function safeReadDreamMachineId(db: GnosysDB | null): string | null {
  if (!db) return null;
  try {
    return db.getDreamMachineId();
  } catch {
    return null;
  }
}
