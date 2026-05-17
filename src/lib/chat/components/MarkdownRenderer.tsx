/**
 * v5.9.0 chat TUI — markdown renderer for assistant turns.
 *
 * Parses with `marked` (lexer only — we don't want HTML output), then
 * walks the token tree and emits ink components with the brand palette.
 *
 * Supported:
 *   - Headings (h1-h6 → bold + brand-red prefix)
 *   - Paragraphs with inline bold / italic / inline code / strikethrough
 *   - Bulleted + numbered lists (nested)
 *   - Code blocks (cli-highlight for fenced langs; plain dim for unfenced)
 *   - Block quotes (left-bar accent + dim text)
 *   - Tables (simple aligned)
 *   - Horizontal rules
 *   - Links (rendered as text + " (url)" in muted color)
 *
 * Out of scope (will fall through to plain text):
 *   - HTML inside markdown
 *   - Footnotes (GFM extension)
 *
 * Performance: parser AST is memoized per-input-string. Re-render of an
 * unchanged turn is free.
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { marked, type Tokens } from "marked";
import { highlight } from "cli-highlight";
import { THEME } from "../theme.js";
import { CitationText } from "./CitationText.js";

export interface MarkdownRendererProps {
  text: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ text }) => {
  const tokens = useMemo(() => marked.lexer(text), [text]);
  return (
    <Box flexDirection="column">
      {tokens.map((tok, i) => (
        <BlockToken key={i} token={tok} />
      ))}
    </Box>
  );
};

// ─── Block-level tokens ───────────────────────────────────────────────────

const BlockToken: React.FC<{ token: Tokens.Generic }> = ({ token }) => {
  switch (token.type) {
    case "heading":
      return <HeadingToken token={token as Tokens.Heading} />;
    case "paragraph":
      return <ParagraphToken token={token as Tokens.Paragraph} />;
    case "list":
      return <ListToken token={token as Tokens.List} />;
    case "code":
      return <CodeToken token={token as Tokens.Code} />;
    case "blockquote":
      return <BlockquoteToken token={token as Tokens.Blockquote} />;
    case "table":
      return <TableToken token={token as Tokens.Table} />;
    case "hr":
      return (
        <Box marginY={1}>
          <Text color={THEME.border}>{"─".repeat(40)}</Text>
        </Box>
      );
    case "space":
      return <Box marginBottom={0} />;
    default:
      // Unknown token — print raw text so nothing is lost.
      return (
        <Text color={THEME.text}>
          {(token as { raw?: string }).raw ?? ""}
        </Text>
      );
  }
};

const HeadingToken: React.FC<{ token: Tokens.Heading }> = ({ token }) => {
  const prefix = "#".repeat(Math.min(token.depth, 6));
  return (
    <Box marginTop={token.depth === 1 ? 1 : 0} marginBottom={0}>
      <Text color={THEME.accent} bold>
        {prefix}{" "}
      </Text>
      <Text color={THEME.text} bold>
        <InlineTokens tokens={token.tokens ?? []} />
      </Text>
    </Box>
  );
};

const ParagraphToken: React.FC<{ token: Tokens.Paragraph }> = ({ token }) => (
  <Box marginBottom={1}>
    <Text color={THEME.text}>
      <InlineTokens tokens={token.tokens ?? []} />
    </Text>
  </Box>
);

const ListToken: React.FC<{ token: Tokens.List; depth?: number }> = ({
  token,
  depth = 0,
}) => {
  const indent = "  ".repeat(depth);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {token.items.map((item, i) => (
        <ListItem
          key={i}
          item={item}
          marker={token.ordered ? `${Number(token.start ?? 1) + i}.` : "·"}
          indent={indent}
          depth={depth}
        />
      ))}
    </Box>
  );
};

const ListItem: React.FC<{
  item: Tokens.ListItem;
  marker: string;
  indent: string;
  depth: number;
}> = ({ item, marker, indent, depth }) => (
  <Box flexDirection="column">
    <Box>
      <Text color={THEME.accent}>
        {indent}
        {marker}{" "}
      </Text>
      <Text color={THEME.text}>
        <InlineTokens tokens={inlineFromItem(item)} />
      </Text>
    </Box>
    {item.tokens
      .filter((t) => t.type === "list")
      .map((sub, i) => (
        <ListToken key={i} token={sub as Tokens.List} depth={depth + 1} />
      ))}
  </Box>
);

/** Pull just the inline content out of a list item (skip nested blocks). */
function inlineFromItem(item: Tokens.ListItem): Tokens.Generic[] {
  // Find the first paragraph or text token; that's the visible content.
  for (const tok of item.tokens) {
    if (tok.type === "text") {
      return (tok as Tokens.Text).tokens ?? [{ type: "text", raw: (tok as Tokens.Text).text, text: (tok as Tokens.Text).text } as Tokens.Generic];
    }
    if (tok.type === "paragraph") {
      return (tok as Tokens.Paragraph).tokens ?? [];
    }
  }
  return [];
}

