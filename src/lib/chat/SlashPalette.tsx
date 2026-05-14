/**
 * SlashPalette — Claude-Code-style filterable popup for slash commands.
 *
 * v5.8.0 (#5).
 *
 * Renders below the input field when the user types `/` at column 0.
 * Filters the command registry by what's been typed after the slash.
 * Arrow keys move selection, Enter accepts (the parent replaces the
 * input buffer with the chosen command), Escape dismisses.
 *
 * This component is presentational — the parent (`render.tsx`) owns
 * the open/closed state, the filter text, and dispatches selection
 * back into its own input. Keeping it dumb makes it trivial to test
 * and reuse.
 */

import React from "react";
import { Box, Text } from "ink";
import { CommandSpec } from "./commands.js";

export interface SlashPaletteProps {
  /** Full text currently in the input buffer (used to filter). */
  filter: string;
  /** All available commands. Typically `listCommands()`. */
  commands: CommandSpec[];
  /** Index of the currently highlighted match. Parent owns this. */
  selectedIndex: number;
  /** Max number of matches to render. Default 8 (Claude Code matches this). */
  maxItems?: number;
}

const SHORTCUT_HINT = "↑↓ navigate · Enter select · Esc dismiss";

/**
 * Filter helper — shared between the palette and the parent so both stay in
 * sync about which list element a given index points at.
 */
export function filterCommands(
  commands: CommandSpec[],
  filter: string,
): CommandSpec[] {
  // Strip the leading slash from the user's query so "/he" matches "/help".
  const q = filter.replace(/^\/+/, "").toLowerCase().trim();
  if (!q) return commands;
  return commands.filter((c) => {
    const name = c.name.toLowerCase().replace(/^\/+/, "");
    const summary = c.summary.toLowerCase();
    if (name.startsWith(q)) return true;
    if (name.includes(q)) return true;
    if (summary.includes(q)) return true;
    return c.aliases?.some((a) => a.toLowerCase().replace(/^\/+/, "").includes(q)) ?? false;
  });
}

export const SlashPalette: React.FC<SlashPaletteProps> = ({
  filter,
  commands,
  selectedIndex,
  maxItems = 8,
}) => {
  const matches = filterCommands(commands, filter);

  if (matches.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor="gray">
        <Text dimColor>No matching commands for "{filter}"</Text>
        <Text dimColor>{SHORTCUT_HINT}</Text>
      </Box>
    );
  }

  // Window the list around the selected index so long lists stay readable.
  const safeIdx = Math.max(0, Math.min(selectedIndex, matches.length - 1));
  let start = 0;
  let end = Math.min(matches.length, maxItems);
  if (matches.length > maxItems) {
    // Center the selection if possible.
    const half = Math.floor(maxItems / 2);
    start = Math.max(0, Math.min(safeIdx - half, matches.length - maxItems));
    end = start + maxItems;
  }
  const visible = matches.slice(start, end);
  const moreAbove = start > 0;
  const moreBelow = end < matches.length;

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor="cyan">
      {moreAbove && <Text dimColor>↑ {start} more above</Text>}
      {visible.map((cmd, i) => {
        const actualIdx = start + i;
        const isSelected = actualIdx === safeIdx;
        return (
          <Box key={cmd.name} flexDirection="row">
            <Text color={isSelected ? "black" : undefined} backgroundColor={isSelected ? "cyan" : undefined}>
              {isSelected ? "▶ " : "  "}
              {cmd.name.padEnd(18)}
            </Text>
            <Text dimColor> {cmd.summary}</Text>
          </Box>
        );
      })}
      {moreBelow && <Text dimColor>↓ {matches.length - end} more below</Text>}
      <Text dimColor>{SHORTCUT_HINT}</Text>
    </Box>
  );
};
