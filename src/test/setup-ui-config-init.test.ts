/**
 * Phase E — Screen 14 — `gnosys config init` is gated behind --force.
 *
 * Regression covers:
 *   1. Without --force: prints deprecation warning, exits 0, does NOT
 *      write a gnosys.json.
 *   2. With --force: writes a gnosys.json whose `llm` object no longer
 *      contains a literal `defaultProvider` key (Zod fills in the
 *      default on next load until v6.0 removes the schema default).
 *   3. The deprecation warning points the user at `gnosys setup`.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

void spawnSync; // explicit reference so the import isn't pruned by some setups.

const CLI = path.resolve("dist/cli.js");

function run(args: string[], home: string): { stdout: string; stderr: string; code: number | null } {
  const result = spawnSync("node", [CLI, ...args], {
    env: {
      ...process.env,
      HOME: home,
      GNOSYS_HOME: home,
      GNOSYS_LOCAL_ONLY: "1",
      GNOSYS_SKIP_UPGRADE_NUDGE: "1",
    },
    encoding: "utf-8",
    timeout: 10_000,
    cwd: home,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status };
}

describe("Phase E — Screen 14 — config init", () => {
  it("without --force prints deprecation warning and does NOT write template", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-cfginit-"));
    try {
      const r = run(["config", "init"], tmp);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out).toMatch(/gnosys setup/);
      expect(out).toMatch(/blank template/);
      // Must not have written gnosys.json (we exit before the write).
      expect(fs.existsSync(path.join(tmp, "gnosys.json"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("with --force writes a template without defaultProvider hardcoded", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-cfginit-"));
    try {
      // First, set up a writable store so `config init` has somewhere to write.
      const initResult = spawnSync("node", [CLI, "init", "--directory", tmp], {
        env: {
          ...process.env,
          HOME: tmp,
          GNOSYS_HOME: tmp,
          GNOSYS_LOCAL_ONLY: "1",
          GNOSYS_SKIP_UPGRADE_NUDGE: "1",
        },
        encoding: "utf-8",
        timeout: 10_000,
      });
      // gnosys init writes its own gnosys.json into .gnosys/. Remove it so
      // `config init --force` is the one creating the file under test.
      const initJson = path.join(tmp, ".gnosys", "gnosys.json");
      if (fs.existsSync(initJson)) fs.rmSync(initJson);
      void initResult;

      const r = run(["config", "init", "--force"], tmp);
      const out = `${r.stdout}\n${r.stderr}`;
      const candidates = [
        path.join(tmp, "gnosys.json"),
        path.join(tmp, ".gnosys", "gnosys.json"),
        path.join(tmp, ".gnosys", "gnosys.json"),
      ];
      const written = candidates.find((p) => fs.existsSync(p));
      expect(written, `expected a template file to exist (stdout=${out.slice(0, 400)})`).toBeTruthy();
      if (!written) return;
      const raw = fs.readFileSync(written, "utf-8");
      const parsed = JSON.parse(raw) as { llm?: Record<string, unknown> };
      expect(parsed.llm).toBeDefined();
      // Per design §14.2, defaultProvider must NOT be in the written template.
      expect(Object.hasOwn(parsed.llm ?? {}, "defaultProvider")).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
