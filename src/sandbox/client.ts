/**
 * Gnosys Sandbox Client
 *
 * Connects to the running sandbox server over a Unix domain socket
 * and provides typed async methods for all sandbox operations.
 */

import net from "net";
import { getSocketPath, SandboxRequest, SandboxResponse } from "./server.js";

export class SandboxClient {
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath || getSocketPath();
  }

  /**
   * Send a request to the sandbox server and wait for a response.
   * Each request gets a unique ID and is sent as newline-delimited JSON.
   */
  private send(method: string, params: Record<string, unknown> = {}): Promise<SandboxResponse> {
    return new Promise((resolve, reject) => {
      const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const req: SandboxRequest = { id, method, params };

      const socket = net.createConnection(this.socketPath, () => {
        socket.write(JSON.stringify(req) + "\n");
      });

      let buffer = "";

      socket.on("data", (data) => {
        buffer += data.toString();
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          try {
            const res = JSON.parse(line) as SandboxResponse;
            socket.end();
            resolve(res);
          } catch (err) {
            socket.end();
            reject(new Error(`Invalid response from sandbox: ${line}`));
          }
        }
      });

      socket.on("error", (err) => {
        reject(new Error(
          `Cannot connect to Gnosys sandbox at ${this.socketPath}. ` +
          `Is the sandbox running? Start it with: gnosys sandbox start\n` +
          `(${err.message})`
        ));
      });

      socket.setTimeout(10_000, () => {
        socket.destroy();
        reject(new Error("Sandbox request timed out after 10 seconds"));
      });
    });
  }

  /** Check if the sandbox is reachable */
  async ping(): Promise<{ status: string; pid: number }> {
    const res = await this.send("ping");
    if (!res.ok) throw new Error(res.error || "Ping failed");
    return res.result as { status: string; pid: number };
  }

  /** Add a new memory to the central database */
  async add(params: {
    content: string;
    title?: string;
    category?: string;
    project_id?: string;
    scope?: "project" | "user" | "global";
    tags?: string | string[];
    relevance?: string;
    author?: string;
    authority?: string;
    confidence?: number;
  }): Promise<{ id: string; title: string }> {
    const res = await this.send("add", {
      ...params,
      tags: Array.isArray(params.tags) ? JSON.stringify(params.tags) : params.tags,
    });
    if (!res.ok) throw new Error(res.error || "Add failed");
    return res.result as { id: string; title: string };
  }

  /** Search/recall memories by query */
  async recall(query: string, opts?: {
    limit?: number;
    project_id?: string;
  }): Promise<Array<{
    id: string;
    title: string;
    content: string;
    category: string;
    confidence: number;
    score: number;
  }>> {
    const res = await this.send("recall", { query, ...opts });
    if (!res.ok) throw new Error(res.error || "Recall failed");
    return res.result as any[];
  }

  /** Reinforce an existing memory (boost confidence) */
  async reinforce(idOrQuery: string): Promise<{
    id: string;
    reinforcement_count: number;
    confidence: number;
  }> {
    // If it looks like a memory ID, pass as id; otherwise treat as query
    const isId = idOrQuery.startsWith("mem-") || idOrQuery.match(/^[a-z]+-\d+/);
    const params = isId ? { id: idOrQuery } : { query: idOrQuery };
    const res = await this.send("reinforce", params);
    if (!res.ok) throw new Error(res.error || "Reinforce failed");
    return res.result as any;
  }

  /** Get a specific memory by ID */
  async get(id: string): Promise<Record<string, unknown>> {
    const res = await this.send("get", { id });
    if (!res.ok) throw new Error(res.error || "Get failed");
    return res.result as Record<string, unknown>;
  }

  /** List memories, optionally filtered by category or project */
  async list(opts?: {
    category?: string;
    project_id?: string;
    limit?: number;
  }): Promise<Array<{
    id: string;
    title: string;
    category: string;
    confidence: number;
    project_id: string | null;
    scope: string;
  }>> {
    const res = await this.send("list", opts || {});
    if (!res.ok) throw new Error(res.error || "List failed");
    return res.result as any[];
  }

  /** Get database statistics */
  async stats(): Promise<{
    active: number;
    archived: number;
    total: number;
    categories: string[];
    projects: number;
  }> {
    const res = await this.send("stats");
    if (!res.ok) throw new Error(res.error || "Stats failed");
    return res.result as any;
  }

  /** Gracefully shut down the sandbox server */
  async shutdown(): Promise<void> {
    try {
      await this.send("shutdown");
    } catch {
      // Server may close before we get the response — that's expected
    }
  }

  /** Check if the sandbox is running (non-throwing) */
  async isRunning(): Promise<boolean> {
    try {
      await this.ping();
      return true;
    } catch {
      return false;
    }
  }
}
