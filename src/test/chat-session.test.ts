/**
 * Phase 1 — chat session JSONL log writer/reader/list/search.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gnosys-chat-test-"));
  process.env.GNOSYS_CHAT_SESSIONS_DIR = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.GNOSYS_CHAT_SESSIONS_DIR;
});

// session.ts reads getSessionLogDir() lazily on each call, so the env var
// set in beforeEach() takes effect — no module reset needed.
async function loadSession() {
  return await import("../lib/chat/session.js");
}

describe("chat session log", () => {
  it("startSession writes a session_start event and returns the id", async () => {
    const s = await loadSession();
    const id = s.startSession({ project_id: "proj-1", provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID format

    const events = s.readSession(id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_start");
    if (events[0].type === "session_start") {
      expect(events[0].project_id).toBe("proj-1");
      expect(events[0].provider).toBe("anthropic");
    }
  });

  it("appendEvent appends events in order, readSession returns them all", async () => {
    const s = await loadSession();
    const id = s.startSession({ project_id: "proj-2" });

    s.appendEvent(id, { type: "user", ts: new Date().toISOString(), text: "what time is it?" });
    s.appendEvent(id, {
      type: "assistant",
      ts: new Date().toISOString(),
      text: "I don't know — I don't have a clock.",
      provider: "anthropic",
      tokens_in: 12,
      tokens_out: 14,
    });
    s.appendEvent(id, { type: "command", ts: new Date().toISOString(), name: "/pin", args: ["deci-037"] });

    const events = s.readSession(id);
    expect(events).toHaveLength(4);
    expect(events[1].type).toBe("user");
    expect(events[2].type).toBe("assistant");
    expect(events[3].type).toBe("command");
  });

  it("listSessions returns metadata for all session files, newest first", async () => {
    const s = await loadSession();
    const a = s.startSession({ project_id: "proj-A" });
    s.appendEvent(a, { type: "user", ts: new Date().toISOString(), text: "first message" });

    // Wait a beat so mtimes differ
    await new Promise((r) => setTimeout(r, 50));
    const b = s.startSession({ project_id: "proj-B" });
    s.appendEvent(b, { type: "user", ts: new Date().toISOString(), text: "another message" });

    const sessions = s.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(b);
    expect(sessions[1].id).toBe(a);
    expect(sessions[0].project_id).toBe("proj-B");
    expect(sessions[0].turns).toBe(1);
  });

  it("searchSessions finds events containing the query (case-insensitive)", async () => {
    const s = await loadSession();
    const id = s.startSession({});
    s.appendEvent(id, { type: "user", ts: new Date().toISOString(), text: "We need to figure out ULID handling." });
    s.appendEvent(id, { type: "assistant", ts: new Date().toISOString(), text: "Sure, let me think about that." });
    s.appendEvent(id, { type: "user", ts: new Date().toISOString(), text: "Maybe we use crockford base32?" });

    const matches = s.searchSessions("ulid");
    expect(matches.length).toBe(1);
    expect(matches[0].sessionId).toBe(id);

    const crockford = s.searchSessions("CROCKFORD");
    expect(crockford.length).toBe(1);
  });

  it("readSession returns [] for unknown session id", async () => {
    const s = await loadSession();
    expect(s.readSession("does-not-exist")).toEqual([]);
  });

  it("readSession tolerates malformed lines (skips them)", async () => {
    const s = await loadSession();
    const id = s.startSession({});
    // Inject a bad line directly
    const { appendFileSync } = await import("fs");
    appendFileSync(s.sessionPath(id), "this-is-not-json\n");
    s.appendEvent(id, { type: "user", ts: new Date().toISOString(), text: "still works" });

    const events = s.readSession(id);
    // session_start + user — bad line is skipped silently
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("user");
  });
});
