/**
 * Tests for project store routing — ensures the resolver picks the correct
 * project based on cwd, not just the first registered project.
 *
 * Regression test for the bug where findProjectStore() returned the first
 * entry in ~/.config/gnosys/projects.json regardless of the current directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { GnosysResolver } from "../lib/resolver.js";
import { GnosysStore } from "../lib/store.js";

// Generate random project names to avoid collisions
function randomName(): string {
  return `gnosys-test-${crypto.randomBytes(6).toString("hex")}`;
}

describe("Resolver project routing", () => {
  let projectA: string;
  let projectB: string;
  let originalCwd: string;
  let registryPath: string;
  let registryBackup: string | null = null;

  beforeEach(async () => {
    originalCwd = process.cwd();

    // Create two temp project directories with .gnosys stores
    projectA = path.join(os.tmpdir(), randomName());
    projectB = path.join(os.tmpdir(), randomName());

    for (const dir of [projectA, projectB]) {
      fs.mkdirSync(path.join(dir, ".gnosys"), { recursive: true });
      const store = new GnosysStore(path.join(dir, ".gnosys"));
      await store.init();
    }

    // Backup and clear the real project registry
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    registryPath = path.join(home, ".config", "gnosys", "projects.json");
    try {
      registryBackup = fs.readFileSync(registryPath, "utf-8");
    } catch {
      registryBackup = null;
    }
  });

  afterEach(async () => {
    process.chdir(originalCwd);

    // Restore the original project registry
    if (registryBackup !== null) {
      fs.writeFileSync(registryPath, registryBackup, "utf-8");
    } else {
      try {
        fs.unlinkSync(registryPath);
      } catch {
        // didn't exist before
      }
    }

    // Cleanup temp dirs
    await fsp.rm(projectA, { recursive: true, force: true });
    await fsp.rm(projectB, { recursive: true, force: true });
  });

  it("resolves to cwd project even when another project is registered first", async () => {
    // Register projectA first in the registry
    const resolverForReg = new GnosysResolver();
    await resolverForReg.registerProject(projectA);

    // Also register projectB
    await resolverForReg.registerProject(projectB);

    // Now cd into projectB and resolve
    process.chdir(projectB);
    const resolver = new GnosysResolver();
    await resolver.resolve();

    const writeTarget = resolver.getWriteTarget();
    expect(writeTarget).not.toBeNull();
    expect(writeTarget!.store.getStorePath()).toContain(
      path.basename(projectB)
    );
  });

  it("resolves to cwd project when only a different project is registered", async () => {
    // Register only projectA
    const resolverForReg = new GnosysResolver();
    await resolverForReg.registerProject(projectA);

    // cd into projectB (not registered, but has .gnosys/)
    process.chdir(projectB);
    const resolver = new GnosysResolver();
    await resolver.resolve();

    const writeTarget = resolver.getWriteTarget();
    expect(writeTarget).not.toBeNull();
    expect(writeTarget!.store.getStorePath()).toContain(
      path.basename(projectB)
    );
  });

  it("falls back to registered project when cwd has no store", async () => {
    // Write a clean registry with ONLY projectA
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify([projectA]), "utf-8");

    // Verify it's clean
    const resolverForReg = new GnosysResolver();
    await resolverForReg.registerProject(projectA);

    // cd to a directory with no .gnosys/
    const emptyDir = path.join(os.tmpdir(), randomName());
    fs.mkdirSync(emptyDir, { recursive: true });

    process.chdir(emptyDir);
    const resolver = new GnosysResolver();
    await resolver.resolve();

    const writeTarget = resolver.getWriteTarget();
    expect(writeTarget).not.toBeNull();
    expect(writeTarget!.store.getStorePath()).toContain(
      path.basename(projectA)
    );

    await fsp.rm(emptyDir, { recursive: true, force: true });
  });

  it("registerProject adds project to projects.json", async () => {
    // Clear registry
    try {
      fs.unlinkSync(registryPath);
    } catch {
      // ok
    }

    const resolver = new GnosysResolver();
    await resolver.registerProject(projectA);

    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    expect(registry).toContain(projectA);
  });

  it("registerProject is idempotent", async () => {
    const resolver = new GnosysResolver();
    await resolver.registerProject(projectA);
    await resolver.registerProject(projectA);

    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    const count = registry.filter((p: string) => p === projectA).length;
    expect(count).toBe(1);
  });
});
