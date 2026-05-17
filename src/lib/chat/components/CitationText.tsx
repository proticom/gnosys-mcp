/**
 * v5.9.0 chat TUI — inline citation transformer.
 *
 * Scans a chunk of plain text for memory-id patterns (prefix-ULID or
 * prefix-uuid forms) and renders each occurrence as an OSC8 hyperlink
 * in the brand-hover red. Non-matching text passes through unchanged.
 *
 * Patterns matched:
 *   - `deci-01HXXJK2ABCDEFGHIJ` (ULID, Crockford base32)
 *   - `pref-some-key`           (kebab-case key form, e.g. `pref-code-style`)
 *   - `mem-1738447692-abc`      (legacy timestamp+random imports)
 *   - Optional surrounding brackets: `[gnosys-ai · deci-01H…]` → the inner
 *     id portion is the hyperlink target.
 *
 * URI scheme: `gnosys://memory/<full-id>` (matches v5.8.3 OSC8 work).
 * Stripped ellipses are preserved in the visible text but the URI carries
 * the full id when available.
 */

import React from "react";
import { Text } from "ink";
import { THEME } from "../theme.js";
import { memoryUri, osc8Wrap } from "../../idFormat.js";

// Single regex that matches any of the supported id shapes:
//   - ULID-style:  `deci-01HXXJK2…`  (kebab prefix + suffix containing at
//                   least one uppercase letter or digit)
//   - pref-*:      `pref-code-style` (explicit pref- prefix, lowercase
//                   kebab — opt-in by literal prefix to avoid false-
//                   positives on prose like "well-known" / "test-cases")
// Capture group 1 is the full id (no ellipsis); group 2 is the ellipsis.
const CITATION_RE =
  /\b(pref-[a-z0-9][a-z0-9-]*|[a-z]+-[a-zA-Z0-9-]*[A-Z0-9][a-zA-Z0-9-]*)(…)?/g;

export interface CitationTextProps {
  text: string;
}

/**
 * Splits `text` on memory-id citations and renders each match as a
 * brand-red OSC8 hyperlink. Returns a React fragment safe to drop into
 * any ink `<Text>` block.
 */
export const CitationText: React.FC<CitationTextProps> = ({ text }) => {
  const segments = splitCitations(text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "citation" ? (
          <Text key={i} color={THEME.accentHover} underline>
            {osc8Wrap(memoryUri(seg.id), seg.display)}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </>
  );
};

interface PlainSegment {
  kind: "plain";
  text: string;
}
interface CitationSegment {
  kind: "citation";
  id: string;
  display: string;
}
type Segment = PlainSegment | CitationSegment;

/** Split `text` into plain / citation segments in left-to-right order. */
export function splitCitations(text: string): Segment[] {
  const out: Segment[] = [];
  let lastEnd = 0;
  for (const match of text.matchAll(CITATION_RE)) {
    const id = match[1];
    const ellipsis = match[2] ?? "";
    const start = match.index ?? 0;
    if (start > lastEnd) {
      out.push({ kind: "plain", text: text.slice(lastEnd, start) });
    }
    out.push({ kind: "citation", id, display: id + ellipsis });
    lastEnd = start + id.length + ellipsis.length;
  }
  if (lastEnd < text.length) {
    out.push({ kind: "plain", text: text.slice(lastEnd) });
  }
  return out.length > 0 ? out : [{ kind: "plain", text }];
}
