/**
 * Cold-start (linear wizard) rendering helpers — v5.9.3 redesign.
 *
 * These pure render functions replace the bespoke banner/box drawing
 * inside `runSetup()` with the new atom-based layout. They produce
 * strings (no I/O) so they're snapshot-testable.
 *
 * Screens 1.1 (provider), 1.2 (model), 1.3 (key) get their headers
 * here. The actual provider/model pickers stay in `setup.ts` —
 * pickProvider / pickModel are called from multiple paths and were
 * intentionally left untouched per the v5.9.3 brief; the cold-start
 * sub-screen functions wrap the picker invocations with the header
 * chrome.
 */

import { Header } from "./ui/header.js";
import { Title } from "./ui/title.js";
import { Footer } from "./ui/footer.js";
import { c, color, glyph } from "./ui/tokens.js";

/**
 * Splash screen body (Screen 1.0 in the design handoff). The caller
 * follows up with the "press enter to begin" prompt.
 */
export function renderColdStartSplash(version: string): string {
  const v = version.startsWith("v") ? version : `v${version}`;
  const lines: string[] = [];
  lines.push(Header(["gnosys", "setup"], { version: v }));
  lines.push("");
  lines.push(Title("Welcome."));
  lines.push("");
  lines.push(" gnosys gives your AI agents persistent memory — a centralized brain");
  lines.push(" they keep across sessions. This wizard takes about 90 seconds.");
  lines.push("");
  lines.push("   step 1   pick a default LLM provider");
  lines.push("   step 2   validate the API key");
  lines.push("   step 3   wire up MCP for detected IDEs");
  lines.push("   step 4   (optional) task routing & dream mode");
  lines.push("");
  lines.push(Footer("^C exits cleanly at any time"));
  return lines.join("\n");
}

/**
 * Step header — used as the banner of each cold-start sub-screen
 * (1.1 provider, 1.2 model, 1.3 key, 1.5 done). Renders the breadcrumb
 * with the version on the right plus the "step N of M" mid-line.
 */
export function renderStepHeader(
  crumbs: string[],
  step: number,
  total: number,
  version: string,
): string {
  const v = version.startsWith("v") ? version : `v${version}`;
  return Header([...crumbs], { version: `step ${step} of ${total}    ${v}` });
}

/**
 * Body rows for the "ready" panel on screen 1.5. Exported so the wizard
 * can hand them to Panel() and snapshot tests can verify the rows
 * independently.
 */
export function renderDonePanelRows(summary: {
  provider: string;
  model: string;
  keySource: string;
  ides: string[];
  dreamEnabled: boolean;
}): string[] {
  const idesStr = summary.ides.length === 0 ? "(none)" : summary.ides.join(", ");
  const dreamStr = summary.dreamEnabled
    ? "enabled"
    : "disabled · enable later with `gnosys setup`";
  return [
    pad("provider", summary.provider),
    pad("model", summary.model),
    pad("api key", summary.keySource),
    pad("ides", idesStr),
    pad("dream mode", dreamStr),
  ];
}

function pad(label: string, value: string): string {
  return `${label.padEnd(18)}${value}`;
}

// ─── Screens 1.1 / 1.2 / 1.3 — sub-screen headers ────────────────────────

/**
 * Screen 1.1 — provider sub-screen header. Renders the breadcrumb +
 * step counter + Title + intro line. The caller follows up with the
 * existing pickProvider() call to print the actual numbered menu.
 */
export function renderProviderStepHeader(version: string): string {
  const lines: string[] = [];
  lines.push(renderStepHeader(["gnosys", "setup", "provider"], 1, 4, version));
  lines.push("");
  lines.push(Title("Choose your LLM provider", "prices are per-1M-tokens (input – output)"));
  return lines.join("\n");
}

/**
 * Screen 1.2 — model sub-screen header. Includes the provider name in
 * the breadcrumb so the user knows which catalog they're picking from.
 */
export function renderModelStepHeader(provider: string, version: string): string {
  const lines: string[] = [];
  lines.push(renderStepHeader(["gnosys", "setup", "provider", "model"], 2, 4, version));
  lines.push("");
  lines.push(Title(`Choose a model for ${provider}`));
  return lines.join("\n");
}

/**
 * Screen 1.3 — API key sub-screen header. Shows the provider name and
 * a one-line subtitle reminding the user that we validate the key
 * before saving.
 */
export function renderKeyStepHeader(provider: string, version: string): string {
  const lines: string[] = [];
  lines.push(renderStepHeader(["gnosys", "setup", "key"], 3, 4, version));
  lines.push("");
  lines.push(Title(`API key for ${provider}`, "we'll validate it before saving anything"));
  return lines.join("\n");
}

/**
 * Render the key-source picker rows. Each row has a number, a label, a
 * meta column, and an optional `◂ found` tag when the env var is
 * actually set. Returns the array of lines so the caller can
 * concatenate them around its own prompt.
 */
export interface KeySourceRow {
  /** "environment variable" / "macos keychain" / "paste inline" / "skip for now". */
  label: string;
  /** Right-side meta (env var name, "(will store securely)", etc.). */
  meta: string;
  /** When true, append the `◂ found` tag in `ok` color. */
  found?: boolean;
}

export function renderKeySourceRows(rows: KeySourceRow[]): string[] {
  const labelW = Math.max(...rows.map((r) => r.label.length)) + 2;
  const out: string[] = [];
  rows.forEach((r, i) => {
    const num = color(c.textDim, String(i + 1).padStart(2, " "));
    const label = color(c.text, r.label.padEnd(labelW));
    const meta = color(c.textDim, r.meta);
    const tag = r.found ? `   ${color(c.ok, `${glyph.tag} found`)}` : "";
    out.push(`    ${num}   ${label}${meta}${tag}`);
  });
  return out;
}

export function renderKeyStepFooter(): string {
  return Footer("1–4 · pick    b · back");
}
