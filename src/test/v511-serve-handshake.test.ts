/**
 * Regression: `gnosys serve` must complete the MCP initialize handshake.
 *
 * `cli.ts` imports index.js but only `gnosys-mcp` (dist/index.js) used to
 * auto-call startMcpServer(); `gnosys serve` exited immediately → Codex/Cursor
 * saw "connection closed: initialize response".
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DIST_CLI = path.join(PROJECT_ROOT, "dist", "cli.js");

describe("gnosys serve MCP handshake", () => {
  let tmpHome: string;

  beforeAll(() => {
    if (!fs.existsSync(DIST_CLI)) {
      execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "pipe" });
    }
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-serve-handshake-"));
  }, 60_000);

  afterAll(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("connects and lists tools via node dist/cli.js serve", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: [DIST_CLI, "serve"],
      env: {
        ...process.env,
        HOME: tmpHome,
        GNOSYS_LOCAL_ONLY: "1",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "serve-handshake-test", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools?.length ?? 0).toBeGreaterThan(10);
    await client.close();
  }, 30_000);
});
