/**
 * v5.11 — machine migration.
 *
 * Verifies migrateMachine moves machine-local values (machine_id, remote_path)
 * out of the synced gnosys_meta into machine.json, configures a root, scans,
 * and that deriveCommonRoot picks the most-common project parent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { migrateMachine, deriveCommonRoot } from "../lib/machineMigrate.js";
import { readMachineConfig } from "../lib/machineConfig.js";
import { getProjectRegistryPath } from "../lib/paths.js";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "./_helpers.js";

let env: TestEnv;
let configDir: string;
let root: string;
let prevConfigDir: string | undefined;

function makeFakeProject(dir: string, projectId: string, name: string): void {
  fs.mkdirSync(path.join(dir, ".gnosys"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".gnosys", "gnosys.json"),
    JSON.stringify({ projectId, projectName: name, workingDirectory: dir, user: "edward", agentRulesTarget: null, obsidianVault: ".gnosys/vault", createdAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1 }),
    "utf-8",
  );
}

beforeEach(async () => {
  env = await createTestEnv("v511-migrate");
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-migcfg-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-migroot-"));
  prevConfigDir = process.env.GNOSYS_CONFIG_DIR;
  process.env.GNOSYS_CONFIG_DIR = configDir;
});
afterEach(async () => {
  if (prevConfigDir === undefined) delete process.env.GNOSYS_CONFIG_DIR;
  else process.env.GNOSYS_CONFIG_DIR = prevConfigDir;
  await cleanupTestEnv(env);
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe("v5.11 migrateMachine", () => {
  it("moves machine_id + remote_path out of synced meta into machine.json and scans", async () => {
    // Seed the synced meta with machine-local values that shouldn't be there.
    env.db.setMeta("machine_id", "legacy-machine-7");
    env.db.setMeta("remote_path", "/Volumes/Remote/gnosys.db");
    makeFakeProject(path.join(root, "gnosys-ai"), "id-gnosys", "gnosys-ai");

    const res = await migrateMachine(env.db, { root });

    // meta values removed from the shared DB
    expect(env.db.getMeta("machine_id")).toBeNull();
    expect(env.db.getMeta("remote_path")).toBeNull();

    // adopted into machine.json
    expect(res.adoptedMachineId).toBe(true);
    expect(res.adoptedRemotePath).toBe(true);
    const cfg = readMachineConfig();
    expect(cfg?.machineId).toBe("legacy-machine-7");
    expect(cfg?.remote).toEqual({ enabled: true, path: "/Volumes/Remote/gnosys.db" });
    expect(cfg?.roots.dev).toBe(path.resolve(root));

    // scan registered the project with portable location
    expect(res.scan?.entries.length).toBe(1);
    expect(env.db.getProject("id-gnosys")?.root_id).toBe("dev");
    expect(env.db.getProject("id-gnosys")?.rel_path).toBe("gnosys-ai");
  });

  it("regenerates a machineId when no usable meta value exists", async () => {
    const res = await migrateMachine(env.db, { root, scan: false });
    expect(res.adoptedMachineId).toBe(false);
    expect(res.machineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readMachineConfig()?.machineId).toBe(res.machineId);
  });

  it("ignores stale 'unknown-*' meta machineIds", async () => {
    env.db.setMeta("machine_id", "unknown-abc123");
    const res = await migrateMachine(env.db, { root, scan: false });
    expect(res.adoptedMachineId).toBe(false);
    expect(res.machineId).not.toBe("unknown-abc123");
  });
});

describe("v5.11 deriveCommonRoot", () => {
  it("picks the directory that parents the most registered projects", () => {
    fs.writeFileSync(
      getProjectRegistryPath(),
      JSON.stringify([
        "/Users/edward/MSDev/projects/gnosys-ai",
        "/Users/edward/MSDev/projects/mavenn",
        "/Users/edward/MSDev/projects/paperboy",
        "/Users/edward/Documents/outlier",
        "/tmp/should-be-ignored",
        "/var/folders/xx/tmpproj",
      ]),
      "utf-8",
    );
    expect(deriveCommonRoot()).toBe("/Users/edward/MSDev/projects");
  });

  it("returns null when the registry has no usable entries", () => {
    fs.writeFileSync(getProjectRegistryPath(), JSON.stringify(["/tmp/x", "/var/folders/y"]), "utf-8");
    expect(deriveCommonRoot()).toBeNull();
  });
});
