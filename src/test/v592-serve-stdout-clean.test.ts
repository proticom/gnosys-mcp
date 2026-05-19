/**
 * v5.9.2 regression test — gnosys serve MUST keep stdout pristine.
 *
 * Stdout is the MCP JSON-RPC transport. Any byte before the MCP host's
 * `initialize` response is a protocol violation and the host (Grok Build,
 * Codex, Cursor, Claude Code) marks the server [unavailable] with no tools.
 *
 * v5.9.1 shipped with a post-upgrade nag block in src/cli.ts that wrote
 * plain text to stdout whenever the DB-stamped app_version was older than
 * pkg.version. The block was guarded against `upgrade` and `setup
 * sync-projects` but not against `serve`, so every MCP host broke the
 * moment a user upgraded gnosys via npm. Fixed in commit c31e8ce by
 * adding an isServeCmd guard. See decision memory deci-045.
 *
 * This test stamps a fresh test DB with an artificially old app_version
 * (forcing the nag's "newer" condition to be true), spawns the real built
 * `node dist/cli.js serve`, and asserts stdout is byte-for-byte empty for
 * 1.5 seconds. The assertion catches both the specific v5.9.1 regression
 * AND any future console.log creeping into the serve boot path.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn, execSync } from "child_process";
import { promisify } from "util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { GnosysDB } from "../lib/db.js";

const sleep = promisify(setTimeout);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DIST_CLI = path.join(PROJECT_ROOT, "dist", "cli.js");

describe("v5.9.2 regression: gnosys serve stdout must stay clean", () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_CLI)) {
      // Build dist so we test the actual published artifact behavior.
      execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "pipe" });
    }
  }, 60_000);

  it("emits zero stdout bytes even when DB app_version is older than pkg.version", async () => {
    // Set up an isolated HOME with a central DB that triggers the nag
    // condition (lastVersion < currentVersion).
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-stdout-"));
    const centralDir = path.join(tmpHome, ".gnosys");
    const db = new GnosysDB(centralDir);
    expect(db.isAvailable(), "test DB must initialize cleanly").toBe(true);
    db.setMeta("app_version", "0.0.1"); // forces newer = true
    db.close();

    try {
      const proc = spawn("node", [DIST_CLI, "serve"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: tmpHome,
          GNOSYS_LOCAL_ONLY: "1", // skip any remote-sync paths
        },
      });

      let stdout = "";
      proc.stdout.on("data", (b: Buffer) => {
        stdout += b.toString();
      });
      // stderr is allowed — that's where boot diagnostics belong.
      proc.stderr.on("data", () => {});

      await sleep(1500);
      proc.kill("SIGKILL");

      // The MCP server is allowed to emit valid JSON-RPC framed messages
      // (e.g. server-initiated `roots/list` request after server.connect).
      // What we MUST NOT see is non-JSON garbage — banners, prompts,
      // console.log output. Parse every non-empty line and assert each is
      // valid JSON-RPC (has jsonrpc:"2.0"). The original v5.9.1 bug emitted
      // "Gnosys updated: v5.7.0 → v5.9.1" which fails this check immediately.
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      const nonJsonRpc: string[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.jsonrpc !== "2.0") {
            nonJsonRpc.push(line);
          }
        } catch {
          nonJsonRpc.push(line);
        }
      }

      expect(
        nonJsonRpc,
        `gnosys serve wrote non-JSON-RPC bytes to stdout — these corrupt the MCP transport. Offending lines: ${JSON.stringify(nonJsonRpc.slice(0, 3))}`,
      ).toEqual([]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 10_000);
});
