/**
 * v5.12 bearer token contract — missing / wrong / correct.
 */

import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startMcpHttpServer, type McpHttpHandle } from "../lib/mcpHttp.js";

let handle: McpHttpHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

async function start(): Promise<string> {
  handle = await startMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    authToken: "s3cret",
    makeServer: () => new McpServer({ name: "t", version: "1.0.0" }),
  });
  return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}/mcp`;
}

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const CT = { "content-type": "application/json" };

describe("v5.12 bearer token (missing / wrong / correct)", () => {
  it("missing token → 401", async () => {
    const r = await fetch(await start(), { method: "POST", headers: CT, body: init });
    expect(r.status).toBe(401);
  });

  it("wrong token → 401", async () => {
    const r = await fetch(await start(), {
      method: "POST",
      headers: { ...CT, authorization: "Bearer WRONG" },
      body: init,
    });
    expect(r.status).toBe(401);
  });

  it("correct token → passes the auth gate (not 401)", async () => {
    const r = await fetch(await start(), {
      method: "POST",
      headers: {
        ...CT,
        accept: "application/json, text/event-stream",
        authorization: "Bearer s3cret",
      },
      body: init,
    });
    expect(r.status).not.toBe(401);
  });
});
