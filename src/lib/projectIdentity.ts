/**
 * Gnosys Project Identity — v3.0 Centralized Brain.
 *
 * Each project has a .gnosys/gnosys.json that stores its identity:
 *   projectId, projectName, workingDirectory, user, agentRulesTarget, obsidianVault
 *
 * The central DB (~/.gnosys/gnosys.db) mirrors this in the `projects` table.
 * gnosys init creates both the local identity file AND the central DB record.
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { GnosysDB, DbProject } from "./db.js";

/** Shape of .gnosys/gnosys.json (project identity) */
export interface ProjectIdentity {
  projectId: string;           // UUID v4
  projectName: string;         // Human-readable
  workingDirectory: string;    // Absolute path to project root
  user: string;                // Username
  agentRulesTarget: string | null;  // e.g. ".cursor/rules/gnosys.mdc"
  obsidianVault: string | null;     // e.g. ".gnosys/vault"
  createdAt: string;           // ISO 8601
  schemaVersion: number;       // Identity file schema version
}

const IDENTITY_SCHEMA_VERSION = 1;

/**
 * Detect which agent IDE is being used.
 * Returns the appropriate rules file target path.
 */
export function detectAgentRulesTarget(projectDir: string): string | null {
  // Check for Cursor
  if (fsSync.existsSync(path.join(projectDir, ".cursor"))) {
    return ".cursor/rules/gnosys.mdc";
  }
  // Check for Claude Code
  if (fsSync.existsSync(path.join(projectDir, "CLAUDE.md"))) {
    return "CLAUDE.md";
  }
  return null;
}

/**
 * Read project identity from .gnosys/gnosys.json.
 * Returns null if file doesn't exist or is invalid.
 */
export async function readProjectIdentity(projectDir: string): Promise<ProjectIdentity | null> {
  const identityPath = path.join(projectDir, ".gnosys", "gnosys.json");
  try {
    const raw = await fs.readFile(identityPath, "utf-8");
    const parsed = JSON.parse(raw);

    // Validate required fields
    if (!parsed.projectId || !parsed.projectName || !parsed.workingDirectory) {
      return null;
    }

    return parsed as ProjectIdentity;
  } catch {
    return null;
  }
}

/**
 * Write project identity to .gnosys/gnosys.json.
 */
export async function writeProjectIdentity(projectDir: string, identity: ProjectIdentity): Promise<void> {
  const identityPath = path.join(projectDir, ".gnosys", "gnosys.json");
  await fs.writeFile(identityPath, JSON.stringify(identity, null, 2) + "\n", "utf-8");
}

/**
 * Create a new project identity.
 * Generates UUID, detects IDE, writes local file, registers in central DB.
 */
export async function createProjectIdentity(
  projectDir: string,
  opts?: { projectName?: string; centralDb?: GnosysDB }
): Promise<ProjectIdentity> {
  const resolvedDir = path.resolve(projectDir);
  const projectName = opts?.projectName || path.basename(resolvedDir);
  const user = os.userInfo().username || "unknown";
  const now = new Date().toISOString();

  // Check if identity already exists and reuse the projectId
  const existing = await readProjectIdentity(resolvedDir);

  const identity: ProjectIdentity = {
    projectId: existing?.projectId || crypto.randomUUID(),
    projectName,
    workingDirectory: resolvedDir,
    user,
    agentRulesTarget: detectAgentRulesTarget(resolvedDir),
    obsidianVault: ".gnosys/vault",
    createdAt: existing?.createdAt || now,
    schemaVersion: IDENTITY_SCHEMA_VERSION,
  };

  // Write local identity file
  await writeProjectIdentity(resolvedDir, identity);

  // Register in central DB if available
  if (opts?.centralDb?.isAvailable()) {
    const dbProject: DbProject = {
      id: identity.projectId,
      name: identity.projectName,
      working_directory: identity.workingDirectory,
      user: identity.user,
      agent_rules_target: identity.agentRulesTarget,
      obsidian_vault: identity.obsidianVault
        ? path.join(identity.workingDirectory, identity.obsidianVault)
        : null,
      created: identity.createdAt,
      modified: now,
    };
    opts.centralDb.insertProject(dbProject);
  }

  return identity;
}

/**
 * Check if the working directory has changed since last init.
 * Returns the identity if a mismatch is detected (needs re-init).
 */
export async function checkDirectoryMismatch(projectDir: string): Promise<{
  mismatch: boolean;
  identity: ProjectIdentity | null;
  currentDir: string;
}> {
  const resolvedDir = path.resolve(projectDir);
  const identity = await readProjectIdentity(resolvedDir);

  if (!identity) {
    return { mismatch: false, identity: null, currentDir: resolvedDir };
  }

  const mismatch = identity.workingDirectory !== resolvedDir;
  return { mismatch, identity, currentDir: resolvedDir };
}

/**
 * Update the working directory in both local identity and central DB.
 * Called when a directory move is detected.
 */
export async function updateWorkingDirectory(
  projectDir: string,
  centralDb?: GnosysDB
): Promise<ProjectIdentity | null> {
  const resolvedDir = path.resolve(projectDir);
  const identity = await readProjectIdentity(resolvedDir);
  if (!identity) return null;

  // Update local file
  identity.workingDirectory = resolvedDir;
  await writeProjectIdentity(resolvedDir, identity);

  // Update central DB
  if (centralDb?.isAvailable()) {
    centralDb.updateProject(identity.projectId, {
      working_directory: resolvedDir,
      modified: new Date().toISOString(),
    });
  }

  return identity;
}

/**
 * Find the project identity by walking up from a directory.
 * Returns the identity and project root directory if found.
 */
export async function findProjectIdentity(startDir: string): Promise<{
  identity: ProjectIdentity;
  projectRoot: string;
} | null> {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const identity = await readProjectIdentity(dir);
    if (identity) {
      return { identity, projectRoot: dir };
    }
    dir = path.dirname(dir);
  }

  return null;
}
