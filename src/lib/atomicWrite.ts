/**
 * Atomic file writes — temp file in the same directory, then rename into place.
 */

import { promises as fsp } from "fs";
import * as fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

function tmpPathFor(dest: string): string {
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  return path.join(dir, `.${base}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
}

/** Atomically write `data` to `dest` (async). */
export async function atomicWriteFile(dest: string, data: string): Promise<void> {
  const tmp = tmpPathFor(dest);
  try {
    await fsp.writeFile(tmp, data, "utf-8");
    await fsp.rename(tmp, dest);
  } catch (err) {
    try {
      await fsp.unlink(tmp);
    } catch {
      // temp may not exist
    }
    throw err;
  }
}

/** Atomically write `data` to `dest` (sync). */
export function atomicWriteFileSync(dest: string, data: string): void {
  const tmp = tmpPathFor(dest);
  try {
    fs.writeFileSync(tmp, data, "utf-8");
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp may not exist
    }
    throw err;
  }
}
