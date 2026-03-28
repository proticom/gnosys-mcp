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
  // Check for Claude Code (CLAUDE.md or .claude/ directory)
  if (fsSync.existsSync(path.join(projectDir, "CLAUDE.md"))) {
    return "CLAUDE.md";
  }
  if (fsSync.existsSync(path.join(projectDir, ".claude"))) {
    return "CLAUDE.md";
  }
  // Check for Codex
  if (fsSync.existsSync(path.join(projectDir, ".codex"))) {
    return ".codex/gnosys.md";
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

// ─── IDE Hook Configuration ─────────────────────────────────────────────

export interface IdeHookResult {
  ide: "claude-code" | "codex" | "cursor" | null;
  configured: boolean;
  filePath: string | null;
  details: string;
}

/**
 * Configure IDE-specific hooks so Gnosys memory recall is automatic.
 *
 * - Claude Code: SessionStart hook in .claude/settings.json
 * - Codex: SessionStart hook in .codex/hooks.json + features flag in .codex/config.toml
 * - Cursor: alwaysApply rule in .cursor/rules/gnosys.mdc (text only, no shell hooks)
 */
export async function configureIdeHooks(projectDir: string): Promise<IdeHookResult> {
  const resolvedDir = path.resolve(projectDir);

  // --- Claude Code ---
  if (fsSync.existsSync(path.join(resolvedDir, ".claude")) || fsSync.existsSync(path.join(resolvedDir, "CLAUDE.md"))) {
    return configureClaudeCode(resolvedDir);
  }

  // --- Codex ---
  if (fsSync.existsSync(path.join(resolvedDir, ".codex"))) {
    return configureCodex(resolvedDir);
  }

  // --- Cursor ---
  if (fsSync.existsSync(path.join(resolvedDir, ".cursor"))) {
    return configureCursor(resolvedDir);
  }

  return { ide: null, configured: false, filePath: null, details: "No supported IDE detected (.claude/, .cursor/, or .codex/ not found)" };
}

/**
 * Claude Code: Add SessionStart hook to .claude/settings.json
 */
export async function configureClaudeCode(projectDir: string): Promise<IdeHookResult> {
  const settingsPath = path.join(projectDir, ".claude", "settings.json");

  // Ensure .claude/ directory exists
  await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });

  // Read existing settings or start fresh
  let settings: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    settings = JSON.parse(raw);
  } catch {
    // No settings yet
  }

  // Build the Gnosys SessionStart hook
  const gnosysHook = {
    type: "command",
    command: "gnosys recall --query \"session start\" --projectRoot \"$CLAUDE_PROJECT_DIR\" 2>/dev/null || true",
    timeout: 10,
  };

  // Merge into existing hooks without clobbering other SessionStart hooks
  const hooks = (settings.hooks || {}) as Record<string, unknown[]>;
  const sessionStartEntries = (hooks.SessionStart || []) as Array<Record<string, unknown>>;

  // Check if a Gnosys hook already exists
  const hasGnosysHook = sessionStartEntries.some((entry) => {
    const entryHooks = (entry.hooks || []) as Array<Record<string, unknown>>;
    return entryHooks.some((h) => typeof h.command === "string" && (h.command as string).includes("gnosys recall"));
  });

  if (!hasGnosysHook) {
    sessionStartEntries.push({
      matcher: "startup|resume|compact",
      hooks: [gnosysHook],
    });
    hooks.SessionStart = sessionStartEntries;
    settings.hooks = hooks;

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }

  return {
    ide: "claude-code",
    configured: true,
    filePath: settingsPath,
    details: hasGnosysHook
      ? "SessionStart hook already configured"
      : "Added SessionStart hook for automatic memory recall",
  };
}

/**
 * Codex: Add SessionStart hook to .codex/hooks.json + enable feature flag
 */
