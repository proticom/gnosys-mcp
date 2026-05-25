/**
 * v5.12 HTTP auth guard — non-loopback binds require a bearer token.
 */

import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startMcpHttpServer, isLoopbackHost, type McpHttpHandle } from "../lib/mcpHttp.js";

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "1.0.0" });
}

let handle: McpHttpHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

describe("isLoopbackHost", () => {
  it("recognizes loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("rejects non-loopback hosts", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.50")).toBe(false);
    expect(isLoopbackHost("100.64.1.2")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
  });
});

describe("HTTP auth startup guard", () => {
  it("refuses non-loopback bind without a token", async () => {
    await expect(
      startMcpHttpServer({ host: "0.0.0.0", port: 0, makeServer }),
    ).rejects.toThrow(/Refusing to start/i);

    await expect(
      startMcpHttpServer({ host: "192.168.1.50", port: 0, makeServer }),
    ).rejects.toThrow(/Refusing to start/i);
  });

  it("allows loopback bind without a token", async () => {
    handle = await startMcpHttpServer({ host: "127.0.0.1", port: 0, makeServer });
    const port = (handle.server.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.ok).toBe(true);
  });

  it("allows non-loopback bind when a token is set", async () => {
    handle = await startMcpHttpServer({
      host: "0.0.0.0",
      port: 0,
      authToken: "test-secret",
      makeServer,
    });
    const port = (handle.server.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.ok).toBe(true);
  });
});
