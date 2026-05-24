/**
 * Seed a central server's brain from a local one (v5.12 Phase E).
 *
 * When you move from local-stdio to the central-server topology, the new host
 * (a Docker volume, another machine) starts empty. `centralizeDb` makes a
 * CONSISTENT copy of this machine's `~/.gnosys/gnosys.db` into a target dir,
 * using SQLite's online backup API so it's safe even while the source is in use
 * (WAL is handled — no torn copy).
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { getCentralDbPath } from "./paths.js";

export interface CentralizeResult {
  source: string;
  target: string;
  bytes: number;
}

export async function centralizeDb(opts: {
  to: string;
  force?: boolean;
  /** Override the source DB file (defaults to this machine's central DB). */
  sourceDb?: string;
}): Promise<CentralizeResult> {
  const source = opts.sourceDb ?? getCentralDbPath();
  if (!fs.existsSync(source)) {
    throw new Error(`No local brain found at ${source}`);
  }
  const target = path.join(opts.to, "gnosys.db");
  if (fs.existsSync(target) && !opts.force) {
    throw new Error(`Target already exists: ${target} (use --force to overwrite)`);
  }
  fs.mkdirSync(opts.to, { recursive: true });

  // Online backup → a single consistent gnosys.db at the target (handles WAL).
  const db = new Database(source);
  try {
    await db.backup(target);
  } finally {
    db.close();
  }

  return { source, target, bytes: fs.statSync(target).size };
}
