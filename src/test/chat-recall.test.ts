/**
 * Phase 3 — chat recall (federated wrapper, pinning, threshold, formatting,
 * reinforcement).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GnosysDB } from "../lib/db.js";
import {
  runRecall,
  buildRecallQuery,
  formatRecallForPrompt,
  reinforceMemory,
} from "../lib/chat/recall.js";
import type { Turn } from "../lib/chat/types.js";

function makeDb() {
  const tmp = mkdtempSync(join(tmpdir(), "gnosys-recall-test-"));
  const db = new GnosysDB(tmp);
  return { db, tmp };
}

function seedMemory(
  db: GnosysDB,
  id: string,
  opts: { confidence?: number; content?: string; title?: string; project_id?: string | null; scope?: string } = {},
) {
  const now = new Date().toISOString();
  db.insertMemory({
    id,
    title: opts.title ?? `Memory ${id}`,
    category: "test",
    content: opts.content ?? `Content for ${id}`,
    summary: null,
    tags: '["test"]',
    relevance: `${id} test alpha beta`,
    author: "ai",
    authority: "imported",
    confidence: opts.confidence ?? 0.8,
    reinforcement_count: 0,
    content_hash: `hash-${id}`,
    status: "active",
    tier: "active",
    supersedes: null,
    superseded_by: null,
    last_reinforced: null,
    created: now,
    modified: now,
    embedding: null,
    source_path: null,
    source_file: null,
    source_page: null,
    source_timerange: null,
    project_id: opts.project_id ?? null,
    scope: opts.scope ?? "user",
  });
}

describe("buildRecallQuery", () => {
  it("uses just the user input when buffer is empty", () => {
    expect(buildRecallQuery("hello world", [])).toBe("hello world");
  });

  it("appends the last 2 turns from the buffer", () => {
    const buffer: Turn[] = [
      { role: "user", text: "first", ts: "" },
      { role: "assistant", text: "answer", ts: "" },
      { role: "user", text: "second", ts: "" },
      { role: "assistant", text: "another answer", ts: "" },
    ];
    const q = buildRecallQuery("third question", buffer);
    expect(q).toContain("third question");
    expect(q).toContain("second");
    expect(q).toContain("another answer");
  });

  it("trims to at most 200 chars", () => {
    const long = "x".repeat(500);
    const q = buildRecallQuery(long, []);
    expect(q.length).toBeLessThanOrEqual(200);
  });
});

describe("runRecall", () => {
  let workspace: { db: GnosysDB; tmp: string };
  beforeEach(() => {
    workspace = makeDb();
  });
  afterEach(() => {
    workspace.db.close();
    rmSync(workspace.tmp, { recursive: true, force: true });
  });

  it("includes pinned memories regardless of search match", () => {
    seedMemory(workspace.db, "deci-001", { content: "completely unrelated to query" });
    seedMemory(workspace.db, "deci-002", { content: "alpha beta gamma" });

    const result = runRecall(workspace.db, {
      query: "alpha",
      scope: "federated",
      projectId: null,
      threshold: 0,
      pinnedIds: ["deci-001"],
    });

    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain("deci-001");
    expect(result.memories.find((m) => m.id === "deci-001")?.pinned).toBe(true);
  });

  it("filters out memories below the threshold", () => {
    seedMemory(workspace.db, "high-conf", { confidence: 0.9, content: "alpha beta" });
    seedMemory(workspace.db, "low-conf", { confidence: 0.3, content: "alpha beta" });

    const result = runRecall(workspace.db, {
      query: "alpha",
      scope: "federated",
      projectId: null,
      threshold: 0.5,
      pinnedIds: [],
    });

    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain("high-conf");
    expect(ids).not.toContain("low-conf");
  });

  it("respects the scope filter (project only)", () => {
    seedMemory(workspace.db, "proj-mem", {
      content: "alpha",
      project_id: "p1",
      scope: "project",
    });
    seedMemory(workspace.db, "user-mem", { content: "alpha", scope: "user" });

    const result = runRecall(workspace.db, {
      query: "alpha",
      scope: "project",
      projectId: "p1",
      threshold: 0,
      pinnedIds: [],
    });

    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain("proj-mem");
    expect(ids).not.toContain("user-mem");
  });

  it("returns empty memories array when no matches", () => {
    const result = runRecall(workspace.db, {
      query: "no-such-query-string",
      scope: "federated",
      projectId: null,
      threshold: 0,
      pinnedIds: [],
    });
    expect(result.memories).toEqual([]);
  });
});

describe("formatRecallForPrompt", () => {
  it("returns empty string when no memories", () => {
    expect(formatRecallForPrompt([])).toBe("");
  });

  it("renders memories as <memory> blocks with id and confidence", () => {
    const formatted = formatRecallForPrompt([
      {
        id: "deci-037",
        title: "ULID IDs",
        content: "Use ULID for memory IDs",
        category: "decisions",
        scope: "project",
        confidence: 0.95,
        pinned: false,
        score: 1.2,
      },
    ]);
    expect(formatted).toContain('id="deci-037"');
    expect(formatted).toContain('confidence="0.95"');
    expect(formatted).toContain("Use ULID for memory IDs");
  });

  it("marks pinned memories with pinned=\"true\"", () => {
    const formatted = formatRecallForPrompt([
      {
        id: "deci-037",
        title: "x",
        content: "y",
        category: "decisions",
        scope: "project",
        confidence: 0.9,
        pinned: true,
        score: 0,
      },
    ]);
    expect(formatted).toContain('pinned="true"');
  });
});

describe("reinforceMemory", () => {
  let workspace: { db: GnosysDB; tmp: string };
  beforeEach(() => {
    workspace = makeDb();
  });
  afterEach(() => {
    workspace.db.close();
    rmSync(workspace.tmp, { recursive: true, force: true });
  });

  it("returns true and bumps reinforcement_count when the memory exists", () => {
    seedMemory(workspace.db, "mem-1");
    const before = workspace.db.getMemory("mem-1")!;
    expect(before.reinforcement_count).toBe(0);

    const ok = reinforceMemory(workspace.db, "mem-1");
    expect(ok).toBe(true);

    const after = workspace.db.getMemory("mem-1")!;
    expect(after.reinforcement_count).toBe(1);
    expect(after.last_reinforced).not.toBeNull();
  });

  it("returns false when the memory does not exist", () => {
    expect(reinforceMemory(workspace.db, "missing")).toBe(false);
  });
});
