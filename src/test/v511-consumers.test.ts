/**
 * v5.11 — machine-aware consumer wiring.
 *
 * effectiveProjectPath fallback semantics + generateBriefing resolving the
 * project directory per-machine (with legacy fallback when no machine.json).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { effectiveProjectPath } from "../lib/projectPaths.js";
import { generateBriefing } from "../lib/federated.js";
import { type MachineConfig } from "../lib/machineConfig.js";
import { type DbProject } from "../lib/db.js";
import { createTestEnv, cleanupTestEnv, makeMemory, type TestEnv } from "./_helpers.js";

const STUDIO: MachineConfig = {
  machineId: "studio-id",
  hostname: "studio",
  roots: { dev: "/Users/edward/MSDev/projects" },
  remote: { enabled: false },
  schemaVersion: 1,
};

function mkProj(o: Partial<DbProject>): DbProject {
  const now = new Date().toISOString();
  return {
    id: "p", name: "P", working_directory: "", root_id: null, rel_path: null,
    user: "u", agent_rules_target: null, obsidian_vault: null, created: now, modified: now,
    ...o,
  };
}

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv("v511-consumers"); });
afterEach(async () => { await cleanupTestEnv(env); });

describe("v5.11 effectiveProjectPath fallback", () => {
  it("returns working_directory when no machine.json (legacy)", () => {
    const p = mkProj({ id: "p1", working_directory: "/Volumes/Dev/projects/x" });
    env.db.insertProject(p);
    expect(effectiveProjectPath(env.db, p, null)).toBe("/Volumes/Dev/projects/x");
  });

  it("resolves via root when machine is present", () => {
    const p = mkProj({ id: "p1", working_directory: "/stale/path", root_id: "dev", rel_path: "x" });
    env.db.insertProject(p);
    expect(effectiveProjectPath(env.db, p, STUDIO)).toBe("/Users/edward/MSDev/projects/x");
  });

  it("prefers an override over root resolution", () => {
    const p = mkProj({ id: "p1", root_id: "dev", rel_path: "x" });
    env.db.insertProject(p);
    env.db.setProjectLocation({ project_id: "p1", machine_id: "studio-id", abs_path: "/override/x", modified: new Date().toISOString() });
    expect(effectiveProjectPath(env.db, p, STUDIO)).toBe("/override/x");
  });

  it("returns null when unresolvable and working_directory doesn't exist here", () => {
    const p = mkProj({ id: "p1", working_directory: "/Volumes/gone", root_id: "work", rel_path: "x" });
    env.db.insertProject(p);
    expect(effectiveProjectPath(env.db, p, STUDIO)).toBeNull();
  });

  it("falls back to a legacy working_directory that exists on this disk", () => {
    // env.tmpDir is a real, existing directory.
    const p = mkProj({ id: "p1", working_directory: env.tmpDir });
    env.db.insertProject(p);
    expect(effectiveProjectPath(env.db, p, STUDIO)).toBe(env.tmpDir);
  });
});

describe("v5.11 generateBriefing uses machine-aware path", () => {
  it("resolves workingDirectory via the machine root", () => {
    env.db.insertProject(mkProj({ id: "p1", name: "gnosys-ai", working_directory: "/stale", root_id: "dev", rel_path: "gnosys-ai" }));
    env.db.insertMemory(makeMemory({ id: "m1", project_id: "p1", scope: "project" }));
    const b = generateBriefing(env.db, "p1", STUDIO);
    expect(b?.workingDirectory).toBe("/Users/edward/MSDev/projects/gnosys-ai");
  });

  it("reports '(not on this machine)' when unresolvable here", () => {
    env.db.insertProject(mkProj({ id: "p1", name: "x", working_directory: "/Volumes/gone", root_id: "work", rel_path: "x" }));
    env.db.insertMemory(makeMemory({ id: "m1", project_id: "p1", scope: "project" }));
    const b = generateBriefing(env.db, "p1", STUDIO);
    expect(b?.workingDirectory).toBe("(not on this machine)");
  });

  it("legacy: with no machine.json, falls back to working_directory", () => {
    env.db.insertProject(mkProj({ id: "p1", name: "x", working_directory: "/legacy/path" }));
    env.db.insertMemory(makeMemory({ id: "m1", project_id: "p1", scope: "project" }));
    const b = generateBriefing(env.db, "p1", null);
    expect(b?.workingDirectory).toBe("/legacy/path");
  });
});
