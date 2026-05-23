/**
 * Project discovery scan (v5.11).
 *
 * Walks each of this machine's named roots for `.gnosys/gnosys.json` files,
 * and for every project found records its machine-portable location
 * (root_id + rel_path) or a per-machine override. This is how a new machine
 * onboards: set its roots in machine.json, then run `gnosys projects scan`.
 *
 * The scan is machine-local — it only ever writes paths derived from THIS
 * machine's roots, so it can run independently on every machine without
 * clobbering the others.
 */

import fs from "fs/promises";
import path from "path";
import type { GnosysDB } from "./db.js";
import type { MachineConfig } from "./machineConfig.js";
import { readProjectIdentity } from "./projectIdentity.js";
import { recordLocation } from "./projectPaths.js";

/** Directories never worth descending into when hunting for projects. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "coverage",
  ".cache", "vendor", ".next", ".gnosys",
]);

export interface ScanEntry {
  projectId: string;
  name: string;
  absPath: string;
  mode: "root" | "override";
  /** True if this scan created the project row (first time seen anywhere). */
  created: boolean;
}

export interface ScanResult {
  roots: string[];
  entries: ScanEntry[];
}

/**
 * Find every project directory (the parent of a `.gnosys/gnosys.json`) under
 * `root`, skipping build/vendor noise and not descending into `.gnosys`.
 * Nested projects (a monorepo with several `.gnosys` stores) are all found.
 */
export async function findProjectDirs(root: string, maxDepth = 6): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === ".gnosys")) {
      try {
        await fs.access(path.join(dir, ".gnosys", "gnosys.json"));
        found.push(dir);
      } catch {
        // .gnosys without an identity file — not a registered project
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }

  await walk(path.resolve(root), 0);
  return found;
}

/**
 * Scan this machine's roots and register every discovered project's location.
 * Creates the project row from its identity file when first seen anywhere.
 */
export async function scanProjects(
  db: GnosysDB,
  machine: MachineConfig,
  opts: { roots?: Record<string, string> } = {},
): Promise<ScanResult> {
  const roots = opts.roots ?? machine.roots;
  const entries: ScanEntry[] = [];

  for (const rootPath of Object.values(roots)) {
    const dirs = await findProjectDirs(rootPath);
    for (const dir of dirs) {
      const identity = await readProjectIdentity(dir);
      if (!identity) continue;

      let created = false;
      if (!db.getProject(identity.projectId)) {
        const now = new Date().toISOString();
        db.insertProject({
          id: identity.projectId,
          name: identity.projectName,
          working_directory: dir,
          user: identity.user || "unknown",
          agent_rules_target: identity.agentRulesTarget ?? null,
          obsidian_vault: identity.obsidianVault ?? null,
          created: identity.createdAt || now,
          modified: now,
        });
        created = true;
      }

      const res = recordLocation(db, machine, identity.projectId, dir);
      entries.push({
        projectId: identity.projectId,
        name: identity.projectName,
        absPath: dir,
        mode: res.mode,
        created,
      });
    }
  }

  return { roots: Object.values(roots), entries };
}