export async function configureCodex(projectDir: string): Promise<IdeHookResult> {
  const hooksPath = path.join(projectDir, ".codex", "hooks.json");
  const configPath = path.join(projectDir, ".codex", "config.toml");

  // Ensure .codex/ directory exists
  await fs.mkdir(path.join(projectDir, ".codex"), { recursive: true });

  // Build hooks.json
  let hooksConfig: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(hooksPath, "utf-8");
    hooksConfig = JSON.parse(raw);
  } catch {
    // No hooks yet
  }

  const gnosysHook = {
    type: "command",
    command: "gnosys recall --query \"session start\" --projectRoot \"$PWD\" 2>/dev/null || true",
    timeout: 10,
  };

  const hooks = (hooksConfig.hooks || {}) as Record<string, unknown[]>;
  const sessionStartEntries = (hooks.SessionStart || []) as Array<Record<string, unknown>>;

  const hasGnosysHook = sessionStartEntries.some((entry) => {
    const entryHooks = (entry.hooks || []) as Array<Record<string, unknown>>;
    return entryHooks.some((h) => typeof h.command === "string" && (h.command as string).includes("gnosys recall"));
  });

  if (!hasGnosysHook) {
    sessionStartEntries.push({
      matcher: "startup|resume",
      hooks: [gnosysHook],
    });
    hooks.SessionStart = sessionStartEntries;
    hooksConfig.hooks = hooks;

    await fs.writeFile(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n", "utf-8");
  }

  // Enable hooks feature flag in config.toml (append if not present)
  let configContent = "";
  try {
    configContent = await fs.readFile(configPath, "utf-8");
  } catch {
    // No config yet
  }

  if (!configContent.includes("codex_hooks")) {
    const featureBlock = configContent.includes("[features]")
      ? "" // Already has [features] section — we'll append the flag
      : "\n[features]\n";
    const flagLine = "codex_hooks = true\n";

    if (configContent.includes("[features]")) {
      // Insert after [features] line
      configContent = configContent.replace("[features]", `[features]\n${flagLine}`);
    } else {
      configContent += featureBlock + flagLine;
    }
    await fs.writeFile(configPath, configContent, "utf-8");
  }

  return {
    ide: "codex",
    configured: true,
    filePath: hooksPath,
    details: hasGnosysHook
      ? "SessionStart hook already configured"
      : "Added SessionStart hook + enabled hooks feature flag",
  };
}

/**
 * Cursor: Write .cursor/rules/gnosys.mdc with alwaysApply: true
 * Cursor has no shell hooks, so we inject strong instructions for the AI to call Gnosys tools.
 */
export async function configureCursor(projectDir: string): Promise<IdeHookResult> {
  const rulesDir = path.join(projectDir, ".cursor", "rules");
  const rulePath = path.join(rulesDir, "gnosys.mdc");

  await fs.mkdir(rulesDir, { recursive: true });

  // Check if already exists
  let alreadyExists = false;
  try {
    await fs.stat(rulePath);
    alreadyExists = true;
  } catch {
    // Good — doesn't exist
  }

  const ruleContent = `---
description: Gnosys memory system — automatic recall and write
alwaysApply: true
---

# MANDATORY: Gnosys Memory Recall

**YOU MUST call \`gnosys_discover\` at the START of every task before doing any work.**
This is not optional. Gnosys contains project decisions, architecture, and context that prevents wasted effort.

## At task start (REQUIRED)
1. Call \`gnosys_discover\` with keywords relevant to the task
2. Call \`gnosys_read\` on any results that look relevant
3. Then proceed with the task using that context

## During work (automatic)
- When the user states a decision or preference — call \`gnosys_add\` to save it
- After significant implementation — call \`gnosys_add\` with findings and gotchas
- When the user says "remember", "save this", "note this" — call \`gnosys_add\`

## Key tools
| Action | Tool |
|--------|------|
| Find memories | \`gnosys_discover\` then \`gnosys_read\` |
| Search | \`gnosys_hybrid_search\` or \`gnosys_search\` |
| Write | \`gnosys_add\` or \`gnosys_add_structured\` |
| Update | \`gnosys_update\`, \`gnosys_reinforce\` |

**Always pass \`projectRoot\` set to the workspace root with every Gnosys tool call.**
`;

  if (!alreadyExists) {
    await fs.writeFile(rulePath, ruleContent, "utf-8");
  }

  return {
    ide: "cursor",
    configured: true,
    filePath: rulePath,
    details: alreadyExists
      ? "Cursor rule already exists at .cursor/rules/gnosys.mdc"
      : "Created alwaysApply rule for automatic memory recall instructions",
  };
}

