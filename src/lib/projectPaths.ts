/**
 * Machine-aware project path resolution (v5.11).
 *
 * A project's portable identity is its UUID. Its location is resolved PER
 * MACHINE, in priority order:
 *   1. A per-machine override row (project_locations) — used for projects
 *      that live outside any named root.
 *   2. join(machine.roots[root_id], rel_path) — the common, zero-touch case
 *      (machine-independent rel_path + this machine's root).
 *   3. null — the project is "not on this machine".
 *
 * Nothing here reads an absolute path that was persisted by another machine,
 * so the same shared brain resolves correctly on the Studio, the MBP, etc.
 */

import type { GnosysDB, DbProject } from "./db.js";
import { type MachineConfig, absPathFromRoot, relPathUnderRoot } from "./machineConfig.js";

export type LocationSource = "override" | "root" | "none";

export interface ResolvedProject {
  project: DbProject;
  /** Absolute path on this machine, or null when not present here. */
  absPath: string | null;
  source: LocationSource;
}

/** Resolve a single project's absolute path on this machine (or null). */
export function resolveProjectPath(
  db: GnosysDB,
  machine: MachineConfig,
  projectId: string,
): string | null {
  const override = db.getProjectLocation(projectId, machine.machineId);
  if (override) return override.abs_path;
  const project = db.getProject(projectId);
  if (!project) return null;
  return absPathFromRoot(machine, project.root_id, project.rel_path);
}

/** Resolve a project with provenance, or null if the project is unknown. */
export function resolveProject(
  db: GnosysDB,
  machine: MachineConfig,
  projectId: string,
): ResolvedProject | null {
  const project = db.getProject(projectId);
  if (!project) return null;
  return resolveFor(db, machine, project);
}

/** Resolve every known project for this machine (for portfolio/federation). */
export function resolveAllProjects(db: GnosysDB, machine: MachineConfig): ResolvedProject[] {
  return db.getAllProjects().map((project) => resolveFor(db, machine, project));
}

function resolveFor(db: GnosysDB, machine: MachineConfig, project: DbProject): ResolvedProject {
  const override = db.getProjectLocation(project.id, machine.machineId);
  if (override) return { project, absPath: override.abs_path, source: "override" };
  const fromRoot = absPathFromRoot(machine, project.root_id, project.rel_path);
  return { project, absPath: fromRoot, source: fromRoot ? "root" : "none" };
}

/**
 * Record where THIS machine keeps a project, choosing the portable storage
 * automatically:
 *   - If absPath sits under a named root, store the machine-INDEPENDENT
 *     root_id + rel_path on the project row (shared across machines) and
 *     drop any now-redundant per-machine override.
 *   - Otherwise store a per-machine override row (project_locations).
 *
 * working_directory is updated as a machine-local display cache either way.
 * Used by `gnosys projects scan` and `gnosys init`.
 */
export function recordLocation(
  db: GnosysDB,
  machine: MachineConfig,
  projectId: string,
  absPath: string,
): { mode: "root" | "override"; rootId?: string; relPath?: string } {
  const now = new Date().toISOString();
  const under = relPathUnderRoot(machine, absPath);
  if (under) {
    db.updateProject(projectId, {
      root_id: under.rootId,
      rel_path: under.relPath,
      working_directory: absPath,
      modified: now,
    });
    db.deleteProjectLocation(projectId, machine.machineId);
    return { mode: "root", rootId: under.rootId, relPath: under.relPath };
  }
  db.setProjectLocation({ project_id: projectId, machine_id: machine.machineId, abs_path: absPath, modified: now });
  db.updateProject(projectId, { working_directory: absPath, modified: now });
  return { mode: "override" };
}
