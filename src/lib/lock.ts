/**
 * Gnosys Lock — File-level locking for concurrent write safety.
 *
 * Prevents multiple agents (or agent + maintenance) from corrupting
 * active markdown files during simultaneous writes. Uses a simple
 * .gnosys/.config/write.lock file with PID tracking.
 *
 * Design: advisory lock with timeout + stale lock detection.
 */

import fs from "fs";
import path from "path";

const LOCK_FILENAME = "write.lock";
const LOCK_TIMEOUT_MS = 30_000; // 30 seconds max wait
const LOCK_POLL_MS = 50; // Poll every 50ms
const LOCK_STALE_MS = 120_000; // Consider lock stale after 2 minutes

interface LockInfo {
  pid: number;
  timestamp: number;
  operation: string;
}

/**
 * Acquire a write lock for the given store path.
 * Returns a release function that MUST be called when done.
 *
 * Usage:
 *   const release = await acquireWriteLock(storePath, "maintain");
 *   try {
 *     // ... do writes ...
 *   } finally {
 *     release();
 *   }
 */
export async function acquireWriteLock(
  storePath: string,
  operation: string = "write"
): Promise<() => void> {
  const configDir = path.join(storePath, ".config");
  const lockPath = path.join(configDir, LOCK_FILENAME);

  // Ensure .config dir exists
  try {
    fs.mkdirSync(configDir, { recursive: true });
  } catch {
    // Already exists
  }

  const startTime = Date.now();

  while (true) {
    // Try to acquire the lock
    try {
      // Check for existing lock
      const existing = readLock(lockPath);
      if (existing) {
        // Check if stale (PID dead or too old)
        if (isLockStale(existing)) {
          // Remove stale lock and retry
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Race condition — another process removed it
          }
        } else {
          // Lock is held by another process — wait
          if (Date.now() - startTime > LOCK_TIMEOUT_MS) {
            throw new Error(
              `Gnosys write lock timeout after ${LOCK_TIMEOUT_MS}ms. ` +
              `Lock held by PID ${existing.pid} for operation "${existing.operation}". ` +
              `If this is stale, delete ${lockPath}`
            );
          }

          await sleep(LOCK_POLL_MS);
          continue;
        }
      }

      // Write lock file atomically
      const lockInfo: LockInfo = {
        pid: process.pid,
        timestamp: Date.now(),
        operation,
      };

      // Use writeFileSync with exclusive flag for atomic creation
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo), { flag: "wx" });

      // Lock acquired — return release function
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Lock file already removed — that's fine
        }
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EEXIST") {
        // Another process created the lock between our check and write
        if (Date.now() - startTime > LOCK_TIMEOUT_MS) {
          throw new Error(
            `Gnosys write lock timeout after ${LOCK_TIMEOUT_MS}ms. ` +
            `Delete ${lockPath} if lock is stale.`
          );
        }
        await sleep(LOCK_POLL_MS);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Read the current lock info, or null if no lock exists.
 */
function readLock(lockPath: string): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Check if a lock is stale (PID dead or too old).
 */
function isLockStale(lock: LockInfo): boolean {
  // Check if lock is too old
  if (Date.now() - lock.timestamp > LOCK_STALE_MS) {
    return true;
  }

  // Check if PID is still alive
  try {
    process.kill(lock.pid, 0); // Signal 0 = check if process exists
    return false; // Process is alive
  } catch {
    return true; // Process is dead
  }
}

/**
 * Enable WAL mode on a better-sqlite3 database instance.
 * WAL (Write-Ahead Logging) allows concurrent reads during writes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function enableWAL(db: any): void {
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000"); // Wait up to 5s if DB is busy
  } catch {
    // WAL not supported or DB not available
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
