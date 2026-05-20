/**
 * Cold-start (linear wizard) rendering helpers — v5.9.3 redesign.
 *
 * These pure render functions replace the bespoke banner/box drawing
 * inside `runSetup()` with the new atom-based layout. They produce
 * strings (no I/O) so they're snapshot-testable.
 */

import { Header } from "./ui/header.js";
import { Title } from "./ui/title.js";
import { Footer } from "./ui/footer.js";
import { Status } from "./ui/status.js";

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
 * Done screen (Screen 1.5 — Panel-based summary plus three curated next
 * steps).
 */
export function renderColdStartDone(summary: {
  provider: string;
  model: string;
  keySource: string;
  ides: string[];
  dreamEnabled: boolean;
}): string {
  const lines: string[] = [];
  lines.push(Status("ok", "setup complete"));
  lines.push("");
  // The Panel is rendered by the caller via the atom; here we just
  // return the rows since `runSetup()` will pass them to Panel().
  // (Tests call renderDonePanelRows directly.)
  return lines.join("\n");
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
