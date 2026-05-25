/**
 * Machine-local configuration — `~/.config/gnosys/machine.json`.
 *
 * This is the single home for everything specific to THIS physical machine,
 * and it must NEVER be synced to the shared brain or to other machines:
 *
 *   - `machineId`  — a stable random UUID identifying this machine. Used to
 *                    key per-machine rows (e.g. project_locations) so two
 *                    machines never clobber each other's data.
 *   - `roots`      — named project roots whose ABSOLUTE paths differ per
 *                    machine (e.g. { dev: "/Users/edward/MSDev/projects" } on
 *                    the Studio, "/Users/edward/MBPDev/projects" on the MBP).
 *                    A project stores a machine-INDEPENDENT `rel_path` + the
 *                    `root_id`; its absolute path is reconstructed at runtime.
 *   - `remote`     — the per-machine remote-sync connection (NAS mount path on
 *                    one machine, a Tailscale URL on another). Previously this
 *                    lived in the synced `gnosys_meta` table, which is itself
 *                    the multi-machine bug in miniature — every machine
 *                    overwrote the others' value.
 *
 * The central DB at `~/.gnosys/gnosys.db` is the synced source of truth;
 * machine.json is its machine-local counterpart. Resolution of a project's
 * absolute path on a given machine is: `join(roots[root_id], rel_path)` (or a
 * per-machine override row for projects that live outside any root).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { getMachineConfigPath } from "./paths.js";
import { atomicWriteFileSync } from "./atomicWrite.js";

export const MACHINE_CONFIG_VERSION = 1;

export interface MachineRemoteConfig {
  /** Whether remote sync is configured/active on this machine. */
  enabled: boolean;
  /** Absolute path or URL to the remote DB on this machine (NAS mount / Tailscale). */
  path?: string;
}

export interface MachineConfig {
  /** Stable random UUID for this machine. Never shared/synced. */
  machineId: string;
  /** os.hostname() at write time — used to detect a synced-in foreign file. */
  hostname: string;
  /** Named root → absolute path on THIS machine. */
  roots: Record<string, string>;
  /** Per-machine remote-sync connection. */
  remote: MachineRemoteConfig;
  schemaVersion: number;
}

/** A fresh machine config for the current host. */
export function defaultMachineConfig(): MachineConfig {
  return {
    machineId: randomUUID(),
    hostname: os.hostname(),
    roots: {},
    remote: { enabled: false },
    schemaVersion: MACHINE_CONFIG_VERSION,
  };
}

/** Coerce an arbitrary parsed object into a well-formed MachineConfig. */
function normalize(parsed: Partial<MachineConfig> | null | undefined): MachineConfig {
  const base = defaultMachineConfig();
  if (!parsed || typeof parsed !== "object") return base;
  const roots: Record<string, string> = {};
  if (parsed.roots && typeof parsed.roots === "object") {
    for (const [k, v] of Object.entries(parsed.roots)) {
      if (typeof v === "string" && v.length > 0) roots[k] = path.resolve(v);
    }
  }
  const remote: MachineRemoteConfig = {
    enabled: Boolean(parsed.remote?.enabled),
    ...(typeof parsed.remote?.path === "string" ? { path: parsed.remote.path } : {}),
  };
  return {
    machineId: typeof parsed.machineId === "string" && parsed.machineId ? parsed.machineId : base.machineId,
    hostname: typeof parsed.hostname === "string" && parsed.hostname ? parsed.hostname : base.hostname,
    roots,
    remote,
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : MACHINE_CONFIG_VERSION,
  };
}

/** Read machine.json, or null if it doesn't exist / is unreadable. */
export function readMachineConfig(): MachineConfig | null {
  try {
    const raw = fs.readFileSync(getMachineConfigPath(), "utf-8");
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Persist machine.json (creates the config dir if needed). */
export function writeMachineConfig(cfg: MachineConfig): void {
  const p = getMachineConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

export interface EnsureResult {
  config: MachineConfig;
  /** True if a new config was created on disk. */
  created: boolean;
  /**
   * True if the existing config's hostname did not match the current host —
   * a strong signal it was synced in from another machine, so machineId was
   * regenerated to keep machine identities distinct.
   */
  regenerated: boolean;
}

/**
 * Load machine.json, creating it on first run. If the persisted config's
 * hostname does not match the current host, it was almost certainly synced in
 * from another machine by mistake; regenerate `machineId` and refresh
 * `hostname` so two machines never share an identity. Named roots and the
 * remote block are preserved (a benign hostname rename keeps them valid; a
 * genuine foreign file gets corrected when the user re-runs `projects scan`).
 */
export function ensureMachineConfig(): EnsureResult {
  const override = process.env.GNOSYS_MACHINE_ID?.trim();
  const existing = readMachineConfig();
  const host = os.hostname();

  if (override) {
    const base = existing ?? defaultMachineConfig();
    const cfg: MachineConfig = {
      ...base,
      machineId: override,
      hostname: host,
    };
    writeMachineConfig(cfg);
    return { config: cfg, created: !existing, regenerated: false };
  }

  if (!existing) {
    const fresh = defaultMachineConfig();
    writeMachineConfig(fresh);
    return { config: fresh, created: true, regenerated: false };
  }

  if (existing.hostname !== host) {
    const regenerated: MachineConfig = {
      ...existing,
      machineId: randomUUID(),
      hostname: host,
    };
    writeMachineConfig(regenerated);
    return { config: regenerated, created: false, regenerated: true };
  }

  return { config: existing, created: false, regenerated: false };
}

/** Convenience: this machine's stable id (creating machine.json if needed). */
export function getMachineId(): string {
  return ensureMachineConfig().config.machineId;
}

/**
 * Reconstruct an absolute path on this machine from a (root_id, rel_path)
 * pair, using the machine's named roots. Returns null when the root is not
 * configured on this machine (i.e. the project is "not on this machine").
 */
export function absPathFromRoot(
  cfg: MachineConfig,
  rootId: string | null | undefined,
  relPath: string | null | undefined,
): string | null {
  if (!rootId || !relPath) return null;
  const root = cfg.roots[rootId];
  if (!root) return null;
  return path.join(root, relPath);
}

/**
 * Given an absolute path on this machine, find the named root that contains
 * it and return { rootId, relPath }. Picks the deepest (most specific) root
 * when several match. Returns null when no configured root contains the path.
 */
export function relPathUnderRoot(
  cfg: MachineConfig,
  absPath: string,
): { rootId: string; relPath: string } | null {
  const target = path.resolve(absPath);
  let best: { rootId: string; relPath: string; rootLen: number } | null = null;
  for (const [rootId, rootPath] of Object.entries(cfg.roots)) {
    const root = path.resolve(rootPath);
    const rel = path.relative(root, target);
    // Inside the root iff rel doesn't escape upward and isn't absolute.
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      if (!best || root.length > best.rootLen) {
        best = { rootId, relPath: rel, rootLen: root.length };
      }
    }
  }
  return best ? { rootId: best.rootId, relPath: best.relPath } : null;
}
