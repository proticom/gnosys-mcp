/**
 * Streamable HTTP transport for the Gnosys MCP server (v5.12 Phase A).
 *
 * Lets clients connect to a long-running gnosys server over HTTP instead of
 * spawning a local stdio process — the basis for the "central server" topology
 * (one host owns the brain; other machines point their IDE at the URL).
 *
 * Stateful sessions: each `initialize` mints a session id and gets its OWN
 * McpServer (built by `makeServer`), so concurrent clients don't share MCP
 * protocol state. The servers all reference the same module-global brain/search,
 * so there's no per-session data — only a fresh capability registration.
 *
 * Uses Node's built-in http (no express). The SDK's StreamableHTTPServerTransport
 * accepts a pre-parsed body, so we read+parse POST bodies ourselves.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface McpHttpOptions {
  host: string;
  port: number;
  /** MCP endpoint path. Default "/mcp". */
  path?: string;
  /** Build a fully-registered McpServer for a new session. */
  makeServer: () => Promise<McpServer> | McpServer;
  /** Phase C: require `Authorization: Bearer <token>` when set. */
  authToken?: string;
  log?: (msg: string) => void;
}

export interface McpHttpHandle {
  server: http.Server;
  /** Active session count (for tests/observability). */
  sessionCount: () => number;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function jsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Start the MCP Streamable HTTP server. Resolves once it is listening.
 */
export function startMcpHttpServer(opts: McpHttpOptions): Promise<McpHttpHandle> {
  const mcpPath = opts.path ?? "/mcp";
  const log = opts.log ?? (() => {});
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      log(`request error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Liveness probe — unauthenticated, no MCP involvement.
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessions: transports.size }));
      return;
    }

    if (url.pathname !== mcpPath) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }

    // Phase C: bearer auth (only enforced when a token is configured).
    if (opts.authToken) {
      if (req.headers["authorization"] !== `Bearer ${opts.authToken}`) {
        jsonRpcError(res, 401, -32001, "Unauthorized");
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const body = await readBody(req);
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (!isInitializeRequest(body)) {
          jsonRpcError(res, 400, -32000, "No valid session; send an initialize request first");
          return;
        }
        // New session: fresh server + transport.
        const server = await opts.makeServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports.set(sid, transport!);
            log(`session initialized: ${sid} (${transports.size} active)`);
          },
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid && transports.delete(sid)) log(`session closed: ${sid} (${transports.size} active)`);
        };
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        jsonRpcError(res, 400, -32000, "Missing or unknown session id");
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method not allowed");
  }

  return new Promise<McpHttpHandle>((resolve) => {
    httpServer.listen(opts.port, opts.host, () => {
      log(`listening on http://${opts.host}:${opts.port}${mcpPath}`);
      resolve({
        server: httpServer,
        sessionCount: () => transports.size,
        close: () =>
          new Promise<void>((r) => {
            for (const t of transports.values()) void t.close();
            transports.clear();
            httpServer.close(() => r());
          }),
      });
    });
  });
}
