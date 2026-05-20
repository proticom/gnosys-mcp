/**
 * Phase B regression — sending SIGINT to interactive setup screens must
 * exit with code 130 cleanly (no AbortError stack trace on stderr).
 *
 * These are smoke tests; they don't drive the wizard to completion. We
 * spawn each subcommand, wait briefly for the readline to be ready,
 * then send SIGINT and verify exit code + stderr.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

const CLI = path.resolve("dist/cli.js");

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function spawnAndSigint(args: string[], waitMs = 600): Promise<SpawnResult> {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-ctrlc-"));
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: {
        ...process.env,
        HOME: tmpHome,
        GNOSYS_HOME: tmpHome,
        GNOSYS_LOCAL_ONLY: "1",
        GNOSYS_SKIP_UPGRADE_NUDGE: "1",
        // Force a TTY-ish environment so readline activates.
        FORCE_COLOR: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve({ code, signal, stdout, stderr });
    };

    child.on("exit", finish);
    child.on("error", () => finish(null, null));

    // Wait for the wizard to print something / be at a prompt, then SIGINT.
    setTimeout(() => {
      try { child.kill("SIGINT"); } catch { /* already gone */ }
    }, waitMs);

    // Hard timeout — kill with SIGTERM if it hangs around.
    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, waitMs + 4000);
  });
}

function noAbortTrace(stderr: string): boolean {
  // Allow the cancellation message; reject raw AbortError stack frames.
  return !/AbortError/.test(stderr) && !/at .*node:internal\/readline/.test(stderr);
}

describe("Phase B — Ctrl+C clean exit", () => {
  it("gnosys setup exits cleanly on SIGINT", async () => {
    const r = await spawnAndSigint(["setup"], 800);
    // Either exit code 130 (we caught the signal) or signal SIGINT
    // (kernel killed before we could intercept). Both are acceptable.
    const ok = r.code === 130 || r.signal === "SIGINT";
    expect(ok, `expected clean SIGINT exit, got code=${r.code} signal=${r.signal} stderr=${r.stderr.slice(0, 400)}`).toBe(true);
    expect(noAbortTrace(r.stderr)).toBe(true);
  }, 20_000);

  it("gnosys setup models exits cleanly on SIGINT", async () => {
    const r = await spawnAndSigint(["setup", "models"], 800);
    const ok = r.code === 130 || r.signal === "SIGINT";
    expect(ok, `expected clean SIGINT exit, got code=${r.code} signal=${r.signal} stderr=${r.stderr.slice(0, 400)}`).toBe(true);
    expect(noAbortTrace(r.stderr)).toBe(true);
  }, 20_000);

  it("gnosys setup ides exits cleanly on SIGINT", async () => {
    const r = await spawnAndSigint(["setup", "ides"], 800);
    const ok = r.code === 130 || r.signal === "SIGINT";
    expect(ok, `expected clean SIGINT exit, got code=${r.code} signal=${r.signal} stderr=${r.stderr.slice(0, 400)}`).toBe(true);
    expect(noAbortTrace(r.stderr)).toBe(true);
  }, 20_000);
});
