/**
 * v5.11 one-time migration to machine-portable project paths.
 *
 * Run once per machine. It:
 *   1. Ensures machine.json exists (machineId, hostname).
 *   2. Adopts machine-LOCAL values that were wrongly living in the SYNCED
 *      gnosys_meta — `machine_id` (for continuity) and `remote_path` — into
 *      machine.json, then deletes them from meta so they stop syncing and
 *      clobbering other machines.
 *   3. Sets the `dev` root (explicit --root, else derived from the registry).
 *   4. Scans to backfill machine-independent root_id/rel_path on projects.
 *
 * It operates on the LOCAL DB (GnosysDB.openLocal), never a remote, because it
 * moves machine-local state out of the shared store.
 */

import fs from "fs";
import path from "path";
import type { GnosysDB } from "./db.js";
import { ensureMachineConfig, writeMachineConfig } from "./machineConfig.js";
import { getProjectRegistryPath } from "./paths.js";
import { scanProjects, type ScanResult } from "./projectScan.js";

export interface MigrateResult {
  machineId: string;
  hostname: string;
  rootsConfigured: Record<string, string>;
  adoptedMachineId: boolean;
  adoptedRemotePath: boolean;
  regeneratedMachineId: boolean;
  scan?: ScanResult;
}

export async function migrateMachine(
  localDb: GnosysDB,
  opts: { root?: string; rootName?: string; scan?: boolean } = {},
): Promise<MigrateResult> {
  const ens = ensureMachineConfig();
  const machine = ens.config;

  // 1. Adopt machine_id from synced meta (continuity), then remove it so the
  //    synced DB stops carrying a per-machine identity.
  let adoptedMachineId = false;
  const metaMachineId = localDb.getMeta("machine_id");
  if (metaMachineId && !/^unknown-/.test(metaMachineId)) {
    machine.machineId = metaMachineId;
    adoptedMachineId = true;
  }
  localDb.deleteMeta("machine_id");

  // 2. Adopt remote_path from synced meta, then remove it.
  let adoptedRemotePath = false;
  const metaRemote = localDb.getMeta("remote_path");
  if (metaRemote && !machine.remote.path) {
    machine.remote = { enabled: true, path: metaRemote };
    adoptedRemotePath = true;
  }
  localDb.deleteMeta("remote_path");

  // 3. Set the dev root.
  const rootName = opts.rootName || "dev";
  if (opts.root) {
    machine.roots[rootName] = path.resolve(opts.root);
  } else if (!machine.roots[rootName]) {
    const derived = deriveCommonRoot();
    if (derived) machine.roots[rootName] = derived;
  }

  writeMachineConfig(machine);

  // 4. Scan (default on) to backfill machine-portable locations.
  let scan: ScanResult | undefined;
  if (opts.scan !== false && Object.keys(machine.roots).length > 0) {
    scan = await scanProjects(localDb, machine);
  }

  return {
    machineId: machine.machineId,
    hostname: machine.hostname,
    rootsConfigured: machine.roots,
    adoptedMachineId,
    adoptedRemotePath,
    regeneratedMachineId: ens.regenerated,
    scan,
  };
}

/**
 * Derive the most likely `dev` root: the directory that is the parent of the
 * most registered projects. Picking the most-common parent (rather than the
 * global common prefix) avoids collapsing to `/Users/<name>` when a few
 * outlier projects live elsewhere.
 */
export function deriveCommonRoot(): string | null {
  let paths: string[];
  try {
    const raw = fs.readFileSync(getProjectRegistryPath(), "utf-8");
    paths = (JSON.parse(raw) as unknown[]).filter(
      (p): p is string =>
        typeof p === "string" &&
        p.startsWith("/") &&
        !p.startsWith("/tmp/") &&
        !p.startsWith("/private/tmp/") &&
        !p.startsWith("/var/folders/"),
    );
  } catch {
    return null;
  }
  if (paths.length === 0) return null;

  const counts = new Map<string, number>();
  for (const p of paths) {
    const parent = path.dirname(p);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [dir, n] of counts) {
    if (n > bestN) {
      best = dir;
      bestN = n;
    }
  }
  return best;
}
