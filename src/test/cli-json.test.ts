import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-json-test-"));
  // Init a store so commands have something to work with
  execSync(`node ${path.resolve("dist/cli.js")} init --directory ${tmpDir}`, {
    stdio: "pipe",
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("CLI --json flag", () => {
  it("gnosys list --json outputs valid JSON", () => {
    const output = execSync(
      `node ${path.resolve("dist/cli.js")} list --json`,
      { encoding: "utf-8", env: { ...process.env, GNOSYS_PROJECT: tmpDir } }
    );
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("count");
    expect(parsed).toHaveProperty("memories");
    expect(Array.isArray(parsed.memories)).toBe(true);
  });

  it("gnosys stats --json outputs valid JSON", () => {
    const output = execSync(
      `node ${path.resolve("dist/cli.js")} stats --json`,
      { encoding: "utf-8", env: { ...process.env, GNOSYS_PROJECT: tmpDir } }
    );
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("totalCount");
  });

  it("gnosys projects --json outputs valid JSON", () => {
    const output = execSync(
      `node ${path.resolve("dist/cli.js")} projects --json`,
      { encoding: "utf-8" }
    );
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("count");
    expect(parsed).toHaveProperty("projects");
    expect(Array.isArray(parsed.projects)).toBe(true);
  });

  it("gnosys pref get --json outputs valid JSON with no prefs", () => {
    const output = execSync(
      `node ${path.resolve("dist/cli.js")} pref get --json`,
      { encoding: "utf-8" }
    );
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("preferences");
  });

  it("gnosys pref set + get --json round-trips", () => {
    execSync(
      `node ${path.resolve("dist/cli.js")} pref set test-key "test value"`,
      { stdio: "pipe" }
    );

    const output = execSync(
      `node ${path.resolve("dist/cli.js")} pref get test-key --json`,
      { encoding: "utf-8" }
    );
    const parsed = JSON.parse(output);
    expect(parsed.key).toBe("test-key");
    expect(parsed.value).toBe("test value");

    // Cleanup
    execSync(
      `node ${path.resolve("dist/cli.js")} pref delete test-key`,
      { stdio: "pipe" }
    );
  });
});
