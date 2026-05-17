/**
 * v5.9.0 chat TUI theme.
 *
 * Single source of truth for chat colors. Values are pulled from the
 * gnosys-site dark theme — keep them in sync if the site palette changes.
 *
 * Hex strings are passed directly to ink's `<Text color="...">` prop, which
 * supports rgb / hex / named colors via chalk under the hood.
 */

export const THEME = {
  // ── Backgrounds ────────────────────────────────────────────────────────
  bg: "#12141A",       // page background (terminal default usually wins here)
  surface: "#1A1C24",  // card / overlay background
  code: "#1E2028",     // code-block background
  border: "#2A2C34",   // hairline borders / dividers

  // ── Text ───────────────────────────────────────────────────────────────
  text: "#E4E2E8",     // primary text
  secondary: "#A8A6B0", // de-emphasized text
  muted: "#6E6C78",    // hints / placeholders / system notices

  // ── Accents ────────────────────────────────────────────────────────────
  accent: "#C04C4C",       // brand brick red — gnosys signature
  accentHover: "#D46A6A",  // hover / active / citation underline
  accentFaint: "#F5EAEA",  // soft wash (rare in TUI)

  // ── States ─────────────────────────────────────────────────────────────
  success: "#6BCB77",
  warn: "#F59E0B",
  error: "#EF4444",
} as const;

/**
 * Role-to-color mapping for the chat buffer. Use these (not THEME.*
 * directly) wherever we render role-tagged content, so swapping the
 * mapping later only touches one place.
 */
export const ROLES = {
  user: THEME.accent,        // user turn label
  assistant: THEME.text,     // assistant prose
  emphasis: THEME.accent,    // bold / headings inside assistant turns
  system: THEME.muted,       // system notices
  citation: THEME.accentHover, // inline memory citations
  toolCallBorder: THEME.accent,
  spinner: THEME.accent,
} as const;
