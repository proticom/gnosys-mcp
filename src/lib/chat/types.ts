/**
 * Shared types for the chat TUI. Kept separate from session.ts so the
 * React/ink components can import without pulling fs/path dependencies.
 */

export type Turn =
  | { role: "user"; text: string; ts: string }
  | { role: "assistant"; text: string; ts: string; provider?: string; model?: string; tokensIn?: number; tokensOut?: number; citedMemoryIds?: string[] }
  | { role: "system"; text: string; ts: string };

export type ChatStatus =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "streaming"; partial: string }
  | { kind: "error"; message: string };

export interface ChatHeaderInfo {
  sessionId: string;
  projectName?: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}
