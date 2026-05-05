/**
 * Focus boundaries — replaces the traditional "new chat" model.
 *
 * With perfect memory in gnosys, sessions don't need to be containers of
 * context. The conversation log is the audit trail; focus boundaries are
 * the working framing. /focus clears the working buffer (what the LLM sees)
 * but preserves the session log + the prior focus's buffer for /resume-focus.
 *
 * /branch is a sibling primitive: same focus, but with the current buffer
 * preserved so you can explore a hypothetical and come back.
 *
 * Auto-summarize fires when the buffer approaches the model's context
 * window — distills the buffer into a memory, replaces it with a single
 * system reference. Transparent to the user.
 */

import { Turn } from "./types.js";

export interface FocusSnapshot {
  /** Focus name. */
  topic: string;
  /** When this snapshot was created. */
  ts: string;
  /** Conversation buffer at the moment of the snapshot. */
  buffer: Turn[];
  /** True for snapshots created by /branch (not /focus). */
  branched?: boolean;
}

export interface FocusState {
  /** Currently declared focus (null = "general" / no focus declared). */
  current: string | null;
  /** Snapshots keyed by topic. /focus saves the prior focus here before clearing. */
  snapshots: Map<string, FocusSnapshot>;
  /** Branch stack — LIFO of forked buffers from /branch. */
  branches: FocusSnapshot[];
}

export function newFocusState(): FocusState {
  return { current: null, snapshots: new Map(), branches: [] };
}

/**
 * Apply /focus — save current state under the prior focus name, then clear.
 * Returns the new state and the new (empty) buffer.
 */
export function applyFocus(
  state: FocusState,
  buffer: Turn[],
  newTopic: string,
  nowIso: string,
): { state: FocusState; buffer: Turn[]; previousTopic: string | null } {
  const previousTopic = state.current;
  const newSnapshots = new Map(state.snapshots);

  // Save current buffer under the prior focus (skip if there's nothing to save)
  if (buffer.length > 0) {
    const key = previousTopic ?? "general";
    newSnapshots.set(key, {
      topic: key,
      ts: nowIso,
      buffer,
    });
  }

  return {
    state: { ...state, current: newTopic, snapshots: newSnapshots },
    buffer: [],
    previousTopic,
  };
}

/** Apply /branch — preserve buffer onto the branch stack, keep editing same buffer. */
export function applyBranch(state: FocusState, buffer: Turn[], nowIso: string): FocusState {
  const branches = [
    ...state.branches,
    {
      topic: state.current ?? "general",
      ts: nowIso,
      buffer: [...buffer],
      branched: true,
    },
  ];
  return { ...state, branches };
}

/**
 * Apply /resume-focus — load a snapshot back into the buffer.
 * Returns null if no snapshot exists for the requested topic.
 */
export function applyResumeFocus(
  state: FocusState,
  buffer: Turn[],
  topic: string,
  nowIso: string,
): { state: FocusState; buffer: Turn[] } | null {
  const snap = state.snapshots.get(topic);
  if (!snap) return null;

  // Save current buffer under the active focus before swapping
  const newSnapshots = new Map(state.snapshots);
  if (buffer.length > 0 && state.current) {
    newSnapshots.set(state.current, { topic: state.current, ts: nowIso, buffer });
  }
  newSnapshots.delete(topic); // consumed

  return {
    state: { ...state, current: topic, snapshots: newSnapshots },
    buffer: [...snap.buffer],
  };
}

/** Pop the most recent branch off the stack and restore it. Returns null when empty. */
export function popBranch(state: FocusState): { state: FocusState; buffer: Turn[]; topic: string } | null {
  if (state.branches.length === 0) return null;
  const last = state.branches[state.branches.length - 1];
  const branches = state.branches.slice(0, -1);
  return {
    state: { ...state, current: last.topic, branches },
    buffer: [...last.buffer],
    topic: last.topic,
  };
}

// ─── Auto-summarize ──────────────────────────────────────────────────────

/** Rough token estimate — 1 token ≈ 4 chars for English / code. */
export function estimateTokens(buffer: Turn[]): number {
  let chars = 0;
  for (const t of buffer) chars += t.text.length;
  return Math.ceil(chars / 4);
}

/** Threshold check: returns true when the buffer is near the context window cap. */
export function shouldAutoSummarize(buffer: Turn[], contextWindowTokens: number, ratio = 0.8): boolean {
  return estimateTokens(buffer) >= contextWindowTokens * ratio;
}

/**
 * Build the prompt that asks the LLM to distill a buffer.
 * Used in Phase 7's auto-summarize and exposed for /save-turn-style flows.
 */
export function buildSummaryPrompt(buffer: Turn[], focus: string | null): string {
  const transcript = buffer
    .map((t) => {
      if (t.role === "user") return `User: ${t.text}`;
      if (t.role === "assistant") return `Assistant: ${t.text}`;
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n\n");

  const focusLine = focus ? `Focus: ${focus}\n\n` : "";

  return `${focusLine}Distill this chat transcript into a single concise memory the user can reference later. Capture decisions made, conclusions reached, and open questions surfaced. Skip pleasantries.

Transcript:
${transcript}

Output the distilled memory as plain markdown. No fences, no commentary.`;
}
