/**
 * Phase 9a: Sandbox Foundation
 * Test Plan Reference: "Phase 9a — Sandbox Foundation"
 *
 *   TC-9a.1: Sandbox server handles all request methods
 *   TC-9a.2: Sandbox server handles invalid/malformed requests
 *   TC-9a.3: Sandbox client connects and round-trips
 *   TC-9a.4: Helper library generator creates valid file
 *   TC-9a.5: Add + Recall round-trip through sandbox
 *   TC-9a.6: Reinforce boosts confidence
 *   TC-9a.7: Sandbox manager start/stop lifecycle
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import net from "net";
import { GnosysDB } from "../lib/db.js";
import {
  handleRequest,
  startServer,
  getSandboxDir,
  getSocketPath,
  getPidPath,
  SandboxRequest,
  SandboxResponse,
} from "../sandbox/server.js";
import { SandboxClient } from "../sandbox/client.js";
import { generateHelper } from "../sandbox/helper-template.js";
import {
  createTestEnv,
  cleanupTestEnv,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase9a");
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

// ─── TC-9a.1: Server request handler ──────────────────────────────────────

describe("TC-9a.1: Sandbox server handles all request methods", () => {
  it("ping returns ok with pid", () => {
    const res = handleRequest(env.db, { id: "1", method: "ping", params: {} });
    expect(res.ok).toBe(true);
    expect(res.result).toHaveProperty("status", "ok");
    expect(res.result).toHaveProperty("pid");
  });

  it("add creates a memory and returns id + title", () => {
    const res = handleRequest(env.db, {
      id: "2",
      method: "add",
      params: {
        content: "We use TypeScript strict mode",
        title: "TypeScript convention",
        category: "decisions",
      },
    });
    expect(res.ok).toBe(true);
    const result = res.result as { id: string; title: string };
    expect(result.id).toMatch(/^mem-/);
    expect(result.title).toBe("TypeScript convention");
  });

  it("add with minimal params auto-generates title", () => {
    const res = handleRequest(env.db, {
      id: "3",
      method: "add",
      params: { content: "Short note about testing" },
    });
    expect(res.ok).toBe(true);
    const result = res.result as { id: string; title: string };
    expect(result.title).toBe("Short note about testing");
  });

  it("add without content returns error", () => {
    const res = handleRequest(env.db, {
      id: "4",
      method: "add",
      params: {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("content is required");
  });

  it("recall returns results for matching query", () => {
    // Add some memories first
    handleRequest(env.db, {
      id: "5a",
      method: "add",
      params: { content: "We use PostgreSQL for production databases", category: "decisions" },
    });
    handleRequest(env.db, {
      id: "5b",
      method: "add",
      params: { content: "Redis is used for caching layer", category: "architecture" },
    });

    const res = handleRequest(env.db, {
      id: "5c",
      method: "recall",
      params: { query: "database" },
    });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.result)).toBe(true);
  });

  it("recall without query returns error", () => {
    const res = handleRequest(env.db, {
      id: "6",
      method: "recall",
      params: {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("query is required");
  });

  it("get retrieves a specific memory", () => {
    const addRes = handleRequest(env.db, {
      id: "7a",
      method: "add",
      params: { content: "Test memory for get", title: "Get test" },
    });
    const memId = (addRes.result as { id: string }).id;

    const getRes = handleRequest(env.db, {
      id: "7b",
      method: "get",
      params: { id: memId },
    });
    expect(getRes.ok).toBe(true);
    expect(getRes.result).toHaveProperty("content", "Test memory for get");
  });

  it("get with invalid id returns error", () => {
    const res = handleRequest(env.db, {
      id: "8",
      method: "get",
      params: { id: "nonexistent-id" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  it("list returns memories", () => {
    handleRequest(env.db, {
      id: "9a",
      method: "add",
      params: { content: "Memory one", category: "decisions" },
    });
    handleRequest(env.db, {
      id: "9b",
      method: "add",
      params: { content: "Memory two", category: "architecture" },
    });

    const res = handleRequest(env.db, {
      id: "9c",
      method: "list",
      params: {},
    });
    expect(res.ok).toBe(true);
    const result = res.result as any[];
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("list filters by category", () => {
    handleRequest(env.db, {
      id: "10a",
      method: "add",
      params: { content: "Decision memory", category: "decisions" },
    });
    handleRequest(env.db, {
      id: "10b",
      method: "add",
      params: { content: "Architecture memory", category: "architecture" },
    });

    const res = handleRequest(env.db, {
      id: "10c",
      method: "list",
      params: { category: "decisions" },
    });
    expect(res.ok).toBe(true);
    const result = res.result as any[];
    expect(result.every((m: any) => m.category === "decisions")).toBe(true);
  });

  it("stats returns database statistics", () => {
    handleRequest(env.db, {
      id: "11a",
      method: "add",
      params: { content: "Stats test memory" },
    });

    const res = handleRequest(env.db, {
      id: "11b",
      method: "stats",
      params: {},
    });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result).toHaveProperty("active");
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("categories");
    expect(result.total).toBeGreaterThanOrEqual(1);
  });
});

// ─── TC-9a.2: Invalid/malformed requests ────────────────────────────────

describe("TC-9a.2: Sandbox server handles invalid requests", () => {
  it("unknown method returns error", () => {
    const res = handleRequest(env.db, {
      id: "20",
      method: "nonexistent",
      params: {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Unknown method");
  });

  it("response id matches request id", () => {
    const res = handleRequest(env.db, {
      id: "unique-test-id-42",
      method: "ping",
      params: {},
    });
    expect(res.id).toBe("unique-test-id-42");
  });
});

// ─── TC-9a.3: Client connection round-trip ──────────────────────────────

describe("TC-9a.3: Sandbox client round-trip via socket", () => {
  let server: net.Server;
  let socketPath: string;

  beforeEach(async () => {
    // Start a test server on a unique socket
    socketPath = path.join(env.tmpDir, "test.sock");

    server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line) as SandboxRequest;
            const res = handleRequest(env.db, req);
            socket.write(JSON.stringify(res) + "\n");
          } catch (err) {
            socket.write(JSON.stringify({
              id: "error",
              ok: false,
              error: `Invalid: ${err instanceof Error ? err.message : String(err)}`,
            }) + "\n");
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it("client can ping the server", async () => {
    const client = new SandboxClient(socketPath);
    const result = await client.ping();
    expect(result.status).toBe("ok");
    expect(typeof result.pid).toBe("number");
  });

  it("client can add and get a memory", async () => {
    const client = new SandboxClient(socketPath);
    const added = await client.add({
      content: "Client round-trip test memory",
      title: "Client test",
      category: "decisions",
    });
    expect(added.id).toMatch(/^mem-/);
    expect(added.title).toBe("Client test");

    const mem = await client.get(added.id);
    expect(mem).toHaveProperty("content", "Client round-trip test memory");
  });

  it("client can list memories", async () => {
    const client = new SandboxClient(socketPath);
    await client.add({ content: "List test one" });
    await client.add({ content: "List test two" });

    const list = await client.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("client can get stats", async () => {
    const client = new SandboxClient(socketPath);
    await client.add({ content: "Stats test" });

    const stats = await client.stats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
  });

  it("client isRunning returns true for running server", async () => {
    const client = new SandboxClient(socketPath);
    expect(await client.isRunning()).toBe(true);
  });

  it("client isRunning returns false for bad socket", async () => {
    const client = new SandboxClient("/tmp/nonexistent-gnosys-test.sock");
    expect(await client.isRunning()).toBe(false);
  });
});

// ─── TC-9a.4: Helper library generator ──────────────────────────────────

describe("TC-9a.4: Helper library generator creates valid file", () => {
  it("generates gnosys-helper.ts in the target directory", async () => {
    const outputPath = await generateHelper(env.tmpDir);
    expect(outputPath).toBe(path.join(env.tmpDir, "gnosys-helper.ts"));
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("generated file contains the gnosys export", async () => {
    await generateHelper(env.tmpDir);
    const content = fs.readFileSync(path.join(env.tmpDir, "gnosys-helper.ts"), "utf8");
    expect(content).toContain("export const gnosys");
    expect(content).toContain("async add(");
    expect(content).toContain("async recall(");
    expect(content).toContain("async reinforce(");
    expect(content).toContain("async list(");
    expect(content).toContain("async stats(");
    expect(content).toContain("export default gnosys");
  });

  it("generated file includes socket path logic", async () => {
    await generateHelper(env.tmpDir);
    const content = fs.readFileSync(path.join(env.tmpDir, "gnosys-helper.ts"), "utf8");
    expect(content).toContain("getSocketPath");
    expect(content).toContain(".gnosys");
  });

  it("generated file includes auto-start logic", async () => {
    await generateHelper(env.tmpDir);
    const content = fs.readFileSync(path.join(env.tmpDir, "gnosys-helper.ts"), "utf8");
    expect(content).toContain("ensureRunning");
    expect(content).toContain("gnosys sandbox start");
  });
});

// ─── TC-9a.5: Add + Recall round-trip ───────────────────────────────────

describe("TC-9a.5: Add + Recall round-trip through sandbox", () => {
  let server: net.Server;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = path.join(env.tmpDir, "roundtrip.sock");
    server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line) as SandboxRequest;
            const res = handleRequest(env.db, req);
            socket.write(JSON.stringify(res) + "\n");
          } catch { /* skip */ }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it("added memory can be recalled by content query", async () => {
    const client = new SandboxClient(socketPath);

    await client.add({
      content: "We decided to use PostgreSQL for all new services",
      title: "Database choice",
      category: "decisions",
    });

    const results = await client.recall("PostgreSQL");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The recall should find our memory
    const found = results.find((r) => r.title === "Database choice");
    expect(found).toBeDefined();
  });

  it("multiple adds and recall with limit", async () => {
    const client = new SandboxClient(socketPath);

    // Add 5 memories
    for (let i = 0; i < 5; i++) {
      await client.add({
        content: `Memory number ${i} about testing patterns and approaches`,
        category: "decisions",
      });
    }

    const results = await client.recall("testing patterns", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("add with project_id scopes the memory", async () => {
    const client = new SandboxClient(socketPath);

    await client.add({
      content: "Project-scoped memory for recall test",
      project_id: "proj-123",
      scope: "project",
    });

    const list = await client.list({ project_id: "proj-123" });
    expect(list.length).toBe(1);
    expect(list[0].project_id).toBe("proj-123");
  });
});

// ─── TC-9a.6: Reinforce boosts confidence ───────────────────────────────

describe("TC-9a.6: Reinforce boosts confidence", () => {
  it("reinforce increments count and confidence", () => {
    // Add a memory
    const addRes = handleRequest(env.db, {
      id: "r1",
      method: "add",
      params: { content: "Important pattern to reinforce", confidence: 0.8 },
    });
    const memId = (addRes.result as { id: string }).id;

    // Reinforce it
    const res = handleRequest(env.db, {
      id: "r2",
      method: "reinforce",
      params: { id: memId },
    });
    expect(res.ok).toBe(true);
    const result = res.result as { id: string; reinforcement_count: number; confidence: number };
    expect(result.reinforcement_count).toBe(1);
    expect(result.confidence).toBeCloseTo(0.85, 2);
  });

  it("reinforce by query finds and boosts the memory", () => {
    handleRequest(env.db, {
      id: "r3",
      method: "add",
      params: { content: "Unique findable reinforce target", confidence: 0.7 },
    });

    const res = handleRequest(env.db, {
      id: "r4",
      method: "reinforce",
      params: { query: "findable reinforce target" },
    });
    expect(res.ok).toBe(true);
    const result = res.result as { reinforcement_count: number; confidence: number };
    expect(result.reinforcement_count).toBe(1);
    expect(result.confidence).toBeCloseTo(0.75, 2);
  });

  it("reinforce caps confidence at 1.0", () => {
    const addRes = handleRequest(env.db, {
      id: "r5",
      method: "add",
      params: { content: "High confidence memory", confidence: 0.98 },
    });
    const memId = (addRes.result as { id: string }).id;

    // Reinforce twice
    handleRequest(env.db, { id: "r6", method: "reinforce", params: { id: memId } });
    const res = handleRequest(env.db, { id: "r7", method: "reinforce", params: { id: memId } });
    const result = res.result as { confidence: number };
    expect(result.confidence).toBeLessThanOrEqual(1.0);
  });
});

// ─── TC-9a.7: Sandbox paths and utilities ───────────────────────────────

describe("TC-9a.7: Sandbox path utilities", () => {
  it("getSandboxDir returns a path under ~/.gnosys", () => {
    const dir = getSandboxDir();
    expect(dir).toContain(".gnosys");
    expect(dir).toContain("sandbox");
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("getSocketPath returns platform-appropriate path", () => {
    const socketPath = getSocketPath();
    if (process.platform === "win32") {
      expect(socketPath).toContain("pipe");
    } else {
      expect(socketPath).toContain("gnosys.sock");
    }
  });

  it("getPidPath returns path under sandbox dir", () => {
    const pidPath = getPidPath();
    expect(pidPath).toContain("gnosys.pid");
    expect(pidPath).toContain("sandbox");
  });
});
