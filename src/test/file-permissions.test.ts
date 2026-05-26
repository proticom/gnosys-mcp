/**
 * File permissions — secret-bearing paths must be owner-only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import { writeApiKey } from "../lib/setup.js";
import { GnosysDB } from "../lib/db.js";

const isWin32 = process.platform === "win32";

describe.skipIf(isWin32)("file permissions", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-perm-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("writeApiKey creates .env with mode 0600", async () => {
    await writeApiKey("anthropic", "sk-ant-test-key");
    const envPath = path.join(tmpHome, ".config", "gnosys", ".env");
    const mode = fsSync.statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("GnosysDB creates gnosys.db with mode 0600 and store dir 0700", () => {
    const storeDir = path.join(tmpHome, "gnosys-store");
    const db = new GnosysDB(storeDir);
    expect(db.isAvailable()).toBe(true);

    const dbPath = path.join(storeDir, "gnosys.db");
    const dbMode = fsSync.statSync(dbPath).mode & 0o777;
    const dirMode = fsSync.statSync(storeDir).mode & 0o777;
    expect(dbMode).toBe(0o600);
    expect(dirMode).toBe(0o700);

    db.close();
  });
});
