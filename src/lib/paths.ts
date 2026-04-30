/**
 * Gnosys path resolution — single source of truth for where gnosys stores
 * its per-user data. Imports nothing native (no better-sqlite3) so it can
 * be statically imported from any module, including ones that load before
 * the database layer.
 *
 * The gnosys home directory holds:
 *   - gnosys.db           (central database)
 *   - gnosys.json         (global config / project identity defaults)
 *   - sandbox/            (sandbox runtime socket and helper)
 *   - any future per-user artifacts
 *
 * Resolution order:
 *   1. GNOSYS_HOME env var (absolute path to the directory itself)
 *   2. ~/.gnosys (default — uses HOME or USERPROFILE)
 *
 * GNOSYS_HOME lets tests redirect everything gnosys-owned to a tmpdir
 * without polluting the user's real ~/.gnosys/. Setting it in production
 * also lets advanced users move their data to a different location.
 *
 * Every caller that constructs a path under the gnosys home MUST use
 * `getGnosysHome()` (or one of the convenience helpers below). Do not
 * reproduce the `path.join(os.homedir(), ".gnosys")` pattern inline.
 */

import path from "path";

export function getGnosysHome(): string {
  if (process.env.GNOSYS_HOME) return process.env.GNOSYS_HOME;
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return path.join(home, ".gnosys");
}

/** Path to the central SQLite DB file. */
export function getCentralDbPath(): string {
  return path.join(getGnosysHome(), "gnosys.db");
}

/** Path to the global gnosys.json config file. */
export function getGlobalConfigPath(): string {
  return path.join(getGnosysHome(), "gnosys.json");
}

/** Path to the sandbox runtime directory (socket + helper template live here). */
export function getSandboxDir(): string {
  return path.join(getGnosysHome(), "sandbox");
}
