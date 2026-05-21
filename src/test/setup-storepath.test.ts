/**
 * Tests for the shared store-path resolver (v5.9.4 Bug 10).
 *
 * Verifies that `resolveActiveStorePath` and `ensureActiveStorePath`
 * return the project-level `.gnosys/` whenever its gnosys.json exists,
 * and fall back to the global home otherwise.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("setup/storePath — Phase B (Bug 10)", () => {
  const originalHome = process.env.GNOSYS_HOME;
  let tmpDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-storepath-"));
    fakeHome = path.join(tmpDir, "home", ".gnosys");
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.GNOSYS_HOME = fakeHome;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.GNOSYS_HOME;
    else process.env.GNOSYS_HOME = originalHome;
  });

  it("resolveActiveStorePath returns project store when gnosys.json exists there", async () => {
    const { resolveActiveStorePath } = await import("../lib/setup/storePath.js");
    const projectDir = path.join(tmpDir, "project");
    const projectStore = path.join(projectDir, ".gnosys");
    fs.mkdirSync(projectStore, { recursive: true });
    fs.writeFileSync(path.join(projectStore, "gnosys.json"), "{}\n");

    expect(resolveActiveStorePath(projectDir)).toBe(projectStore);
  });

  it("resolveActiveStorePath falls back to global home when no project config exists", async () => {
    const { resolveActiveStorePath } = await import("../lib/setup/storePath.js");
    const projectDir = path.join(tmpDir, "project-no-config");
    fs.mkdirSync(projectDir, { recursive: true });

    expect(resolveActiveStorePath(projectDir)).toBe(fakeHome);
  });

  it("resolveActiveStorePath does not create the global home if missing", async () => {
    const { resolveActiveStorePath } = await import("../lib/setup/storePath.js");
    const missingHome = path.join(tmpDir, "nonexistent-home", ".gnosys");
    process.env.GNOSYS_HOME = missingHome;
    const projectDir = path.join(tmpDir, "project-no-config");
    fs.mkdirSync(projectDir, { recursive: true });

    const resolved = resolveActiveStorePath(projectDir);
    expect(resolved).toBe(missingHome);
    expect(fs.existsSync(missingHome)).toBe(false);
  });

  it("ensureActiveStorePath creates the global home when no config exists", async () => {
    const { ensureActiveStorePath } = await import("../lib/setup/storePath.js");
    const missingHome = path.join(tmpDir, "ensure-home", ".gnosys");
    process.env.GNOSYS_HOME = missingHome;
    const projectDir = path.join(tmpDir, "project-fresh");
    fs.mkdirSync(projectDir, { recursive: true });

    const resolved = ensureActiveStorePath(projectDir);
    expect(resolved).toBe(missingHome);
    expect(fs.existsSync(missingHome)).toBe(true);
  });

  it("ensureActiveStorePath prefers the project store over the global home", async () => {
    const { ensureActiveStorePath } = await import("../lib/setup/storePath.js");
    const projectDir = path.join(tmpDir, "project-preferred");
    const projectStore = path.join(projectDir, ".gnosys");
    fs.mkdirSync(projectStore, { recursive: true });
    fs.writeFileSync(path.join(projectStore, "gnosys.json"), "{}\n");

    expect(ensureActiveStorePath(projectDir)).toBe(projectStore);
  });
});
