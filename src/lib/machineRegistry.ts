/**
 * The "connected machines" registry — a small JSON blob stored under the
 * `machines` key in the central DB's `gnosys_meta` table.
 *
 * Each machine records itself here whenever it runs `setup sync-projects`, so
 * the upgrade flow can show which machines share the brain and what version
 * each was last seen on.
 *
 * Historically this map was keyed by `os.hostname()` alone. That made it
 * fragile: if a machine's hostname changed (e.g. macOS renames a laptop from
 * `Edwards-MBP.localdomain` to `EdsMBP`), the machine started recording under
 * the NEW name and the OLD entry was orphaned forever — a "phantom machine"
 * that could never update or be cleaned up.
 *
 * The fix: every entry now also carries the stable `machineId` (from
 * machine.json), and when a machine records itself it prunes any entry whose
 * key matches one of its own previous hostnames (`aliases`). Renames therefore
 * clean themselves up on the next sync. `forgetMachine` covers the one-time
 * case of an already-orphaned phantom from before this tracking existed.
 */

import type { GnosysDB } from "./db.js";

const REGISTRY_KEY = "machines";

export interface MachineRegistryEntry {
  /** Gnosys version this machine was last seen running (at last sync). */
  version: string;
  /** ISO timestamp of that last sync. */
  lastSeen: string;
  /**
   * Stable machine id (machine.json). Optional because entries written by
   * older versions predate this field; recorded going forward.
   */
  machineId?: string;
}

/** hostname → entry. */
export type MachineRegistry = Record<string, MachineRegistryEntry>;

/** Read and parse the registry, returning {} when absent or malformed. */
export function readMachineRegistry(db: GnosysDB): MachineRegistry {
  try {
    const raw = db.getMeta(REGISTRY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MachineRegistry) : {};
  } catch {
    return {};
  }
}

/** Persist the registry as JSON. */
export function writeMachineRegistry(db: GnosysDB, registry: MachineRegistry): void {
  db.setMeta(REGISTRY_KEY, JSON.stringify(registry));
}

export interface RecordMachineInput {
  /** This machine's current hostname (os.hostname()). */
  hostname: string;
  /** Version to stamp for this machine. */
  version: string;
  /** Stable machine id from machine.json. */
  machineId?: string;
  /**
   * Previous hostnames this same machine has used. Any registry entry under
   * one of these names is removed — that's how a rename self-heals.
   */
  aliases?: string[];
}

/**
 * Record this machine in the registry, pruning stale alias entries, and
 * persist. Returns the updated registry.
 */
export function recordMachine(db: GnosysDB, input: RecordMachineInput): MachineRegistry {
  const registry = readMachineRegistry(db);

  // Drop any orphaned entries left behind by a previous hostname of THIS
  // machine. Only this machine's own aliases are ever passed in, so this can
  // never remove a different physical machine.
  for (const alias of input.aliases ?? []) {
    if (alias && alias !== input.hostname) delete registry[alias];
  }

  // Also drop any other entry that shares our stable machineId but lives under
  // a different hostname — covers a rename where the id was preserved.
  if (input.machineId) {
    for (const [host, entry] of Object.entries(registry)) {
      if (host !== input.hostname && entry.machineId === input.machineId) {
        delete registry[host];
      }
    }
  }

  registry[input.hostname] = {
    version: input.version,
    lastSeen: new Date().toISOString(),
    ...(input.machineId ? { machineId: input.machineId } : {}),
  };

  writeMachineRegistry(db, registry);
  return registry;
}

/**
 * Remove a machine from the registry by hostname. Returns true if an entry was
 * actually removed. Used by `gnosys machine forget` to clear a phantom.
 */
export function forgetMachine(db: GnosysDB, hostname: string): boolean {
  const registry = readMachineRegistry(db);
  if (!(hostname in registry)) return false;
  delete registry[hostname];
  writeMachineRegistry(db, registry);
  return true;
}
