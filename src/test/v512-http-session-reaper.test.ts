/**
 * v5.12 idle session reaper — orphaned sessions are reclaimed after inactivity.
 */

import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer, type McpHttpHandle } from "../lib/mcpHttp.js";

function makeServer(): McpServer {
  const s = new McpServer({ name: "t", version: "1.0.0" });
  s.tool("ping", "p", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
  return s;
}

let handle: McpHttpHandle | null = null;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients) {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
  }
  clients.length = 0;
  if (handle) {
    await handle.close();
    handle = null;
  }
});

async function connect(): Promise<void> {
  const port = (handle!.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
  const client = new Client({ name: "c", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
}

describe("v5.12 idle session reaper", () => {
  it("reaps sessions idle beyond sessionIdleMs", async () => {
    handle = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      sessionIdleMs: 50,
      sweepIntervalMs: 60_000,
      makeServer,
    });
    await connect();
    expect(handle.sessionCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 60));
    expect(handle.reapIdleSessions(Date.now())).toBe(1);
    expect(handle.sessionCount()).toBe(0);
  });

  it("does not reap a recently active session", async () => {
    handle = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      sessionIdleMs: 50,
      sweepIntervalMs: 60_000,
      makeServer,
    });
    await connect();
    expect(handle.sessionCount()).toBe(1);

    expect(handle.reapIdleSessions()).toBe(0);
    expect(handle.sessionCount()).toBe(1);
  });
});
