/**
 * Gnosys History — Git-backed version history for individual memories.
 *
 * Every memory write/update auto-commits to git. This module exposes
 * that history: view what changed, when, and rollback to prior versions.
 */

import { execFileSync } from "child_process";
import path from "path";

export interface HistoryEntry {
  commitHash: string;
  date: string;       // ISO date string
  message: string;
}

export interface MemoryVersion {
  commitHash: string;
  date: string;
  message: string;
  content: string;    // Full file content at that commit
}

/** Validate a git commit hash (short or full, hex only). */
function isValidCommitHash(hash: string): boolean {
  return /^[a-f0-9]{4,40}$/i.test(hash);
}

/** Validate a relative path has no traversal or shell metacharacters. */
function isValidRelativePath(p: string): boolean {
  const resolved = path.resolve("/fake-root", p);
  return resolved.startsWith("/fake-root/") && !p.includes("\0");
}

/**
 * Get the commit history for a specific memory file.
 */
export function getFileHistory(
  storePath: string,
  relativePath: string,
  limit: number = 20
): HistoryEntry[] {
  if (!isValidRelativePath(relativePath)) return [];

  try {
    const output = execFileSync(
      "git",
      ["log", "--follow", `--format=%H|%ai|%s`, `-n`, String(limit), "--", relativePath],
      { cwd: storePath, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" }
    );

    if (!output.trim()) return [];

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commitHash, date, ...msgParts] = line.split("|");
        return {
          commitHash: commitHash.trim(),
          date: date.trim().split(" ")[0], // Just the date part
          message: msgParts.join("|").trim(),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Get the full file content at a specific commit.
 */
export function getFileAtCommit(
  storePath: string,
  relativePath: string,
  commitHash: string
): string | null {
  if (!isValidCommitHash(commitHash)) return null;
  if (!isValidRelativePath(relativePath)) return null;

  try {
    return execFileSync(
      "git",
      ["show", `${commitHash}:${relativePath}`],
      { cwd: storePath, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" }
    );
  } catch {
    return null;
  }
}

/**
 * Get a diff between two commits for a specific file.
 */
export function getFileDiff(
  storePath: string,
  relativePath: string,
  fromHash: string,
  toHash: string
): string | null {
  if (!isValidCommitHash(fromHash) || !isValidCommitHash(toHash)) return null;
  if (!isValidRelativePath(relativePath)) return null;

  try {
    return execFileSync(
      "git",
      ["diff", `${fromHash}..${toHash}`, "--", relativePath],
      { cwd: storePath, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" }
    );
  } catch {
    return null;
  }
}

/**
 * Rollback a memory to its state at a specific commit.
 * Creates a new commit with the reverted content (non-destructive).
 */
export function rollbackToCommit(
  storePath: string,
  relativePath: string,
  commitHash: string
): boolean {
  if (!isValidCommitHash(commitHash)) return false;
  if (!isValidRelativePath(relativePath)) return false;

  try {
    // Restore file to its state at the target commit
    execFileSync(
      "git",
      ["checkout", commitHash, "--", relativePath],
      { cwd: storePath, stdio: "pipe" }
    );

    // Stage the restored file
    execFileSync(
      "git",
      ["add", relativePath],
      { cwd: storePath, stdio: "pipe" }
    );

    // Commit the rollback as a new commit
    execFileSync(
      "git",
      ["commit", "-m", `Rollback ${relativePath} to ${commitHash.substring(0, 7)}`],
      { cwd: storePath, stdio: "pipe" }
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if git is available and the store has history.
 */
export function hasGitHistory(storePath: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: storePath,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
