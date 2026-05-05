/**
 * Parse `gnosys-tool` fenced blocks emitted by the chat LLM.
 *
 * Format:
 *   ```gnosys-tool
 *   tool: <name>
 *   <param>: <value>
 *   <param>: <value>
 *   ```
 *
 * Supports multiple fences in one assistant turn (the LLM might call list +
 * read in one go). Each parse returns the tool name + key/value args + the
 * surrounding text so the renderer can show the conversation cleanly.
 */

export interface ParsedToolCall {
  tool: string;
  args: Record<string, string>;
  /** Source text of the full fence (for fail-soft display when needed). */
  rawFence: string;
}

export interface ToolFenceExtraction {
  /** Text before any fences. */
  before: string;
  /** Text after the last fence. */
  after: string;
  /** Each parsed tool call in order of appearance. */
  calls: ParsedToolCall[];
  /** Errors keyed to the index in `calls` they would have occupied. */
  parseErrors: Array<{ rawFence: string; reason: string }>;
}

const FENCE_RE = /```\s*gnosys-tool\s*\n([\s\S]*?)```/g;

/**
 * Extract every gnosys-tool fence in the text. Returns the text between
 * fences alongside the parsed calls. Failed parses are surfaced separately
 * so the renderer can warn without breaking the chat.
 */
export function extractToolFences(text: string): ToolFenceExtraction | null {
  const calls: ParsedToolCall[] = [];
  const parseErrors: Array<{ rawFence: string; reason: string }> = [];
  const fences: Array<{ start: number; end: number; raw: string; body: string }> = [];

  let match: RegExpExecArray | null;
  // Reset lastIndex since we use a global regex
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(text)) !== null) {
    fences.push({
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      body: match[1].trim(),
    });
  }

  if (fences.length === 0) return null;

  for (const f of fences) {
    try {
      const parsed = parseToolBody(f.body);
      if (!parsed.tool) {
        parseErrors.push({ rawFence: f.raw, reason: "missing `tool:` line" });
        continue;
      }
      calls.push({ tool: parsed.tool, args: parsed.args, rawFence: f.raw });
    } catch (err) {
      parseErrors.push({
        rawFence: f.raw,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const before = text.slice(0, fences[0].start).trimEnd();
  const after = text.slice(fences[fences.length - 1].end).trimStart();

  return { before, after, calls, parseErrors };
}

/**
 * Parse the body of a gnosys-tool fence into { tool, args }.
 *
 * Schema:
 *   tool: <name>            # required
 *   <param>: <value>        # zero or more
 *
 * Whitespace and trailing punctuation are tolerated. Comments (lines
 * starting with `#`) are ignored.
 */
export function parseToolBody(body: string): { tool: string; args: Record<string, string> } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let tool = "";
  const args: Record<string, string> = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-z_][a-z0-9_-]*)\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key.toLowerCase() === "tool") {
      tool = value;
    } else {
      args[key] = value;
    }
  }

  return { tool, args };
}
