import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-init-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("gnosys init", () => {
  it("creates .gnosys store directory", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const storePath = path.join(tmpDir, ".gnosys");
    const stat = await fs.stat(storePath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates .gnosys/.config internal config directory", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const internalDir = path.join(tmpDir, ".gnosys", ".config");
    const stat = await fs.stat(internalDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("does NOT create a nested .gnosys/.gnosys", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const badNested = path.join(tmpDir, ".gnosys", ".gnosys");
    await expect(fs.stat(badNested)).rejects.toThrow();
  });

  it("places tags.json inside .gnosys/.config (internal config)", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const tagsPath = path.join(tmpDir, ".gnosys", ".config", "tags.json");
    const raw = await fs.readFile(tagsPath, "utf-8");
    const tags = JSON.parse(raw);
    expect(tags).toHaveProperty("domain");
    expect(tags).toHaveProperty("type");
    expect(tags).toHaveProperty("concern");
    expect(tags).toHaveProperty("status_tag");
  });

  it("does NOT place tags.json at .gnosys root", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const wrongPath = path.join(tmpDir, ".gnosys", "tags.json");
    await expect(fs.stat(wrongPath)).rejects.toThrow();
  });

  it("creates CHANGELOG.md at store root", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const changelogPath = path.join(tmpDir, ".gnosys", "CHANGELOG.md");
    const content = await fs.readFile(changelogPath, "utf-8");
    expect(content).toContain("# Gnosys Changelog");
    expect(content).toContain("Store initialized");
  });

  it("initializes a git repository", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const gitDir = path.join(tmpDir, ".gnosys", ".git");
    const stat = await fs.stat(gitDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates an initial git commit", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const log = execSync("git log --oneline", {
      cwd: path.join(tmpDir, ".gnosys"),
      encoding: "utf-8",
    });
    expect(log).toContain("Initialize Gnosys store");
  });

  it("re-syncs if .gnosys already exists (no error)", () => {
    // First init
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    // Second init should succeed (re-sync, not fail)
    const output = execSync(
      `node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`,
      { encoding: "utf-8" }
    );
    expect(output).toContain("re-synced");
  });

  it("outputs helpful instructions", () => {
    const output = execSync(
      `node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`,
      { encoding: "utf-8" }
    );

    expect(output).toContain("Gnosys store");
    expect(output).toContain("gnosys add");
  });

  it("creates gnosys.json project identity file", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const identityPath = path.join(tmpDir, ".gnosys", "gnosys.json");
    const raw = await fs.readFile(identityPath, "utf-8");
    const identity = JSON.parse(raw);
    expect(identity).toHaveProperty("projectId");
    expect(identity).toHaveProperty("projectName");
    expect(identity).toHaveProperty("workingDirectory");
    expect(identity.workingDirectory).toBe(tmpDir);
  });

  it("generates stable projectId on re-init", async () => {
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const identityPath = path.join(tmpDir, ".gnosys", "gnosys.json");
    const raw1 = await fs.readFile(identityPath, "utf-8");
    const id1 = JSON.parse(raw1).projectId;

    // Re-init
    execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
      stdio: "pipe",
    });

    const raw2 = await fs.readFile(identityPath, "utf-8");
    const id2 = JSON.parse(raw2).projectId;

    expect(id1).toBe(id2);
  });
});
