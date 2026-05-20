/**
 * Render helpers for `gnosys config set` (Screen 13).
 *
 * Provides:
 *   - Schema/key validation against a known set of config keys
 *   - Levenshtein-based "did you mean?" suggestion on typo
 *   - Helpers to label the active store as `(project)` or `(global)`
 *
 * Output rendering is deferred to the cli.ts action so we don't drag the
 * full config schema into this module — but the validator and the
 * suggestion logic are pure and snapshot-testable.
 */
import path from "path";

/**
 * Known top-level keys accepted by `gnosys config set`. Mirrors the switch
 * cases in cli.ts; keep these in sync when a new branch is added.
 */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  "provider",
  "model",
  "task",
  "ollama-url",
  "ollama-model",
  "anthropic-model",
  "groq-model",
  "openai-model",
  "openai-url",
  "lmstudio-url",
  "lmstudio-model",
  "xai-model",
  "mistral-model",
  "custom-url",
  "custom-model",
  "custom-key",
  "recall",
];

/**
 * Validate a user-supplied config key. Returns the closest known key
 * (by edit distance) when the input doesn't match exactly. The caller
 * uses the suggestion to render a `did you mean X?` hint.
 */
export function suggestConfigKey(input: string): string | null {
  if (KNOWN_CONFIG_KEYS.includes(input)) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of KNOWN_CONFIG_KEYS) {
    const d = levenshtein(input, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  // Only suggest when the edit distance is small enough to be plausibly
  // a typo. Anything > 3 is a wild miss — don't suggest.
  return bestDist <= 3 ? best : null;
}

/**
 * Classify a store path as `project` or `global`. Used to label both the
 * Diff row and the "saved" status line so the user always knows which
 * store was touched.
 *
 * The convention: store paths under `~/.gnosys` (the central user store)
 * count as global; everything else is project-scoped.
 */
export function classifyStore(storePath: string, homeDir: string): "project" | "global" {
  const globalPath = path.join(homeDir, ".gnosys");
  // Normalize both sides for the comparison so symlinks / trailing slashes
  // don't trip a false negative.
  const norm = path.resolve(storePath);
  return norm === path.resolve(globalPath) ? "global" : "project";
}

/**
 * Compute the Levenshtein edit distance between two strings. Small inputs
 * only — config keys are at most ~20 chars.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,           // insertion
        prev[j] + 1,               // deletion
        prev[j - 1] + cost,        // substitution
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}
