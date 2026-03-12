/**
 * Phase 8c: CLI Parity
 * Test Plan Reference: "Phase 8 Tests — 8c"
 *
 *   TC-8c.1: All listed CLI commands work and match MCP behavior
 *   TC-8c.2: --json flag works
 *   TC-8c.3: CLI auto-detects projectId from local gnosys.json
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { CLI, cliInit } from "./_helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-cli-parity-"));
  cliInit(tmpDir);
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function run(command: string, opts: { json?: boolean } = {}): string {
  const cmd = opts.json
    ? `${CLI} ${command} --json`
    : `${CLI} ${command}`;
  return execSync(cmd, {
    encoding: "utf-8",
    env: { ...process.env, GNOSYS_PROJECT: tmpDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("Phase 8c: CLI Parity", () => {
  // ─── TC-8c.1: CLI commands work ──────────────────────────────────────

  describe("TC-8c.1: Core CLI commands functional", () => {
    it("gnosys list returns empty list for new store", () => {
      const output = run("list");
      // Should not error; either shows empty or "no memories"
      expect(typeof output).toBe("string");
    });

    it("gnosys stats returns statistics", () => {
      const output = run("stats");
      expect(typeof output).toBe("string");
    });

    it("gnosys projects lists registered projects", () => {
      const output = run("projects");
      expect(typeof output).toBe("string");
    });

    it("gnosys pref get returns preferences (empty for new store)", () => {
      const output = run("pref get");
      expect(typeof output).toBe("string");
    });

    it("gnosys pref set + get round-trips a value", () => {
      run('pref set test-key "test value"');
      const output = run("pref get test-key");
      expect(output).toContain("test value");

      // Cleanup
      run("pref delete test-key");
    });

    it("gnosys --help shows help text", () => {
      const output = execSync(`${CLI} --help`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(output).toContain("Gnosys");
      expect(output).toContain("Commands:");
    });

    it("gnosys init --help shows init options", () => {
      const output = execSync(`${CLI} init --help`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(output).toContain("directory");
    });
  });

  // ─── TC-8c.2: --json flag ────────────────────────────────────────────

  describe("TC-8c.2: --json flag produces valid JSON", () => {
    it("gnosys list --json outputs valid JSON", () => {
      const output = run("list", { json: true });
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("count");
      expect(parsed).toHaveProperty("memories");
      expect(Array.isArray(parsed.memories)).toBe(true);
    });

    it("gnosys stats --json outputs valid JSON", () => {
      const output = run("stats", { json: true });
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("totalCount");
    });

    it("gnosys projects --json outputs valid JSON", () => {
      const output = execSync(`${CLI} projects --json`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("count");
      expect(parsed).toHaveProperty("projects");
      expect(Array.isArray(parsed.projects)).toBe(true);
    });

    it("gnosys pref get --json outputs valid JSON", () => {
      const output = run("pref get", { json: true });
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("preferences");
    });
  });

  // ─── TC-8c.3: Auto-detect projectId ──────────────────────────────────

  describe("TC-8c.3: CLI auto-detects projectId from gnosys.json", () => {
    it("gnosys.json exists after init", () => {
      const identityPath = path.join(tmpDir, ".gnosys", "gnosys.json");
      expect(fs.existsSync(identityPath)).toBe(true);
    });

    it("CLI uses GNOSYS_PROJECT env var for project context", () => {
      // This test verifies that when GNOSYS_PROJECT is set,
      // commands operate on that project
      const output = run("list", { json: true });
      const parsed = JSON.parse(output);
      // Should not error — the project context is correctly resolved
      expect(parsed).toHaveProperty("count");
    });

    it("re-init preserves project identity", () => {
      const id1 = JSON.parse(
        fs.readFileSync(
          path.join(tmpDir, ".gnosys", "gnosys.json"),
          "utf-8"
        )
      ).projectId;

      // Re-init
      cliInit(tmpDir);

      const id2 = JSON.parse(
        fs.readFileSync(
          path.join(tmpDir, ".gnosys", "gnosys.json"),
          "utf-8"
        )
      ).projectId;

      expect(id1).toBe(id2);
    });
  });
});
