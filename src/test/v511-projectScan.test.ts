/**
 * v5.11 — project discovery scan.
 *
 * Verifies findProjectDirs (skips noise, finds nested) and scanProjects
 * (creates rows, records machine-portable root_id/rel_path, idempotent).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { findProjectDirs, scanProjects } from "../lib/projectScan.js";
import { type MachineConfig } from "../lib/machineConfig.js";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "./_helpers.js";

let env: TestEnv;
let root: string;

function makeFakeProject(dir: string, projectId: string, name: string): void {
  fs.mkdirSync(path.join(dir, ".gnosys"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".gnosys", "gnosys.json"),
    JSON.stringify({
      projectId,
      projectName: name,
      workingDirectory: dir,
      user: "edward",
      agentRulesTarget: "CLAUDE.md",
      obsidianVault: ".gnosys/vault",
      createdAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    }),
    "utf-8",
  );
}

beforeEach(async () => {
  env = await createTestEnv("v511-scan");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-scanroot-"));
});
afterEach(async () => {
  await cleanupTestEnv(env);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("v5.11 findProjectDirs", () => {
  it("finds projects, including nested ones, and skips noise dirs", async () => {
    makeFakeProject(path.join(root, "alpha"), "id-a", "alpha");
    makeFakeProject(path.join(root, "alpha", "nested"), "id-an", "nested");      // nested project
    makeFakeProject(path.join(root, "node_modules", "pkg"), "id-nm", "pkg");      // must be skipped
    fs.mkdirSync(path.join(root, "plain", "no-gnosys"), { recursive: true });     // not a project

    const dirs = await findProjectDirs(root);
    expect(dirs).toContain(path.join(root, "alpha"));
    expect(dirs).toContain(path.join(root, "alpha", "nested"));
    expect(dirs).not.toContain(path.join(root, "node_modules", "pkg"));
    expect(dirs.length).toBe(2);
  });
});

describe("v5.11 scanProjects", () => {
  const machine = (): MachineConfig => ({
    machineId: "studio-id",
    hostname: "studio",
    roots: { dev: root },
    remote: { enabled: false },
    schemaVersion: 1,
  });

  it("creates rows and records machine-portable root_id/rel_path", async () => {
    makeFakeProject(path.join(root, "gnosys-ai"), "id-gnosys", "gnosys-ai");
    makeFakeProject(path.join(root, "surprise", "defrag"), "id-defrag", "defrag-me");

    const result = await scanProjects(env.db, machine());
    expect(result.entries.length).toBe(2);
    expect(result.entries.every((e) => e.mode === "root")).toBe(true);
    expect(result.entries.every((e) => e.created)).toBe(true);

    const gnosys = env.db.getProject("id-gnosys");
    expect(gnosys?.root_id).toBe("dev");
    expect(gnosys?.rel_path).toBe("gnosys-ai");

    const defrag = env.db.getProject("id-defrag");
    expect(defrag?.rel_path).toBe(path.join("surprise", "defrag"));
  });

  it("is idempotent — a second scan creates nothing new", async () => {
    makeFakeProject(path.join(root, "p"), "id-p", "p");
    const first = await scanProjects(env.db, machine());
    expect(first.entries[0].created).toBe(true);

    const second = await scanProjects(env.db, machine());
    expect(second.entries.length).toBe(1);
    expect(second.entries[0].created).toBe(false);
    expect(second.entries[0].mode).toBe("root");
  });

  it("simulates two machines: same project, different roots, no clobber", async () => {
    makeFakeProject(path.join(root, "shared"), "id-shared", "shared");
    await scanProjects(env.db, machine()); // studio under `root`

    // A second machine with a different root absolute path scans the same
    // logical project (re-create the fixture under a different base path).
    const mbpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-mbproot-"));
    makeFakeProject(path.join(mbpRoot, "shared"), "id-shared", "shared");
    const mbp: MachineConfig = { machineId: "mbp-id", hostname: "mbp", roots: { dev: mbpRoot }, remote: { enabled: false }, schemaVersion: 1 };
    await scanProjects(env.db, mbp);

    // The shared project row carries machine-INDEPENDENT rel_path; both
    // machines resolve it against their own root. Only one project row exists.
    const proj = env.db.getProject("id-shared");
    expect(proj?.root_id).toBe("dev");
    expect(proj?.rel_path).toBe("shared");
    expect(env.db.getAllProjects().filter((p) => p.id === "id-shared").length).toBe(1);

    fs.rmSync(mbpRoot, { recursive: true, force: true });
  });
});
