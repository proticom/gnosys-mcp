/**
 * Phase 7 — focus boundaries (focus / branch / resume-focus / auto-summarize).
 *
 * Pure-function tests. The integration with the renderer (state updates,
 * session log events) is exercised at the dispatcher level; these tests
 * cover the underlying state machine.
 */

import { describe, it, expect } from "vitest";
import {
  newFocusState,
  applyFocus,
  applyBranch,
  applyResumeFocus,
  popBranch,
  estimateTokens,
  shouldAutoSummarize,
  buildSummaryPrompt,
} from "../lib/chat/focus.js";
import type { Turn } from "../lib/chat/types.js";

const NOW = "2026-05-04T12:00:00Z";

function turn(role: Turn["role"], text: string): Turn {
  return { role, text, ts: NOW } as Turn;
}

describe("focus state — initial", () => {
  it("starts with no current focus and empty history", () => {
    const s = newFocusState();
    expect(s.current).toBeNull();
    expect(s.snapshots.size).toBe(0);
    expect(s.branches.length).toBe(0);
  });
});

describe("applyFocus", () => {
  it("clears the buffer and sets the new focus", () => {
    const buf = [turn("user", "first"), turn("assistant", "answer")];
    const result = applyFocus(newFocusState(), buf, "auth refactor", NOW);

    expect(result.buffer).toEqual([]);
    expect(result.state.current).toBe("auth refactor");
    expect(result.previousTopic).toBeNull();
  });

  it("saves the prior buffer under the prior focus name", () => {
    const before = applyFocus(newFocusState(), [turn("user", "msg")], "topic-A", NOW);
    const after = applyFocus(before.state, [turn("user", "topic-A msg")], "topic-B", NOW);

    expect(after.previousTopic).toBe("topic-A");
    expect(after.state.snapshots.has("topic-A")).toBe(true);
    expect(after.state.snapshots.get("topic-A")?.buffer[0].text).toBe("topic-A msg");
  });

  it("uses 'general' as the snapshot key when no prior focus is set", () => {
    const result = applyFocus(newFocusState(), [turn("user", "msg")], "newfocus", NOW);
    expect(result.state.snapshots.has("general")).toBe(true);
  });

  it("doesn't snapshot an empty buffer", () => {
    const result = applyFocus(newFocusState(), [], "fresh", NOW);
    expect(result.state.snapshots.size).toBe(0);
  });
});

describe("applyBranch", () => {
  it("pushes the current buffer onto the branch stack", () => {
    const s = newFocusState();
    const buf = [turn("user", "X"), turn("assistant", "Y")];
    const next = applyBranch(s, buf, NOW);
    expect(next.branches.length).toBe(1);
    expect(next.branches[0].buffer).toEqual(buf);
  });

  it("supports multiple branches (LIFO)", () => {
    let s = newFocusState();
    s = applyBranch(s, [turn("user", "A")], NOW);
    s = applyBranch(s, [turn("user", "B")], NOW);
    expect(s.branches.length).toBe(2);
    expect(s.branches[1].buffer[0].text).toBe("B");
  });
});

describe("applyResumeFocus", () => {
  it("restores a saved snapshot into the buffer", () => {
    // Simulate the real flow: each /focus passes the active buffer at the
    // moment of the call (which is what gets saved under the prior focus).
    let s = newFocusState();
    // Step 1: declare focus "auth" with empty buffer (just starting)
    let result = applyFocus(s, [], "auth", NOW);
    s = result.state;
    // Step 2: in "auth", we accumulated [auth msg]. Pivot to "billing" —
    // [auth msg] gets saved under "auth".
    result = applyFocus(s, [turn("user", "auth msg")], "billing", NOW);
    s = result.state;
    expect(s.snapshots.get("auth")?.buffer[0].text).toBe("auth msg");

    const restored = applyResumeFocus(s, [turn("user", "billing now")], "auth", NOW);
    expect(restored).not.toBeNull();
    expect(restored!.buffer.some((t) => t.text === "auth msg")).toBe(true);
    expect(restored!.state.current).toBe("auth");
  });

  it("returns null for an unknown focus name", () => {
    expect(applyResumeFocus(newFocusState(), [], "missing", NOW)).toBeNull();
  });

  it("preserves the active buffer under its focus name when swapping", () => {
    let s = newFocusState();
    s = applyFocus(s, [], "A", NOW).state;
    s = applyFocus(s, [turn("user", "from A")], "B", NOW).state;
    // Now in B; the A snapshot exists. Resume A — B's buffer should be saved.
    const restored = applyResumeFocus(s, [turn("user", "from B")], "A", NOW);
    expect(restored?.state.snapshots.get("B")?.buffer[0].text).toBe("from B");
  });
});

describe("popBranch", () => {
  it("returns null when no branches are stacked", () => {
    expect(popBranch(newFocusState())).toBeNull();
  });

  it("pops the most recent branch (LIFO)", () => {
    let s = newFocusState();
    s = applyBranch(s, [turn("user", "A")], NOW);
    s = applyBranch(s, [turn("user", "B")], NOW);
    const popped = popBranch(s);
    expect(popped?.buffer[0].text).toBe("B");
    expect(popped?.state.branches.length).toBe(1);
  });
});

describe("auto-summarize helpers", () => {
  it("estimateTokens approximates 1 token per 4 chars", () => {
    const buf = [turn("user", "x".repeat(40))];
    expect(estimateTokens(buf)).toBe(10);
  });

  it("shouldAutoSummarize fires at the configured ratio", () => {
    const buf = [turn("user", "x".repeat(800_000))]; // 200k tokens
    expect(shouldAutoSummarize(buf, 200_000, 0.8)).toBe(true);
    expect(shouldAutoSummarize(buf, 1_000_000, 0.8)).toBe(false);
  });

  it("buildSummaryPrompt includes focus and the transcript", () => {
    const buf = [turn("user", "what is X"), turn("assistant", "X is Y")];
    const prompt = buildSummaryPrompt(buf, "Topic A");
    expect(prompt).toContain("Focus: Topic A");
    expect(prompt).toContain("User: what is X");
    expect(prompt).toContain("Assistant: X is Y");
  });

  it("buildSummaryPrompt omits focus line when null", () => {
    const prompt = buildSummaryPrompt([turn("user", "hi")], null);
    expect(prompt).not.toContain("Focus:");
  });
});
