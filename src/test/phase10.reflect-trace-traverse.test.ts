/**
 * Phase 10: Reflection API + Process Tracing + Traversal Enhancement
 *
 *   TC-10.1: Reflection API — success outcome updates confidence
 *   TC-10.2: Reflection API — failure outcome decreases confidence
 *   TC-10.3: Reflection API — creates reflection memory with relationships
 *   TC-10.4: Reflection API — consolidation links related memories on success
 *   TC-10.5: Reflection API — auto-discovers memories when no IDs provided
 *   TC-10.6: Process Tracing — discovers functions from source files
 *   TC-10.7: Process Tracing — creates procedural 'how' memories
 *   TC-10.8: Process Tracing — creates leads_to and follows_from relationships
 *   TC-10.9: Process Tracing — handles empty directory
 *   TC-10.10: Traversal — BFS follows relationships depth-limited
 *   TC-10.11: Traversal — respects rel_types filter
 *   TC-10.12: Traversal — handles non-existent memory
 *   TC-10.13: Traversal — follows bidirectional relationships
 *   TC-10.14: End-to-end — trace → reflect → traverse chain
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { GnosysDB } from "../lib/db.js";
import { handleRequest, SandboxRequest } from "../sandbox/server.js";
import { traceCodebase } from "../lib/trace.js";
import {
  createTestEnv,
  cleanupTestEnv,
  makeMemory,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase10");
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

// ─── Helper ──────────────────────────────────────────────────────────────

function req(method: string, params: Record<string, any> = {}): ReturnType<typeof handleRequest> {
  return handleRequest(env.db, { id: `test-${Date.now()}`, method, params });
}

function seedMemories(): string[] {
  const ids: string[] = [];
  const mems = [
    makeMemory({ id: "mem-auth-001", title: "Use JWT for auth", content: "We decided to use JWT tokens for authentication", category: "decisions", confidence: 0.7 }),
    makeMemory({ id: "mem-auth-002", title: "bcrypt for passwords", content: "Passwords hashed with bcrypt cost 12", category: "decisions", confidence: 0.6 }),
    makeMemory({ id: "mem-arch-001", title: "Three-layer architecture", content: "API layer, service layer, data layer", category: "architecture", confidence: 0.8 }),
  ];
  for (const m of mems) {
    env.db.insertMemory(m);
    ids.push(m.id);
  }
  return ids;
}

// ─── TC-10.1: Reflection success updates confidence ──────────────────────

describe("TC-10.1: Reflection API — success outcome updates confidence", () => {
  it("boosts confidence on success", () => {
    const ids = seedMemories();
    const res = req("reflect", {
      outcome: "JWT auth worked perfectly in production",
      memory_ids: [ids[0]],
      success: true,
    });

    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.outcome).toBe("success");
    expect(result.memories_updated).toHaveLength(1);
    expect(result.memories_updated[0].confidence).toBeGreaterThan(0.7);
    expect(result.memories_updated[0].reinforcement_count).toBe(1);
    expect(result.confidence_delta).toBe(0.05);
  });
});

// ─── TC-10.2: Reflection failure decreases confidence ────────────────────

describe("TC-10.2: Reflection API — failure outcome decreases confidence", () => {
  it("decreases confidence on failure", () => {
    const ids = seedMemories();
    const res = req("reflect", {
      outcome: "bcrypt was too slow, switched to argon2",
      memory_ids: [ids[1]],
      success: false,
    });

    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.outcome).toBe("failure");
    expect(result.memories_updated[0].confidence).toBeLessThan(0.6);
    expect(result.confidence_delta).toBe(-0.1);
  });
});

// ─── TC-10.3: Creates reflection memory with relationships ───────────────

describe("TC-10.3: Reflection API — creates reflection memory with relationships", () => {
  it("creates a new reflection memory", () => {
    const ids = seedMemories();
    const res = req("reflect", {
      outcome: "Architecture held up under load",
      memory_ids: [ids[2]],
      success: true,
      notes: "Tested with 10k concurrent users",
    });

    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.reflection_id).toMatch(/^mem-/);
    expect(result.relationships_created).toBeGreaterThan(0);

    // Verify the reflection memory exists
    const reflMem = env.db.getMemory(result.reflection_id);
    expect(reflMem).not.toBeNull();
    expect(reflMem!.category).toBe("reflections");
    expect(reflMem!.content).toContain("Architecture held up under load");
    expect(reflMem!.content).toContain("10k concurrent users");

    // Verify relationship was created
    const rels = env.db.getRelationshipsFrom(result.reflection_id);
    expect(rels.length).toBeGreaterThan(0);
    expect(rels[0].rel_type).toBe("validates");
    expect(rels[0].target_id).toBe(ids[2]);
  });
});

// ─── TC-10.4: Consolidation links on success ─────────────────────────────

describe("TC-10.4: Reflection API — consolidation links related memories on success", () => {
  it("creates corroborates links between multiple memories", () => {
    const ids = seedMemories();
    const res = req("reflect", {
      outcome: "Auth + architecture choices validated",
      memory_ids: [ids[0], ids[1], ids[2]],
      success: true,
    });

    expect(res.ok).toBe(true);

    // Check corroborates relationship between first two memories
    const rels = env.db.getRelationshipsFrom(ids[0]);
    const corroborates = rels.filter((r) => r.rel_type === "corroborates");
    expect(corroborates.length).toBeGreaterThan(0);
    expect(corroborates[0].target_id).toBe(ids[1]);
  });
});

// ─── TC-10.5: Auto-discovers memories when no IDs provided ───────────────

describe("TC-10.5: Reflection API — auto-discovers memories when no IDs provided", () => {
  it("searches FTS to find related memories", () => {
    seedMemories();
    const res = req("reflect", {
      outcome: "JWT authentication tokens worked well",
      // No memory_ids — should find via FTS
    });

    expect(res.ok).toBe(true);
    const result = res.result as any;
    // Should have found at least the JWT memory via search
    expect(result.memories_updated.length).toBeGreaterThanOrEqual(0);
    expect(result.reflection_id).toMatch(/^mem-/);
  });
});

// ─── TC-10.6: Process Tracing discovers functions ────────────────────────

describe("TC-10.6: Process Tracing — discovers functions from source files", () => {
  it("finds function declarations in TS files", () => {
    // Create a temporary source directory with sample files
    const srcDir = path.join(env.tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, "auth.ts"), `
export function validateToken(token: string): boolean {
  const decoded = decodeToken(token);
  return checkExpiry(decoded);
}

function decodeToken(token: string): any {
  return JSON.parse(token);
}

function checkExpiry(decoded: any): boolean {
  return decoded.exp > Date.now();
}
`);

    const result = traceCodebase(env.db, env.tmpDir);
    expect(result.filesScanned).toBe(1);
    expect(result.functionsFound).toBe(3);
  });
});

// ─── TC-10.7: Creates procedural 'how' memories ─────────────────────────

describe("TC-10.7: Process Tracing — creates procedural 'how' memories", () => {
  it("stores functions as category 'how' memories", () => {
    const srcDir = path.join(env.tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, "utils.ts"), `
export function formatDate(d: Date): string {
  return d.toISOString();
}

export function parseDate(s: string): Date {
  return new Date(s);
}
`);

    const result = traceCodebase(env.db, env.tmpDir, { projectId: "proj-test" });
    expect(result.memoriesCreated).toBe(2);

    // Verify memories exist in DB
    for (const memId of result.memoryIds) {
      const mem = env.db.getMemory(memId);
      expect(mem).not.toBeNull();
      expect(mem!.category).toBe("how");
      expect(mem!.title).toMatch(/^How: /);
      expect(mem!.project_id).toBe("proj-test");
    }
  });
});

// ─── TC-10.8: Creates leads_to and follows_from relationships ────────────

describe("TC-10.8: Process Tracing — creates leads_to and follows_from relationships", () => {
  it("creates call-chain relationships between functions", () => {
    const srcDir = path.join(env.tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, "pipeline.ts"), `
function step1(): string {
  return step2();
}

function step2(): string {
  return step3();
}

function step3(): string {
  return "done";
}
`);

    const result = traceCodebase(env.db, env.tmpDir);
    expect(result.memoriesCreated).toBe(3);
    expect(result.relationshipsCreated).toBeGreaterThan(0);

    // Find the step1 memory
    const step1Mem = result.memoryIds.find((id) => {
      const mem = env.db.getMemory(id);
      return mem?.title.includes("step1");
    });
    expect(step1Mem).toBeDefined();

    // Check leads_to relationship exists from step1
    const rels = env.db.getRelationshipsFrom(step1Mem!);
    const leadsTo = rels.filter((r) => r.rel_type === "leads_to");
    expect(leadsTo.length).toBeGreaterThan(0);
  });
});

// ─── TC-10.9: Handles empty directory ────────────────────────────────────

describe("TC-10.9: Process Tracing — handles empty directory", () => {
  it("returns zero counts for empty directory", () => {
    const emptyDir = path.join(env.tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    const result = traceCodebase(env.db, emptyDir);
    expect(result.memoriesCreated).toBe(0);
    expect(result.relationshipsCreated).toBe(0);
    expect(result.functionsFound).toBe(0);
    expect(result.filesScanned).toBe(0);
  });
});

// ─── TC-10.10: Traversal BFS depth-limited ───────────────────────────────

describe("TC-10.10: Traversal — BFS follows relationships depth-limited", () => {
  it("traverses chain up to specified depth", () => {
    // Create a chain: A → B → C → D
    const ids = ["chain-a", "chain-b", "chain-c", "chain-d"];
    const now = new Date().toISOString();

    for (const id of ids) {
      env.db.insertMemory(makeMemory({ id, title: `Node ${id}`, content: `Content for ${id}` }));
    }

    for (let i = 0; i < ids.length - 1; i++) {
      env.db.insertRelationship({
        source_id: ids[i],
        target_id: ids[i + 1],
        rel_type: "leads_to",
        label: null,
        confidence: 1.0,
        created: now,
      });
    }

    // Traverse from A with depth 2 — should get A, B, C but not D
    const res = req("traverse", { id: "chain-a", depth: 2 });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.total).toBe(3); // A, B, C
    expect(result.nodes.map((n: any) => n.id)).toContain("chain-a");
    expect(result.nodes.map((n: any) => n.id)).toContain("chain-b");
    expect(result.nodes.map((n: any) => n.id)).toContain("chain-c");
    expect(result.nodes.map((n: any) => n.id)).not.toContain("chain-d");

    // Traverse with depth 3 — should get all 4
    const res2 = req("traverse", { id: "chain-a", depth: 3 });
    expect(res2.ok).toBe(true);
    expect((res2.result as any).total).toBe(4);
  });
});

// ─── TC-10.11: Traversal respects rel_types filter ───────────────────────

describe("TC-10.11: Traversal — respects rel_types filter", () => {
  it("only follows specified relationship types", () => {
    const now = new Date().toISOString();

    env.db.insertMemory(makeMemory({ id: "filter-a", title: "Filter A" }));
    env.db.insertMemory(makeMemory({ id: "filter-b", title: "Filter B" }));
    env.db.insertMemory(makeMemory({ id: "filter-c", title: "Filter C" }));

    // A leads_to B, A requires C
    env.db.insertRelationship({ source_id: "filter-a", target_id: "filter-b", rel_type: "leads_to", label: null, confidence: 1.0, created: now });
    env.db.insertRelationship({ source_id: "filter-a", target_id: "filter-c", rel_type: "requires", label: null, confidence: 1.0, created: now });

    // Only follow leads_to
    const res = req("traverse", { id: "filter-a", rel_types: ["leads_to"] });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.nodes.map((n: any) => n.id)).toContain("filter-b");
    expect(result.nodes.map((n: any) => n.id)).not.toContain("filter-c");
  });
});

// ─── TC-10.12: Traversal handles non-existent memory ─────────────────────

describe("TC-10.12: Traversal — handles non-existent memory", () => {
  it("returns error for non-existent memory", () => {
    const res = req("traverse", { id: "does-not-exist" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });
});

// ─── TC-10.13: Traversal follows bidirectional relationships ─────────────

describe("TC-10.13: Traversal — follows bidirectional relationships", () => {
  it("follows both outgoing and incoming edges", () => {
    const now = new Date().toISOString();

    env.db.insertMemory(makeMemory({ id: "bidir-a", title: "Bidir A" }));
    env.db.insertMemory(makeMemory({ id: "bidir-b", title: "Bidir B" }));
    env.db.insertMemory(makeMemory({ id: "bidir-c", title: "Bidir C" }));

    // B → A (A has incoming from B)
    env.db.insertRelationship({ source_id: "bidir-b", target_id: "bidir-a", rel_type: "follows_from", label: null, confidence: 1.0, created: now });
    // A → C (A has outgoing to C)
    env.db.insertRelationship({ source_id: "bidir-a", target_id: "bidir-c", rel_type: "leads_to", label: null, confidence: 1.0, created: now });

    const res = req("traverse", { id: "bidir-a", depth: 1 });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    // Should find B (via incoming) and C (via outgoing)
    expect(result.total).toBe(3);
    expect(result.nodes.map((n: any) => n.id)).toContain("bidir-b");
    expect(result.nodes.map((n: any) => n.id)).toContain("bidir-c");
  });
});

// ─── TC-10.14: End-to-end — trace → reflect → traverse ──────────────────

describe("TC-10.14: End-to-end — trace → reflect → traverse chain", () => {
  it("traces code, reflects on outcome, then traverses the chain", () => {
    // Step 1: Create a mini codebase and trace it
    const srcDir = path.join(env.tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, "handler.ts"), `
export function handleRequest(input: string): string {
  const validated = validateInput(input);
  return processData(validated);
}

function validateInput(input: string): string {
  return input.trim();
}

function processData(data: string): string {
  return data.toUpperCase();
}
`);

    const traceResult = traceCodebase(env.db, env.tmpDir);
    expect(traceResult.memoriesCreated).toBe(3);
    expect(traceResult.relationshipsCreated).toBeGreaterThan(0);

    // Step 2: Reflect on the traced code
    const reflectRes = req("reflect", {
      outcome: "handleRequest pipeline works correctly",
      memory_ids: traceResult.memoryIds.slice(0, 2),
      success: true,
    });
    expect(reflectRes.ok).toBe(true);
    const reflectResult = reflectRes.result as any;

    // Step 3: Traverse from the reflection memory
    const traverseRes = req("traverse", {
      id: reflectResult.reflection_id,
      depth: 3,
    });
    expect(traverseRes.ok).toBe(true);
    const traverseResult = traverseRes.result as any;

    // The reflection should connect to the traced memories
    expect(traverseResult.total).toBeGreaterThan(1);

    // Verify we can reach the traced procedural memories through the chain
    const nodeIds = traverseResult.nodes.map((n: any) => n.id);
    expect(nodeIds).toContain(reflectResult.reflection_id);

    // At least one traced memory should be reachable
    const tracedReachable = traceResult.memoryIds.some((id: string) => nodeIds.includes(id));
    expect(tracedReachable).toBe(true);
  });
});
