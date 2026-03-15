/**
 * Gnosys Helper Library Generator
 *
 * Generates a self-contained `gnosys-helper.ts` file that agents
 * can import and use immediately — zero config, zero MCP overhead.
 *
 * The generated file connects to the sandbox server via Unix socket
 * and auto-starts the sandbox if it's not running.
 */

import fs from "fs";
import path from "path";
import { findProjectIdentity } from "../lib/projectIdentity.js";

/**
 * Generate the helper library source code.
 * This is a self-contained TypeScript file with no external deps
 * (other than Node built-ins).
 */
function generateHelperSource(projectId: string | null): string {
  return `/**
 * Gnosys Helper — Auto-generated agent helper library.
 *
 * Import this file in your agent/script to get instant access
 * to the Gnosys memory system with zero overhead.
 *
 * Usage:
 *   import { gnosys } from "./gnosys-helper";
 *   await gnosys.add("We use conventional commits");
 *   const ctx = await gnosys.recall("auth decisions");
 *   await gnosys.reinforce("payment logic");
 *
 * The sandbox auto-starts if not running. No MCP required.
 *
 * Generated: ${new Date().toISOString()}
 * Project: ${projectId || "(none — global scope)"}
 */

import net from "net";
import { execSync, spawn } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

// ─── Configuration ────────────────────────────────────────────────────────

const PROJECT_ID: string | null = ${projectId ? `"${projectId}"` : "null"};

function getSocketPath(): string {
  if (process.platform === "win32") return "\\\\\\\\.\\\\pipe\\\\gnosys-sandbox";
  const dir = path.join(os.homedir(), ".gnosys", "sandbox");
  return path.join(dir, "gnosys.sock");
}

// ─── Low-level transport ──────────────────────────────────────────────────

interface SandboxResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function send(method: string, params: Record<string, unknown> = {}): Promise<SandboxResponse> {
  return new Promise((resolve, reject) => {
    const id = \`req-\${Date.now()}-\${Math.random().toString(36).slice(2, 6)}\`;
    const socket = net.createConnection(getSocketPath(), () => {
      socket.write(JSON.stringify({ id, method, params }) + "\\n");
    });
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf("\\n");
      if (idx !== -1) {
        try {
          resolve(JSON.parse(buffer.slice(0, idx).trim()));
        } catch { reject(new Error("Invalid sandbox response")); }
        socket.end();
      }
    });
    socket.on("error", (err) => reject(err));
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error("Timeout")); });
  });
}

// ─── Auto-start ───────────────────────────────────────────────────────────

let _ensured = false;

async function ensureRunning(): Promise<void> {
  if (_ensured) return;
  try {
    await send("ping");
    _ensured = true;
    return;
  } catch {
    // Not running — start it
  }

  try {
    execSync("npx gnosys sandbox start", { stdio: "ignore", timeout: 10_000 });
  } catch {
    // Try direct node invocation as fallback
    const sandboxDir = path.join(os.homedir(), ".gnosys", "sandbox");
    fs.mkdirSync(sandboxDir, { recursive: true });
    const gnosysBin = execSync("which gnosys 2>/dev/null || echo ''", { encoding: "utf8" }).trim();
    if (gnosysBin) {
      execSync(\`\${gnosysBin} sandbox start\`, { stdio: "ignore", timeout: 10_000 });
    } else {
      throw new Error("Cannot auto-start sandbox. Run 'gnosys sandbox start' manually.");
    }
  }

  // Wait for socket to become available
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try { await send("ping"); _ensured = true; return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Sandbox started but not responding. Check ~/.gnosys/sandbox/sandbox.log");
}

// ─── Public API ───────────────────────────────────────────────────────────

export const gnosys = {
  /** Add a memory to the Gnosys brain */
  async add(content: string, opts?: {
    title?: string;
    category?: string;
    tags?: string[];
    scope?: "project" | "user" | "global";
  }): Promise<{ id: string; title: string }> {
    await ensureRunning();
    const res = await send("add", {
      content,
      ...opts,
      tags: opts?.tags ? JSON.stringify(opts.tags) : undefined,
      project_id: opts?.scope === "global" ? undefined : PROJECT_ID,
    });
    if (!res.ok) throw new Error(res.error || "add failed");
    return res.result as { id: string; title: string };
  },

  /** Recall memories relevant to a query */
  async recall(query: string, opts?: {
    limit?: number;
  }): Promise<Array<{
    id: string;
    title: string;
    content: string;
    category: string;
    confidence: number;
    score: number;
  }>> {
    await ensureRunning();
    const res = await send("recall", {
      query,
      limit: opts?.limit,
      project_id: PROJECT_ID,
    });
    if (!res.ok) throw new Error(res.error || "recall failed");
    return res.result as any[];
  },

  /** Reinforce a memory (boost its confidence and visibility) */
  async reinforce(idOrQuery: string): Promise<{
    id: string;
    reinforcement_count: number;
    confidence: number;
  }> {
    await ensureRunning();
    const isId = idOrQuery.startsWith("mem-") || /^[a-z]+-\\d+/.test(idOrQuery);
    const params = isId ? { id: idOrQuery } : { query: idOrQuery };
    const res = await send("reinforce", params);
    if (!res.ok) throw new Error(res.error || "reinforce failed");
    return res.result as any;
  },

  /** List memories (optionally filtered) */
  async list(opts?: {
    category?: string;
    limit?: number;
  }): Promise<Array<{
    id: string;
    title: string;
    category: string;
    confidence: number;
  }>> {
    await ensureRunning();
    const res = await send("list", {
      ...opts,
      project_id: PROJECT_ID,
    });
    if (!res.ok) throw new Error(res.error || "list failed");
    return res.result as any[];
  },

  /** Get database stats */
  async stats(): Promise<{
    active: number;
    archived: number;
    total: number;
    categories: string[];
    projects: number;
  }> {
    await ensureRunning();
    const res = await send("stats");
    if (!res.ok) throw new Error(res.error || "stats failed");
    return res.result as any;
  },

  /** Reflect on an outcome — updates confidence, adds relationships, creates a reflection memory */
  async reflect(outcome: string, opts?: {
    memory_ids?: string[];
    success?: boolean;
    notes?: string;
    confidence_delta?: number;
  }): Promise<{
    reflection_id: string;
    outcome: "success" | "failure";
    memories_updated: Array<{ id: string; confidence: number; reinforcement_count: number }>;
    relationships_created: number;
    confidence_delta: number;
  }> {
    await ensureRunning();
    const res = await send("reflect", {
      outcome,
      memory_ids: opts?.memory_ids ? JSON.stringify(opts.memory_ids) : undefined,
      success: opts?.success,
      notes: opts?.notes,
      confidence_delta: opts?.confidence_delta,
    });
    if (!res.ok) throw new Error(res.error || "reflect failed");
    return res.result as any;
  },

  /** Traverse relationship chains starting from a memory (BFS, depth-limited) */
  async traverse(id: string, opts?: {
    depth?: number;
    rel_types?: string[];
  }): Promise<{
    root: string;
    depth: number;
    nodes: Array<{
      id: string;
      title: string;
      category: string;
      confidence: number;
      depth: number;
      via_rel: string | null;
      via_from: string | null;
    }>;
    total: number;
  }> {
    await ensureRunning();
    const res = await send("traverse", {
      id,
      depth: opts?.depth,
      rel_types: opts?.rel_types ? JSON.stringify(opts.rel_types) : undefined,
    });
    if (!res.ok) throw new Error(res.error || "traverse failed");
    return res.result as any;
  },
};

export default gnosys;
`;
}

/**
 * Write the helper library file to the specified directory.
 */
export async function generateHelper(targetDir: string): Promise<string> {
  // Try to detect the project identity
  let projectId: string | null = null;
  try {
    const identity = await findProjectIdentity(targetDir);
    projectId = identity?.identity.projectId || null;
  } catch {
    // No project identity found — that's fine
  }

  const source = generateHelperSource(projectId);
  const outputPath = path.join(targetDir, "gnosys-helper.ts");

  fs.writeFileSync(outputPath, source, "utf8");
  return outputPath;
}
