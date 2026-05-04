/**
 * Phase 2 — orchestrator helpers (bufferFromEvents).
 *
 * Real interactive session bring-up is exercised manually; these tests cover
 * the pure logic that converts the JSONL log into the in-memory conversation
 * buffer used to seed --resume.
 */

import { describe, it, expect } from "vitest";
import { bufferFromEvents } from "../lib/chat/index.js";
import { SessionEvent } from "../lib/chat/session.js";

describe("bufferFromEvents", () => {
  it("converts user + assistant events into Turn[] in order", () => {
    const events: SessionEvent[] = [
      { type: "session_start", ts: "2026-05-03T10:00:00Z", project_id: "p" },
      { type: "user", ts: "2026-05-03T10:01:00Z", text: "hi" },
      { type: "assistant", ts: "2026-05-03T10:01:02Z", text: "hello", provider: "anthropic", model: "claude-sonnet-4-6" },
      { type: "user", ts: "2026-05-03T10:02:00Z", text: "thanks" },
      { type: "assistant", ts: "2026-05-03T10:02:01Z", text: "you're welcome" },
    ];
    const buffer = bufferFromEvents(events);
    expect(buffer).toHaveLength(4);
    expect(buffer[0].role).toBe("user");
    expect(buffer[1].role).toBe("assistant");
    expect(buffer[1].role === "assistant" && buffer[1].provider).toBe("anthropic");
    expect(buffer[3].text).toBe("you're welcome");
  });

  it("ignores non-conversational events (commands, focus, recall, etc.)", () => {
    const events: SessionEvent[] = [
      { type: "session_start", ts: "2026-05-03T10:00:00Z" },
      { type: "user", ts: "2026-05-03T10:01:00Z", text: "hi" },
      { type: "command", ts: "2026-05-03T10:01:30Z", name: "/pin", args: ["deci-037"] },
      { type: "recall", ts: "2026-05-03T10:01:35Z", query: "test", memory_ids: [], scope: "project" },
      { type: "focus", ts: "2026-05-03T10:01:40Z", topic: "auth" },
      { type: "assistant", ts: "2026-05-03T10:02:00Z", text: "done" },
    ];
    const buffer = bufferFromEvents(events);
    expect(buffer).toHaveLength(2);
    expect(buffer[0].text).toBe("hi");
    expect(buffer[1].text).toBe("done");
  });

  it("returns [] for an empty event list", () => {
    expect(bufferFromEvents([])).toEqual([]);
  });
});
