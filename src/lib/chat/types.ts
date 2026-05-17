/**
 * Shared types for the chat TUI. Kept separate from session.ts so the
 * React/ink components can import without pulling fs/path dependencies.
 */

/**
 * v5.9.0 (#101 phase δ): a tool call surfaced inside an assistant turn.
 * `error` is set when the call failed; otherwise `result` carries the
 * (truncated) return string.
 */
export interface ToolCallRecord {
  tool: string;
  args: Record<string, string>;
  result?: string;
  error?: string;
  ts: string;
}

export type Turn =
  | { role: "user"; text: string; ts: string }
  | {
      role: "assistant";
      text: string;
      ts: string;
      provider?: string;
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
      citedMemoryIds?: string[];
      toolCalls?: ToolCallRecord[];
    }
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
