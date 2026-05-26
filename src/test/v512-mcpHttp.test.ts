/**
 * v5.12 Phase A/C — MCP Streamable HTTP transport.
 *
 * Exercises the HTTP layer directly with a minimal McpServer factory:
 * health probe, per-session tool listing, concurrent sessions, and the
 * bearer-token auth gate. Uses ephemeral ports (listen(0)).
 */

import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer, type McpHttpHandle } from "../lib/mcpHttp.js";

function makeServer(): McpServer {
  const s = new McpServer({ name: "test", version: "1.0.0" });
  s.tool("ping", "test ping tool", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
  return s;
}

let handle: McpHttpHandle | null = null;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients) { try { await c.close(); } catch { /* ignore */ } }
  clients.length = 0;
  if (handle) { await handle.close(); handle = null; }
});

async function start(opts: { authToken?: string } = {}): Promise<string> {
  handle = await startMcpHttpServer({ host: "127.0.0.1", port: 0, makeServer, authToken: opts.authToken });
  const port = (handle.server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

async function connect(base: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
  const c = new Client({ name: "test-client", version: "1.0.0" });
  await c.connect(transport);
  clients.push(c);
  return c;
}

describe("v5.12 MCP HTTP transport", () => {
  it("serves /health", async () => {
    const base = await start();
    const r = await fetch(base + "/health");
    expect(r.ok).toBe(true);
    expect((await r.json()).status).toBe("ok");
  });

  it("a client can connect and list tools over HTTP", async () => {
    const base = await start();
    const c = await connect(base);
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ping");
  });

  it("tracks concurrent sessions independently", async () => {
    const base = await start();
    await connect(base);
    await connect(base);
    const health = await (await fetch(base + "/health")).json();
    expect(health.sessions).toBe(2);
  });

  it("404s unknown paths", async () => {
    const base = await start();
    const r = await fetch(base + "/nope");
    expect(r.status).toBe(404);
  });

  it("returns 400 for a non-initialize POST without a session", async () => {
    const base = await start();
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("v5.12 MCP HTTP auth (Phase C)", () => {
  it("rejects requests without the bearer token", async () => {
    const base = await start({ authToken: "s3cret" });
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(r.status).toBe(401);
  });

  it("allows a client that presents the token", async () => {
    const base = await start({ authToken: "s3cret" });
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer s3cret" } },
    });
    const c = new Client({ name: "auth-client", version: "1.0.0" });
    await c.connect(transport);
    clients.push(c);
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("ping");
  });

  it("health probe is reachable without auth", async () => {
    const base = await start({ authToken: "s3cret" });
    const r = await fetch(base + "/health");
    expect(r.ok).toBe(true);
  });
});
