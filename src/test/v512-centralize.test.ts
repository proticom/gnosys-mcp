/**
 * v5.12 Phase E — centralize: seed a central server's brain from a local one.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { centralizeDb } from "../lib/centralize.js";
import { GnosysDB } from "../lib/db.js";
import { createTestEnv, cleanupTestEnv, makeMemory, type TestEnv } from "./_helpers.js";

let env: TestEnv;
let target: string;

beforeEach(async () => {
  env = await createTestEnv("v512-central");
  target = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-central-to-"));
  fs.rmSync(target, { recursive: true, force: true }); // start absent
});
afterEach(async () => {
  await cleanupTestEnv(env);
  fs.rmSync(target, { recursive: true, force: true });
});

function sourceDb(): string {
  return path.join(env.tmpDir, "gnosys.db");
}

describe("v5.12 centralizeDb", () => {
  it("copies a consistent brain (with data) to the target", async () => {
    env.db.insertProject({
      id: "p1", name: "P", working_directory: "/x", user: "u",
      agent_rules_target: null, obsidian_vault: null,
      created: new Date().toISOString(), modified: new Date().toISOString(),
    });
    env.db.insertMemory(makeMemory({ id: "m1", title: "Seeded memory", project_id: "p1" }));

    const res = await centralizeDb({ to: target, sourceDb: sourceDb() });
    expect(res.target).toBe(path.join(target, "gnosys.db"));
    expect(res.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(res.target)).toBe(true);

    // The copy is a real, queryable brain with the data.
    const copy = new GnosysDB(target);
    expect(copy.getProject("p1")?.name).toBe("P");
    expect(copy.getMemory("m1")?.title).toBe("Seeded memory");
    copy.close();
  });

  it("refuses to overwrite an existing target without --force", async () => {
    await centralizeDb({ to: target, sourceDb: sourceDb() });
    await expect(centralizeDb({ to: target, sourceDb: sourceDb() })).rejects.toThrow(/already exists/);
  });

  it("overwrites with force", async () => {
    await centralizeDb({ to: target, sourceDb: sourceDb() });
    await expect(centralizeDb({ to: target, force: true, sourceDb: sourceDb() })).resolves.toBeTruthy();
  });

  it("throws when the source brain is missing", async () => {
    await expect(
      centralizeDb({ to: target, sourceDb: path.join(env.tmpDir, "nope.db") }),
    ).rejects.toThrow(/No local brain/);
  });
});
