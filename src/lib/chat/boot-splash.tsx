/**
 * v5.9.0 chat boot splash — lowercase italic "gnosys" wordmark with the
 * brand-red polygonal `o`.
 *
 * Pre-rendered from figlet's "Small Slant" font, then sliced so cols
 * 11..15 of each row (the `o` letter) can be tinted with the brand
 * accent while the rest of the wordmark uses the primary text color.
 *
 * 4 visible rows × 29 cols — fits any terminal ≥80 cols comfortably.
 */

import type React from "react";
import { Box, Text } from "ink";
import { THEME } from "./theme.js";

interface Row {
  before: string;
  o: string;
  after: string;
}

const SPLASH_ROWS: Row[] = [
  { before: "  ___ ____ ", o: " ___ ", after: " ___ __ _____" },
  { before: " / _ `/ _ \\", o: "/ _ \\", after: "(_-</ // (_-<" },
  { before: " \\_, /_//_/", o: "\\___/", after: "___/\\_, /___/" },
  { before: "/___/      ", o: "     ", after: "   /___/     " },
];

export interface BootSplashProps {
  /** Subtitle line under the wordmark — usually the version + tagline. */
  subtitle?: string;
}

export const BootSplash: React.FC<BootSplashProps> = ({ subtitle }) => (
  <Box flexDirection="column" marginTop={1} marginBottom={1}>
    {SPLASH_ROWS.map((row, i) => (
      <Box key={i}>
        <Text color={THEME.text}>{row.before}</Text>
        <Text color={THEME.accent} bold>
          {row.o}
        </Text>
        <Text color={THEME.text}>{row.after}</Text>
      </Box>
    ))}
    {subtitle && (
      <Box marginTop={1}>
        <Text color={THEME.muted}>  {subtitle}</Text>
      </Box>
    )}
  </Box>
);