// ─── Project Migration ──────────────────────────────────────────────────

export interface MigrateOptions {
  /** Directory that currently contains .gnosys/ */
  sourcePath: string;
  /** Directory to move .gnosys/ into */
  targetPath: string;
  /** New project name (default: basename of targetPath) */
  newName?: string;
  /** Remove the old .gnosys/ after successful copy */
  deleteSource?: boolean;
  /** Central DB instance for updating project registration */
  centralDb?: GnosysDB;
}

export interface MigrateResult {
  oldIdentity: ProjectIdentity;
  newIdentity: ProjectIdentity;
  memoryFileCount: number;
}

/**
 * Migrate a .gnosys/ store from one directory to another.
 *
 * Copies the entire .gnosys/ tree, updates gnosys.json with the new
 * working directory and project name, updates the central DB record,
 * and registers in the file-based project registry.
 */
export async function migrateProject(opts: MigrateOptions): Promise<MigrateResult> {
  const { sourcePath, targetPath, newName, deleteSource, centralDb } = opts;
  const resolvedSource = path.resolve(sourcePath);
  const resolvedTarget = path.resolve(targetPath);

  const sourceStore = path.join(resolvedSource, ".gnosys");
  const targetStore = path.join(resolvedTarget, ".gnosys");

  // 1. Verify source has .gnosys/
  try {
    await fs.stat(sourceStore);
  } catch {
    throw new Error(`No .gnosys/ directory found at ${resolvedSource}`);
  }

  // 2. Read existing identity
  const oldIdentity = await readProjectIdentity(resolvedSource);
  if (!oldIdentity) {
    throw new Error(`No valid gnosys.json found in ${sourceStore}`);
  }

  // 3. Verify target doesn't already have .gnosys/
  try {
    await fs.stat(targetStore);
    throw new Error(
      `Target already has a .gnosys/ directory at ${resolvedTarget}. ` +
      `Remove it first or choose a different target.`
    );
  } catch (err: unknown) {
    // Good — no .gnosys/ at target (stat threw ENOENT)
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err; // Re-throw our own "already exists" error
    }
  }

  // 4. Copy entire .gnosys/ tree from source to target
  const { execSync } = await import("child_process");
  execSync(`cp -a "${sourceStore}" "${targetStore}"`, { stdio: "pipe" });

  // 5. Count memory markdown files (for reporting)
  const { glob } = await import("glob");
  const memoryFiles = await glob("**/*.md", {
    cwd: targetStore,
    ignore: ["**/CHANGELOG.md", "**/MANIFEST.md", "**/.git/**", "**/.obsidian/**"],
  });

  // 6. Update gnosys.json in the new location
  const projectName = newName || path.basename(resolvedTarget);
  const now = new Date().toISOString();

  const newIdentity: ProjectIdentity = {
    ...oldIdentity,
    projectName,
    workingDirectory: resolvedTarget,
  };
  await writeProjectIdentity(resolvedTarget, newIdentity);

  // 7. Update central DB if available
  if (centralDb?.isAvailable()) {
    centralDb.updateProject(oldIdentity.projectId, {
      name: projectName,
      working_directory: resolvedTarget,
      modified: now,
    });
  }

  // 8. Register in file-based project registry
  const { GnosysResolver } = await import("./resolver.js");
  const resolver = new GnosysResolver();
  await resolver.registerProject(resolvedTarget);

  // 9. Add .gnosys/ to target's .gitignore if not already there
  try {
    const targetGitignore = path.join(resolvedTarget, ".gitignore");
    let gitignoreContent = "";
    try {
      gitignoreContent = await fs.readFile(targetGitignore, "utf-8");
    } catch {
      // No .gitignore yet
    }
    if (!gitignoreContent.includes(".gnosys")) {
      const entry = "\n# Gnosys memory store\n.gnosys/\n";
      await fs.writeFile(targetGitignore, gitignoreContent + entry, "utf-8");
    }
  } catch {
    // Non-critical
  }

  // 10. Delete source if requested
  if (deleteSource) {
    await fs.rm(sourceStore, { recursive: true, force: true });
  }

  return {
    oldIdentity,
    newIdentity,
    memoryFileCount: memoryFiles.length,
  };
}
