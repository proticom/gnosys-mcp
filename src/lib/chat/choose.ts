/**
 * Multi-choice protocol — gnosys-choose fenced YAML.
 *
 * The LLM is taught (via system prompt) to emit a fenced block when it wants
 * the user to pick from a small set of options:
 *
 *   ```gnosys-choose
 *   prompt: Which approach should we take?
 *   options:
 *     - id: a
 *       label: Refactor in place — keep the same module
 *       detail: Lower risk, but the existing API stays awkward
 *     - id: b
 *       label: Extract to a new module
 *       detail: Cleaner separation; one-time migration cost
 *   ```
 *
 * The TUI parses the fence after the assistant turn completes, renders an
 * arrow-key selectable list, and on selection injects a synthetic user turn
 * "[picked: <id> — <label>]" before running the next LLM call.
 *
 * The protocol works in reverse too — TUI helpers can pose multiple-choice
 * questions to the user using the same parser/renderer pieces.
 *
 * Failures are soft: a malformed fence renders as plain text in the
 * conversation buffer. We log a `chat_choose_parse_error` style notice so
 * agents can debug without blocking the chat.
 */

export interface ChooseOption {
  id: string;
  label: string;
  detail?: string;
}

export interface ChooseBlock {
  prompt: string;
  options: ChooseOption[];
}

/** System prompt addendum that teaches the LLM the fence syntax. */
export const CHOOSE_SYSTEM_PROMPT_ADDENDUM = `
When you want the user to pick from a SHORT set of options (2–6), emit a fenced block:

\`\`\`gnosys-choose
prompt: <one-line question>
options:
  - id: a
    label: <short>
    detail: <one-line context, optional>
  - id: b
    label: <short>
\`\`\`

Use this only when a discrete choice will materially change what you do next. Don't use it for yes/no — just ask in prose. Don't use it to summarize options that the user has already chosen between.`;

const FENCE_OPEN = /```\s*gnosys-choose\s*\n([\s\S]*?)```/;

/**
 * Find the first gnosys-choose fence in a text and parse it. Returns
 *   - { block, before, after } when a well-formed fence is present
 *   - { error } when a fence exists but failed to parse
 *   - null when no fence is present
 */
export type ExtractResult =
  | { kind: "ok"; block: ChooseBlock; before: string; after: string }
  | { kind: "parse-error"; before: string; rawFence: string; after: string; reason: string }
  | null;

export function extractChooseFence(text: string): ExtractResult {
  const match = text.match(FENCE_OPEN);
  if (!match) return null;

  const fenceContent = match[1].trim();
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(end).trimStart();

  try {
    const block = parseChooseYaml(fenceContent);
    if (!block.prompt || block.options.length === 0) {
      return {
        kind: "parse-error",
        before,
        rawFence: match[0],
        after,
        reason: "missing prompt or empty options",
      };
    }
    return { kind: "ok", block, before, after };
  } catch (err) {
    return {
      kind: "parse-error",
      before,
      rawFence: match[0],
      after,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Hand-rolled YAML parser for the minimal gnosys-choose schema.
 * No external dependency. Tolerates Windows line endings and trailing whitespace.
 *
 * Accepts:
 *   prompt: <text>           # one-line scalar
 *   options:                 # list literal follows
 *     - id: <token>
 *       label: <text>
 *       detail: <text>       # optional
 *     - id: <token>
 *       label: <text>
 */
export function parseChooseYaml(yaml: string): ChooseBlock {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  let prompt = "";
  const options: ChooseOption[] = [];
  let inOptions = false;
  let current: ChooseOption | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Top-level "prompt:" line
    if (!inOptions) {
      const m = line.match(/^prompt:\s*(.+?)\s*$/);
      if (m) {
        prompt = m[1];
        continue;
      }
      if (/^options:\s*$/.test(line)) {
        inOptions = true;
        continue;
      }
      // Unknown top-level field — skip (forward-compat)
      continue;
    }

    // Inside options:
    const itemStart = line.match(/^\s*-\s*id:\s*(.+?)\s*$/);
    if (itemStart) {
      // Push previous item if any
      if (current && current.label) options.push(current);
      current = { id: itemStart[1], label: "" };
      continue;
    }

    if (!current) continue;

    const labelMatch = line.match(/^\s*label:\s*(.+?)\s*$/);
    if (labelMatch) {
      current.label = labelMatch[1];
      continue;
    }

    const detailMatch = line.match(/^\s*detail:\s*(.+?)\s*$/);
    if (detailMatch) {
      current.detail = detailMatch[1];
    }
  }

  // Flush the last option
  if (current && current.label) options.push(current);

  return { prompt, options };
}

/** Format a user's selection as a synthetic user turn. */
export function formatSelection(option: ChooseOption): string {
  const detail = option.detail ? ` (${option.detail})` : "";
  return `[picked: ${option.id} — ${option.label}${detail}]`;
}
