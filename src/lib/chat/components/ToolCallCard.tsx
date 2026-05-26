/**
 * v5.9.0 chat TUI — tool-call card.
 *
 * Renders one `gnosys-tool` invocation that happened inside the current
 * assistant turn. Collapsed by default — shows just the tool name and a
 * one-line args summary. The card can be expanded to reveal full args
 * + truncated result via a parent-controlled `expanded` prop.
 *
 * Visual: rounded border in brand red on dark background, slight inset
 * from the turn body. Errors render with the error red.
 */

import type React from "react";
import { Box, Text } from "ink";
import type { ToolCallRecord } from "../types.js";
import { THEME } from "../theme.js";

export interface ToolCallCardProps {
  call: ToolCallRecord;
  /** When true, show args + result. When false, only header + 1-line summary. */
  expanded: boolean;
}

export const ToolCallCard: React.FC<ToolCallCardProps> = ({ call, expanded }) => {
  const isError = !!call.error;
  const borderColor = isError ? THEME.error : THEME.accent;

  const argList = Object.entries(call.args);
  const argSummary =
    argList.length === 0
      ? ""
      : argList
          .map(([k, v]) => `${k}=${truncate(String(v), 28)}`)
          .join("  ");

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginBottom={1}
    >
      {/* Header line */}
      <Box>
        <Text color={borderColor} bold>
          {expanded ? "▼" : "▶"} {call.tool}
        </Text>
        {!expanded && argSummary && (
          <Text color={THEME.muted}>{"  "}{argSummary}</Text>
        )}
      </Box>

      {/* Expanded body */}
      {expanded && (
        <Box flexDirection="column" marginTop={1}>
          {argList.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color={THEME.secondary}>args:</Text>
              {argList.map(([k, v]) => (
                <Box key={k} marginLeft={2}>
                  <Text color={THEME.accent}>{k}</Text>
                  <Text color={THEME.muted}> = </Text>
                  <Text color={THEME.text}>{String(v)}</Text>
                </Box>
              ))}
            </Box>
          )}
          {isError ? (
            <Box flexDirection="column">
              <Text color={THEME.error}>error:</Text>
              <Box marginLeft={2}>
                <Text color={THEME.text}>{call.error}</Text>
              </Box>
            </Box>
          ) : (
            call.result !== undefined && (
              <Box flexDirection="column">
                <Text color={THEME.secondary}>result:</Text>
                <Box marginLeft={2}>
                  <Text color={THEME.text}>{truncate(call.result, 800)}</Text>
                </Box>
              </Box>
            )
          )}
        </Box>
      )}
    </Box>
  );
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
