/**
 * v5.12 CORS / Origin guard — default deny browser origins unless allowlisted.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startMcpHttpServer, type McpHttpHandle } from "../lib/mcpHttp.js";

let handle: McpHttpHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const CT = { "content-type": "application/json" };

async function start(allowedOrigins?: string[]): Promise<string> {
  handle = await startMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    allowedOrigins,
    makeServer: () => new McpServer({ name: "t", version: "1.0.0" }),
  });
  return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}/mcp`;
}

describe("v5.12 Origin guard", () => {
  it("disallowed Origin → 403", async () => {
    const url = await start();
    const r = await fetch(url, {
      method: "POST",
      headers: { ...CT, origin: "https://evil.example" },
      body: init,
    });
    expect(r.status).toBe(403);
  });

  it("no Origin header → not 403", async () => {
    const url = await start();
    const r = await fetch(url, { method: "POST", headers: CT, body: init });
    expect(r.status).not.toBe(403);
  });

  it("allowlisted Origin → not 403", async () => {
    const url = await start(["https://app.example"]);
    const r = await fetch(url, {
      method: "POST",
      headers: { ...CT, origin: "https://app.example" },
      body: init,
    });
    expect(r.status).not.toBe(403);
  });
});
