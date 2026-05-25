/**
 * v5.12 request body limits — oversized and slow-loris bodies are rejected.
 */

import http from "node:http";
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

async function start(opts: { maxBodyBytes?: number; bodyTimeoutMs?: number } = {}): Promise<number> {
  handle = await startMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: opts.maxBodyBytes,
    bodyTimeoutMs: opts.bodyTimeoutMs,
    makeServer: () => new McpServer({ name: "t", version: "1.0.0" }),
  });
  return (handle.server.address() as AddressInfo).port;
}

describe("v5.12 request body limits", () => {
  it("oversized body → 413", async () => {
    const port = await start({ maxBodyBytes: 1024 });
    const body = "x".repeat(2048);
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(r.status).toBe(413);
  });

  it("never-completing body → 408", async () => {
    const port = await start({ bodyTimeoutMs: 100 });
    const statusCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for 408")), 2000);
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "1000000",
          },
        },
        (res) => {
          clearTimeout(timer);
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.write('{"jsonrpc"');
    });
    expect(statusCode).toBe(408);
  });
});
