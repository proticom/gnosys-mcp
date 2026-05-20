/**
 * Design tokens for the gnosys CLI redesign (v5.9.3).
 *
 * Two palettes — truecolor (24-bit) and 256-color fallback — both export
 * the same names. Call sites use `c.accent`, `c.text`, etc. and never
 * see raw ANSI bytes. Detection is via the `COLORTERM` env var.
 *
 * Tokens map 1:1 to the design handoff §1 table.
 */

/** Reset escape. Always pure. */
export const RESET = "\x1b[0m";

/** True if the terminal advertises 24-bit color. */
export const TRUECOLOR =
  process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";

/** ANSI color token bundle. Same shape regardless of palette. */
export interface ColorTokens {
  accent: string;
  accentHi: string;
  accentDim: string;
  text: string;
  textHi: string;
  textMid: string;
  textDim: string;
  textGhost: string;
  ok: string;
  warn: string;
  fail: string;
}

const truecolor: ColorTokens = {
  accent:    "\x1b[38;2;192;76;76m",
  accentHi:  "\x1b[38;2;224;136;136m",
  accentDim: "\x1b[38;2;122;46;46m",
  text:      "\x1b[38;2;214;210;218m",
  textHi:    "\x1b[1m\x1b[38;2;255;255;255m",
  textMid:   "\x1b[38;2;154;150;162m",
  textDim:   "\x1b[38;2;110;108;120m",
  textGhost: "\x1b[38;2;60;58;68m",
  ok:        "\x1b[38;2;125;181;138m",
  warn:      "\x1b[38;2;201;168;106m",
  fail:      "\x1b[38;2;192;76;76m",
};

const c256: ColorTokens = {
  accent:    "\x1b[38;5;167m",
  accentHi:  "\x1b[38;5;174m",
  accentDim: "\x1b[38;5;88m",
  text:      "\x1b[38;5;252m",
  textHi:    "\x1b[1m",
  textMid:   "\x1b[38;5;246m",
  textDim:   "\x1b[38;5;242m",
  textGhost: "\x1b[38;5;238m",
  ok:        "\x1b[38;5;108m",
  warn:      "\x1b[38;5;179m",
  fail:      "\x1b[38;5;167m",
};

/** Active palette. Read at module init from `COLORTERM`. */
export const c: ColorTokens = TRUECOLOR ? truecolor : c256;

/** Wrap text in a color, automatically appending RESET. */
export function color(token: string, text: string): string {
  return `${token}${text}${RESET}`;
}

/** Glyphs used across the redesign. */
export const glyph = {
  brand: "⬢",      // ⬢
  sep: "▸",        // ▸
  prompt: "❯",     // ❯
  selection: "▶",  // ▶
  tag: "◂",        // ◂
  ok: "✓",         // ✓
  warn: "⚠",       // ⚠
  fail: "✗",       // ✗
  spin0: "◌",      // ◌
  spin1: "◐",      // ◐
  spin2: "◑",      // ◑
  spin3: "◒",      // ◒
  spin4: "◓",      // ◓
  dotFilled: "●",  // ●
  dotHollow: "○",  // ○
  arrow: "→",      // →
  ruleLight: "─",  // ─
  ruleHeavy: "━",  // ━
  boxTL: "╭",      // ╭
  boxTR: "╮",      // ╮
  boxBL: "╰",      // ╰
  boxBR: "╯",      // ╯
  boxV:  "│",      // │
  boxH:  "─",      // ─
} as const;

/**
 * Width of the terminal, captured at module init. Targets 80 cols and
 * tolerates wider. Never reflows on resize — same constraint as the design.
 */
export const COLS: number = (() => {
  const raw = process.stdout.columns;
  if (typeof raw !== "number" || raw <= 0) return 80;
  return raw;
})();

/** Effective render width: clamp to >= 80 unless explicitly narrower. */
export function width(): number {
  return Math.max(80, COLS);
}
