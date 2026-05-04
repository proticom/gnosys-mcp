/**
 * Phase 4 — chat memory writing (promote, last-exchange, auto-promote).
 *
 * The LLM-structuring path is exercised by passing config=null so the
 * deterministic fallback runs — keeps tests fast and offline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GnosysDB } from "../lib/db.js";
import {
  promoteToMemory,
  lastExchange,
  formatExchange,
  detectAutoPromote,
} from "../lib/chat/write.js";
import { Turn } from "../lib/chat/types.js";

function makeDb() {
  const tmp = mkdtempSync(join(tmpdir(), "gnosys-write-test-"));
  const db = new GnosysDB(tmp);
  return { db, tmp };
}

describe("promoteToMemory", () => {
  let workspace: { db: GnosysDB; tmp: string };
  beforeEach(() => {
    workspace = makeDb();
  });
  afterEach(() => {
    workspace.db.close();
    rmSync(workspace.tmp, { recursive: true, force: true });
  });

  it("writes a memory using the deterministic fallback when no LLM config", async () => {
    const result = await promoteToMemory(workspace.db, {
      content: "We chose ULID over UUIDv7 for memory IDs because of Crockford encoding.",
      source: "remember",
      sessionId: "01HXXSESSION",
      projectId: null,
      config: null,
    });

    expect(result.id).toMatch(/^conc-/);
    expect(result.title).toContain("ULID");
    expect(result.category).toBe("concepts");

    const stored = workspace.db.getMemory(result.id);
    expect(stored).not.toBeNull();
    expect(stored!.content).toContain("Crockford");
  });

  it("includes session, from-chat, and source provenance tags", async () => {
    const result = await promoteToMemory(workspace.db, {
      content: "Decision: rate-limit by API key, not IP.",
      source: "save-turn",
      sessionId: "01HXXSESSION",
      projectId: null,
      config: null,
    });

    const stored = workspace.db.getMemory(result.id)!;
    const tags = JSON.parse(stored.tags) as string[];
    expect(tags).toContain("session:01HXXSESSION");
    expect(tags).toContain("from-chat:true");
    expect(tags).toContain("source:save-turn");
  });

  it("scopes the memory to the project when projectId is given", async () => {
    workspace.db.insertProject({
      id: "proj-1",
      name: "Test Project",
      working_directory: "/tmp/test",
      user: "tester",
      agent_rules_target: null,
      obsidian_vault: null,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    });

    const result = await promoteToMemory(workspace.db, {
      content: "Project-scoped insight.",
      source: "remember",
      sessionId: "S",
      projectId: "proj-1",
      config: null,
    });

    const stored = workspace.db.getMemory(result.id)!;
    expect(stored.project_id).toBe("proj-1");
    expect(stored.scope).toBe("project");
  });

  it("falls back to user scope when no project is given", async () => {
    const result = await promoteToMemory(workspace.db, {
      content: "Cross-project insight.",
      source: "remember",
      sessionId: "S",
      projectId: null,
      config: null,
    });

    const stored = workspace.db.getMemory(result.id)!;
    expect(stored.scope).toBe("user");
    expect(stored.project_id).toBeNull();
  });

  it("respects an explicit category override", async () => {
    const result = await promoteToMemory(workspace.db, {
      content: "Architecture choice...",
      source: "remember",
      sessionId: "S",
      projectId: null,
      category: "architecture",
      config: null,
    });

    expect(result.category).toBe("architecture");
    expect(result.id).toMatch(/^arch-/);
  });

  it("rejects unknown category overrides (falls back to source default)", async () => {
    const result = await promoteToMemory(workspace.db, {
      content: "Some content.",
      source: "remember",
      sessionId: "S",
      projectId: null,
      category: "made-up-category",
      config: null,
    });

    // Falls back to "concepts" for source=remember
    expect(result.category).toBe("concepts");
  });

  it("respects an explicit title override", async () => {
    const result = await promoteToMemory(workspace.db, {
      content: "long body of content here on multiple lines\nwith more detail",
      source: "remember",
      sessionId: "S",
      projectId: null,
      title: "Short Custom Title",
      config: null,
    });

    expect(result.title).toBe("Short Custom Title");
  });

  it("logs an audit entry with chat:source and sessionId in details", async () => {
    const result = await promoteToMemory(workspace.db, {
      content: "Auditable content.",
      source: "auto",
      sessionId: "01HXXSESSION",
      projectId: null,
      config: null,
    });

    const audit = workspace.db.getAuditLog(result.id, 5);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const last = audit[0];
    expect(last.operation).toBe("write");
    const details = JSON.parse(last.details ?? "{}");
    expect(details.source).toBe("chat:auto");
    expect(details.sessionId).toBe("01HXXSESSION");
  });
});

describe("lastExchange", () => {
  it("returns the most recent user+assistant pair", () => {
    const buf: Turn[] = [
      { role: "user", text: "first", ts: "" },
      { role: "assistant", text: "ans1", ts: "" },
      { role: "user", text: "second", ts: "" },
      { role: "assistant", text: "ans2", ts: "" },
    ];
    expect(lastExchange(buf)).toEqual({ user: "second", assistant: "ans2" });
  });

  it("returns null if there's no completed exchange", () => {
    expect(lastExchange([])).toBeNull();
    expect(lastExchange([{ role: "user", text: "lone", ts: "" }])).toBeNull();
    expect(
      lastExchange([{ role: "assistant", text: "stray", ts: "" }]),
    ).toBeNull();
  });

  it("walks past system turns", () => {
    const buf: Turn[] = [
      { role: "user", text: "q", ts: "" },
      { role: "system", text: "notice", ts: "" },
      { role: "assistant", text: "a", ts: "" },
    ];
    expect(lastExchange(buf)).toEqual({ user: "q", assistant: "a" });
  });
});

describe("formatExchange", () => {
  it("renders user and assistant text in a labeled markdown block", () => {
    const formatted = formatExchange({ user: "How does X work?", assistant: "It works because Y." });
    expect(formatted).toContain("Question / context");
    expect(formatted).toContain("How does X work?");
    expect(formatted).toContain("Answer / decision");
    expect(formatted).toContain("It works because Y.");
  });
});

describe("detectAutoPromote", () => {
  it("flags decision-language", () => {
    expect(detectAutoPromote("Let's go with Postgres for the analytics DB.")?.reason).toBe(
      "decision-language",
    );
    expect(detectAutoPromote("we decided to use ULID")?.reason).toBe("decision-language");
  });

  it("flags insight-language", () => {
    expect(detectAutoPromote("I learned that the merge happens at the kernel level.")?.reason).toBe(
      "insight-language",
    );
    expect(detectAutoPromote("turns out the flag is OFF by default")?.reason).toBe("insight-language");
  });

  it("flags note-request", () => {
    expect(detectAutoPromote("note that this only works on macOS")?.reason).toBe("note-request");
    expect(detectAutoPromote("let's remember that detail")?.reason).toBe("note-request");
  });

  it("returns null on unrelated text", () => {
    expect(detectAutoPromote("how do I run the tests?")).toBeNull();
    expect(detectAutoPromote("hello there")).toBeNull();
  });
});
