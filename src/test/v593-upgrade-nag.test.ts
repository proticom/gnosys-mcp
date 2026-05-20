/**
 * Phase H — upgrade-nag direction + stderr + restart-instructions gate.
 *
 * The consolidated post-install nag now:
 *   - emits to stderr (was stdout pre-v5.9.3)
 *   - uses `upgraded` on upgrade, `reverted` on downgrade
 *   - only prints MCP-restart instructions on major-or-minor jumps
 *
 * The test sets up an isolated central DB, stamps `app_version` ahead
 * of / behind the running binary, then spawns `gnosys --help` and
 * verifies the stderr content.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import { fileURLToPath } from "url";

const CLI = path.resolve("dist/cli.js");

// Read pkg version once so we can stamp around it.
const PKG_VERSION = (() => {
  const pkgPath = path.resolve("package.json");
  const raw = fs.readFileSync(pkgPath, "utf-8");
  return (JSON.parse(raw) as { version: string }).version;
})();

// Bump a semver minor down/up for the test stamps.
function bumpSemver(v: string, dir: "down" | "up", level: "patch" | "minor"): string {
  const parts = v.split(".").map(Number);
  if (level === "patch") parts[2] = (parts[2] ?? 0) + (dir === "up" ? 1 : -1);
  if (level === "minor") {
    parts[1] = (parts[1] ?? 0) + (dir === "up" ? 1 : -1);
    parts[2] = 0;
  }
  return parts.join(".");
}

interface StampOpts {
  appVersion: string;
}

function stampVersion(home: string, opts: StampOpts): void {
  // Init a minimal central DB by spawning `gnosys init` in a project.
  spawnSync("node", [CLI, "init", "--directory", home], {
    env: {
      ...process.env,
      HOME: home,
      GNOSYS_HOME: home,
      GNOSYS_SKIP_UPGRADE_NUDGE: "1",
      VITEST: "true",
    },
    encoding: "utf-8",
    timeout: 10_000,
  });

  // Stamp app_version directly using GnosysDB.setMeta — it handles the
  // gnosys_meta.updated NOT-NULL constraint via the same code path the
  // CLI uses.
  const stampScript = `
    process.env.GNOSYS_HOME = ${JSON.stringify(home)};
    process.env.VITEST = "true";
    (async () => {
      const { GnosysDB } = await import("./dist/lib/db.js");
      const db = GnosysDB.openLocal();
      db.setMeta("app_version", ${JSON.stringify(opts.appVersion)});
      db.close();
    })();
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", stampScript], {
    cwd: path.resolve("."),
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`stampVersion failed: ${result.stderr ?? ""}`);
  }
}

function runCli(home: string, args: string[]): { stdout: string; stderr: string; code: number | null } {
  // We do NOT pass VITEST=true here — we want the upgrade-nag block to
  // execute its real path. We DO set GNOSYS_HOME / HOME so it operates
  // on our isolated DB.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VITEST;
  delete env.NODE_ENV;
  delete env.CI;
  env.HOME = home;
  env.GNOSYS_HOME = home;
  env.GNOSYS_SKIP_UPGRADE_NUDGE = ""; // not set, so it runs
  const r = spawnSync("node", [CLI, ...args], {
    env,
    encoding: "utf-8",
    timeout: 15_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status };
}

void fileURLToPath;

describe("Phase H — upgrade-nag consolidation", () => {
  it("upgrade (patch): emits `upgraded` on stderr, NO MCP-restart block", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-nag-up-"));
    try {
      const older = bumpSemver(PKG_VERSION, "down", "patch");
      stampVersion(home, { appVersion: older });
      const r = runCli(home, ["--help"]);
      expect(r.stderr).toMatch(/upgraded/);
      expect(r.stderr).toMatch(new RegExp(`v${older} . v${PKG_VERSION.replace(/\./g, "\\.")}`));
      // No MCP restart instructions on patch bump.
      expect(r.stderr).not.toMatch(/restart mcp/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("upgrade (minor): emits MCP-restart block", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-nag-minor-"));
    try {
      const older = bumpSemver(PKG_VERSION, "down", "minor");
      stampVersion(home, { appVersion: older });
      const r = runCli(home, ["--help"]);
      expect(r.stderr).toMatch(/upgraded/);
      expect(r.stderr).toMatch(/restart mcp/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("downgrade: emits `reverted` and the unintentional hint", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-nag-down-"));
    try {
      const newer = bumpSemver(PKG_VERSION, "up", "patch");
      stampVersion(home, { appVersion: newer });
      const r = runCli(home, ["--help"]);
      // Phase H spec: emit `reverted · vNEWER → vCURRENT` and the
      // "if this was unintentional" hint.
      expect(r.stderr).toMatch(/reverted/);
      expect(r.stderr).toMatch(/if this was unintentional/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("upgrade nag never writes to stdout", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-nag-stdout-"));
    try {
      const older = bumpSemver(PKG_VERSION, "down", "patch");
      stampVersion(home, { appVersion: older });
      const r = runCli(home, ["--version"]);
      // stdout should contain ONLY the version number, no nag noise.
      expect(r.stdout.trim()).toBe(PKG_VERSION);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
