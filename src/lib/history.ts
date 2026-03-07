/**
 * Gnosys History — Git-backed version history for individual memories.
 *
 * Every memory write/update auto-commits to git. This module exposes
 * that history: view what changed, when, and rollback to prior versions.
 */

import { execSync } from "child_process";
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

/**
 * Get the commit history for a specific memory file.
 */
export function getFileHistory(
  storePath: string,
  relativePath: string,
  limit: number = 20
): HistoryEntry[] {
  try {
    const output = execSync(
      `git log --follow --format="%H|%ai|%s" -n ${limit} -- "${relativePath}"`,
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
  try {
    return execSync(
      `git show ${commitHash}:"${relativePath}"`,
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
  try {
    return execSync(
      `git diff ${fromHash}..${toHash} -- "${relativePath}"`,
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
  try {
    // Restore file to its state at the target commit
    execSync(
      `git checkout ${commitHash} -- "${relativePath}"`,
      { cwd: storePath, stdio: "pipe" }
    );

    // Commit the rollback as a new commit
    execSync(
      `git add "${relativePath}" && git commit -m "Rollback ${relativePath} to ${commitHash.substring(0, 7)}"`,
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
    execSync("git rev-parse --git-dir", {
      cwd: storePath,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
