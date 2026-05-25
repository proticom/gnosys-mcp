/**
 * v5.12 session isolation — concurrent clients have distinct, independent sessions.
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

async function conn(base: string) {
  const t = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
  const c = new Client({ name: "c", version: "1.0.0" });
  await c.connect(t);
  clients.push(c);
  return { c, t };
}

describe("v5.12 session isolation", () => {
  it("two concurrent sessions get distinct ids and are independent", async () => {
    handle = await startMcpHttpServer({ host: "127.0.0.1", port: 0, makeServer });
    const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
    const A = await conn(base);
    const B = await conn(base);

    expect(A.t.sessionId).toBeTruthy();
    expect(B.t.sessionId).toBeTruthy();
    expect(A.t.sessionId).not.toBe(B.t.sessionId);
    expect(handle.sessionCount()).toBe(2);

    await A.c.close();
    const bTools = await B.c.listTools();
    expect(bTools.tools.map((t) => t.name)).toContain("ping");
  });
});
