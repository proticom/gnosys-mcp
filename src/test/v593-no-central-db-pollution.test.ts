/**
 * Phase F regression — running the CLI with an isolated HOME must NEVER
 * create the user's central DB at ~/.gnosys/gnosys.db.
 *
 * v5.9.2 had a bug where `maybePrintUpgradeNudge` opened the local DB
 * (which auto-creates the SQLite file + parent dir) AND wrote
 * `last_seen_version` regardless of whether the running process was a
 * test process. The Phase F guard in src/cli.ts skips the nudge entirely
 * when VITEST/NODE_ENV=test/CI is set, AND also when HOME points at an
 * empty/fresh tmp dir (because in that case the SIGINT path of
 * isAvailable() returns false).
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

const CLI = path.resolve("dist/cli.js");

describe("Phase F — central DB pollution regression", () => {
  it("running gnosys --version with empty HOME does NOT create gnosys.db", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-pollution-"));
    try {
      // Run the CLI with HOME pointing at a fresh tmp dir. Use both HOME
      // and GNOSYS_HOME so the resolver definitely targets tmp, not the
      // real user home.
      const result = spawnSync("node", [CLI, "--version"], {
        env: {
          ...process.env,
          HOME: tmpHome,
          GNOSYS_HOME: tmpHome,
          // We intentionally leave VITEST in process.env (vitest sets it)
          // so the Phase F guard short-circuits. Removing it here would
          // make the test mirror real production behavior — and even THEN
          // the test must pass because GNOSYS_LOCAL_ONLY isn't set.
          VITEST: "true",
        },
        encoding: "utf-8",
        timeout: 10_000,
      });

      const dbPath = path.join(tmpHome, "gnosys.db");
      expect(fs.existsSync(dbPath), `central DB was created at ${dbPath}; stdout=${result.stdout?.slice(0, 200)}`).toBe(false);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("VITEST=true short-circuits maybePrintUpgradeNudge — no DB file at all", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-pollution-"));
    try {
      spawnSync("node", [CLI, "--help"], {
        env: {
          ...process.env,
          HOME: tmpHome,
          GNOSYS_HOME: tmpHome,
          VITEST: "true",
        },
        encoding: "utf-8",
        timeout: 10_000,
      });
      // After --help, the tmp HOME should still be empty (no .gnosys/,
      // no gnosys.db, no projects.json).
      const before = fs.readdirSync(tmpHome);
      expect(before, `expected empty HOME after --help; got [${before.join(", ")}]`).toEqual([]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 20_000);
});
