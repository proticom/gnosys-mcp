/**
 * Shared store-path resolution for setup wizards (v5.9.4 — Bug 10).
 *
 * Before v5.9.4, three call sites resolved which `gnosys.json` to read/
 * write — `summary.ts::resolveActiveStorePath`, `setup.ts::loadExistingConfig`,
 * and `setup.ts::pickStorePath` — each with subtly different rules. The
 * model picker would read the global config while the summary panel was
 * reading the project config (or vice versa), producing the v5.9.3 bug
 * where `setup models` displayed `current: grok-4.20` while gnosys.json
 * actually held `grok-4.3`.
 *
 * From v5.9.4 onward, any code that reads config + selects a store goes
 * through `resolveActiveStorePath()` (read-only resolution) or
 * `ensureActiveStorePath()` (write resolution — creates global home if
 * neither store exists yet). Grep the codebase for `loadConfig(` and
 * `updateConfig(` to confirm every caller routes through here.
 */

import fsSync from "fs";
import path from "path";
import { getGnosysHome } from "../paths.js";

/**
 * Return the store path to READ from. Project-level `.gnosys/` is preferred
 * when its `gnosys.json` exists; otherwise the global `~/.gnosys/` home.
 * Does NOT create directories — safe to call when no config exists yet.
 */
export function resolveActiveStorePath(projectDir: string): string {
  const projectStore = path.join(projectDir, ".gnosys");
  if (fsSync.existsSync(path.join(projectStore, "gnosys.json"))) return projectStore;
  return getGnosysHome();
}

/**
 * Return the store path to WRITE to. Project-level if its `gnosys.json`
 * exists, else the global home (created if missing). Distinct from
 * `resolveActiveStorePath` only by the `mkdir` side-effect.
 */
export function ensureActiveStorePath(projectDir: string): string {
  const projectStore = path.join(projectDir, ".gnosys");
  if (fsSync.existsSync(path.join(projectStore, "gnosys.json"))) return projectStore;
  const globalStore = getGnosysHome();
  if (!fsSync.existsSync(globalStore)) {
    fsSync.mkdirSync(globalStore, { recursive: true });
  }
  return globalStore;
}