const CodeToken: React.FC<{ token: Tokens.Code }> = ({ token }) => {
  let body = token.text;
  if (token.lang) {
    try {
      body = highlight(token.text, { language: token.lang, ignoreIllegals: true });
    } catch {
      // Unknown language — fall back to plain.
    }
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.border}
      paddingX={1}
      marginBottom={1}
    >
      {token.lang && (
        <Box marginBottom={0}>
          <Text color={THEME.muted}>{token.lang}</Text>
        </Box>
      )}
      <Text>{body}</Text>
    </Box>
  );
};

const BlockquoteToken: React.FC<{ token: Tokens.Blockquote }> = ({ token }) => (
  <Box marginBottom={1} flexDirection="row">
    <Box marginRight={1}>
      <Text color={THEME.accent}>│</Text>
    </Box>
    <Box flexDirection="column">
      {(token.tokens ?? []).map((tok, i) => (
        <BlockToken key={i} token={tok} />
      ))}
    </Box>
  </Box>
);

const TableToken: React.FC<{ token: Tokens.Table }> = ({ token }) => {
  // Build a list of rows: header first, then body rows.
  const rows: string[][] = [
    token.header.map((c) => extractInlineText(c.tokens ?? [])),
    ...token.rows.map((row) => row.map((c) => extractInlineText(c.tokens ?? []))),
  ];
  // Column widths.
  const colCount = rows[0].length;
  const widths = Array(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      widths[i] = Math.max(widths[i], (row[i] ?? "").length);
    }
  }
  const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
  return (
    <Box flexDirection="column" marginBottom={1}>
      {rows.map((row, ri) => (
        <React.Fragment key={ri}>
          <Box>
            {row.map((cell, ci) => (
              <Text
                key={ci}
                color={ri === 0 ? THEME.accent : THEME.text}
                bold={ri === 0}
              >
                {" "}
                {cell.padEnd(widths[ci])}{" "}
                {ci < colCount - 1 ? "│" : ""}
              </Text>
            ))}
          </Box>
          {ri === 0 && (
            <Box>
              <Text color={THEME.border}>{sep}</Text>
            </Box>
          )}
        </React.Fragment>
      ))}
    </Box>
  );
};

// ─── Inline-level tokens ──────────────────────────────────────────────────

const InlineTokens: React.FC<{ tokens: Tokens.Generic[] }> = ({ tokens }) => (
  <>{tokens.map((tok, i) => <InlineToken key={i} token={tok} />)}</>
);

const InlineToken: React.FC<{ token: Tokens.Generic }> = ({ token }) => {
  switch (token.type) {
    case "text":
      // v5.9.0 (#101 phase γ): scan plain text for memory-id citations and
      // turn each match into a brand-red OSC8 hyperlink. Non-matching text
      // passes through unchanged.
      return <CitationText text={(token as Tokens.Text).text} />;
    case "strong":
      return (
        <Text bold color={THEME.accent}>
          <InlineTokens tokens={(token as Tokens.Strong).tokens ?? []} />
        </Text>
      );
    case "em":
      return (
        <Text italic>
          <InlineTokens tokens={(token as Tokens.Em).tokens ?? []} />
        </Text>
      );
    case "codespan":
      return (
        <Text color={THEME.accentHover} backgroundColor={THEME.code}>
          {" "}
          {(token as Tokens.Codespan).text}
          {" "}
        </Text>
      );
    case "del":
      return (
        <Text strikethrough color={THEME.muted}>
          <InlineTokens tokens={(token as Tokens.Del).tokens ?? []} />
        </Text>
      );
    case "link": {
      const link = token as Tokens.Link;
      // ink doesn't have a link primitive at the inline level — render text
      // + " (url)" in muted. v5.8.3-style OSC8 wrap could go here later.
      return (
        <>
          <Text color={THEME.accentHover} underline>
            <InlineTokens tokens={link.tokens ?? []} />
          </Text>
          <Text color={THEME.muted}> ({link.href})</Text>
        </>
      );
    }
    case "br":
      return <>{"\n"}</>;
    default:
      return <>{(token as { raw?: string }).raw ?? ""}</>;
  }
};

function extractInlineText(tokens: Tokens.Generic[]): string {
  return tokens
    .map((t) => {
      const tok = t as unknown as { text?: string; raw?: string };
      if (typeof tok.text === "string") return tok.text;
      if (typeof tok.raw === "string") return tok.raw;
      return "";
    })
    .join("");
}
