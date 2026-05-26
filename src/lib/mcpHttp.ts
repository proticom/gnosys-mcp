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
  /** Reap sessions idle longer than this (ms). Default 30 min. */
  sessionIdleMs?: number;
  /** Sweep cadence (ms). Default 60s. */
  sweepIntervalMs?: number;
  /** Browser origins explicitly allowed to call the endpoint. Default: none. */
  allowedOrigins?: string[];
  /** Max request body bytes. Default 4 MiB. */
  maxBodyBytes?: number;
  /** Max ms to fully receive a request body. Default 30s. */
  bodyTimeoutMs?: number;
}

export interface McpHttpHandle {
  server: http.Server;
  /** Active session count (for tests/observability). */
  sessionCount: () => number;
  /** Close+remove sessions idle beyond sessionIdleMs. Returns count reaped. */
  reapIdleSessions: (now?: number) => number;
  close: () => Promise<void>;
}

/** True when the bind host is loopback-only (token optional). */
export function isLoopbackHost(host: string): boolean {
  const h = (host || "").trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

class HttpBodyError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage, maxBytes: number, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => done(() => {
        reject(new HttpBodyError(408, "Request body timeout"));
      }),
      timeoutMs,
    );
    if (typeof timer.unref === "function") timer.unref();
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        done(() => {
          reject(new HttpBodyError(413, "Payload too large"));
        });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () =>
      done(() => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      }),
    );
    req.on("error", (e) => done(() => reject(e)));
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
  if (!isLoopbackHost(opts.host) && !opts.authToken) {
    return Promise.reject(
      new Error(
        `Refusing to start: HTTP transport is binding to a non-loopback address ` +
        `(${opts.host}) without an auth token. Anyone who can reach this address ` +
        `would get unauthenticated access to your memory. Set --token <token> ` +
        `(or GNOSYS_SERVE_TOKEN), or bind to 127.0.0.1.`,
      ),
    );
  }

  const mcpPath = opts.path ?? "/mcp";
  const log = opts.log ?? (() => {});
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lastSeen = new Map<string, number>();
  const idleMs = opts.sessionIdleMs ?? 30 * 60 * 1000;
  const sweepMs = opts.sweepIntervalMs ?? 60 * 1000;
  const maxBodyBytes = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? 30_000;
  const touch = (sid: string) => lastSeen.set(sid, Date.now());

  function reapIdle(now = Date.now()): number {
    let reaped = 0;
    for (const [sid, t] of transports) {
      if (now - (lastSeen.get(sid) ?? now) > idleMs) {
        void t.close();
        lastSeen.delete(sid);
        reaped++;
      }
    }
    return reaped;
  }

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      log(`request error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
    });
  });
  httpServer.headersTimeout = 15_000;
  httpServer.requestTimeout = 60_000;

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

    // CORS default-deny: browsers send Origin on cross-origin calls; IDE/CLI clients do not.
    const origin = req.headers["origin"] as string | undefined;
    if (origin && !(opts.allowedOrigins ?? []).includes(origin)) {
      jsonRpcError(res, 403, -32001, "Origin not allowed");
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
      let body: unknown;
      try {
        body = await readBody(req, maxBodyBytes, bodyTimeoutMs);
      } catch (e) {
        if (e instanceof HttpBodyError) {
          jsonRpcError(res, e.statusCode, -32000, e.message);
          req.destroy();
          return;
        }
        jsonRpcError(res, 400, -32700, "Parse error");
        req.destroy();
        return;
      }
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
            touch(sid);
            log(`session initialized: ${sid} (${transports.size} active)`);
          },
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) lastSeen.delete(sid);
          if (sid && transports.delete(sid)) log(`session closed: ${sid} (${transports.size} active)`);
        };
        await server.connect(transport);
      } else if (sessionId) {
        touch(sessionId);
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
      if (sessionId) touch(sessionId);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method not allowed");
  }

  return new Promise<McpHttpHandle>((resolve) => {
    httpServer.listen(opts.port, opts.host, () => {
      log(`listening on http://${opts.host}:${opts.port}${mcpPath}`);
      const sweep = setInterval(() => reapIdle(), sweepMs);
      sweep.unref();
      resolve({
        server: httpServer,
        sessionCount: () => transports.size,
        reapIdleSessions: (now?: number) => reapIdle(now),
        close: () =>
          new Promise<void>((r) => {
            clearInterval(sweep);
            for (const t of transports.values()) void t.close();
            transports.clear();
            lastSeen.clear();
            httpServer.close(() => r());
          }),
      });
    });
  });
}
