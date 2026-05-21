/**
 * v5.9.5 — self-healing machine_id regression suite.
 *
 * v5.9.4 fixed the derivation (resolveHostname() falls back to os.hostname())
 * but didn't migrate the stale `unknown-<rand>` cache rows already persisted
 * in `gnosys_meta`. v5.9.5's `getMachineId()` now heals those cached values
 * (and any `dream_machine_id` pointing at the same broken id) the next time
 * it's called with a real hostname available.
 *
 * Pin process.env.HOSTNAME so the resolveHostname() path is deterministic
 * across dev and CI; pin to "" + use os.hostname() fallback for the
 * "still-unknown" branch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { GnosysDB } from "../lib/db.js";
import { getMachineId } from "../lib/remote.js";

const STALE_ID = "unknown-mp9cyh4j";
const ORIGINAL_HOSTNAME_ENV = process.env.HOSTNAME;
const ORIGINAL_COMPUTERNAME_ENV = process.env.COMPUTERNAME;

interface Env {
  dir: string;
  db: GnosysDB;
}

async function makeDb(): Promise<Env> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-v595-"));
  const db = new GnosysDB(dir);
  return { dir, db };
}

async function cleanup(env: Env): Promise<void> {
  env.db.close();
  await fsp.rm(env.dir, { recursive: true, force: true });
}

describe("v5.9.5 — self-healing machine_id", () => {
  beforeEach(() => {
    process.env.HOSTNAME = "EdsMacStudio";
    delete process.env.COMPUTERNAME;
  });

  afterEach(() => {
    if (ORIGINAL_HOSTNAME_ENV === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = ORIGINAL_HOSTNAME_ENV;
    if (ORIGINAL_COMPUTERNAME_ENV === undefined) delete process.env.COMPUTERNAME;
    else process.env.COMPUTERNAME = ORIGINAL_COMPUTERNAME_ENV;
  });

  it("heals a stale `unknown-<rand>` cache when a real hostname is available", async () => {
    const env = await makeDb();
    try {
      env.db.setMeta("machine_id", STALE_ID);
      const id = getMachineId(env.db);
      expect(id).not.toBe(STALE_ID);
      expect(id.startsWith("EdsMacStudio-")).toBe(true);
      expect(env.db.getMeta("machine_id")).toBe(id);
    } finally {
      await cleanup(env);
    }
  });

  it("heals a stale `dream_machine_id` pointing at the same broken cached id", async () => {
    const env = await makeDb();
    try {
      env.db.setMeta("machine_id", STALE_ID);
      env.db.setDreamMachineId(STALE_ID);
      const id = getMachineId(env.db);
      expect(id.startsWith("EdsMacStudio-")).toBe(true);
      expect(env.db.getDreamMachineId()).toBe(id);
    } finally {
      await cleanup(env);
    }
  });

  it("leaves a real cached id untouched (no churn)", async () => {
    const env = await makeDb();
    try {
      const realId = "EdsMacStudio-abc123";
      env.db.setMeta("machine_id", realId);
      const id = getMachineId(env.db);
      expect(id).toBe(realId);
      expect(env.db.getMeta("machine_id")).toBe(realId);
    } finally {
      await cleanup(env);
    }
  });

  it("leaves an unrelated `dream_machine_id` alone when machine_id heals", async () => {
    const env = await makeDb();
    try {
      env.db.setMeta("machine_id", STALE_ID);
      env.db.setDreamMachineId("OtherMachine-xyz789");
      const id = getMachineId(env.db);
      expect(id.startsWith("EdsMacStudio-")).toBe(true);
      // dream_machine_id pointed at a DIFFERENT machine — don't touch it.
      expect(env.db.getDreamMachineId()).toBe("OtherMachine-xyz789");
    } finally {
      await cleanup(env);
    }
  });

});
