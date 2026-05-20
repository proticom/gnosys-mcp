/**
 * `gnosys cleanup` — remove stale entries from the project registry.
 *
 * Three categories:
 *   alive — directory still exists and has a `.gnosys/` subdir
 *   dead  — directory missing or no `.gnosys/` subdir
 *   temp  — path starts with /tmp, /private/tmp, /var/folders, /private/var/folders, or os.tmpdir()
 *
 * Interactive mode (default): print the categorized list, then prompt
 * `Remove N entries? [Y/n]` before writing.
 *
 * Non-interactive mode (`--yes`): write the filtered registry directly.
 * `--dry-run` (or `interactive=false, yes=false`) just returns the diff
 * without writing.
 *
 * Implementation: read the registry via `getProjectRegistryPath()`, do
 * the classification, write back only the alive paths. The central DB
 * is untouched — its projects table is a separate concern and may
 * reasonably keep history for federated search.
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { getProjectRegistryPath } from "./paths.js";
import { safeQuestion } from "./setup/ui/safePrompt.js";
import { Header } from "./setup/ui/header.js";
import { Status } from "./setup/ui/status.js";
import { c, color, glyph } from "./setup/ui/tokens.js";

export interface ClassifiedRegistry {
  alive: string[];
  dead: string[];
  temp: string[];
}

const TEMP_PREFIXES = [
  "/tmp/",
  "/private/tmp/",
  "/var/folders/",
  "/private/var/folders/",
];

function isTempPath(p: string): boolean {
  const resolved = path.resolve(p);
  if (TEMP_PREFIXES.some((prefix) => resolved.startsWith(prefix))) return true;
  // Honor the system tmpdir too (covers $TMPDIR overrides on CI etc.).
  const sysTmp = path.resolve(os.tmpdir()) + path.sep;
  return resolved.startsWith(sysTmp);
}

function isAlive(p: string): boolean {
  try {
    const stat = fsSync.statSync(path.join(p, ".gnosys"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the registry and classify each entry. Missing registry → empty
 * categories (caller can treat as nothing-to-do).
 */
export async function classifyRegistryEntries(): Promise<ClassifiedRegistry> {
  const registryPath = getProjectRegistryPath();
  let entries: string[] = [];
  try {
    const raw = await fs.readFile(registryPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      entries = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // No registry — nothing to do.
    return { alive: [], dead: [], temp: [] };
  }

  const alive: string[] = [];
  const dead: string[] = [];
  const temp: string[] = [];
  for (const e of entries) {
    if (isTempPath(e)) {
      temp.push(e);
    } else if (isAlive(e)) {
      alive.push(e);
    } else {
      dead.push(e);
    }
  }
  return { alive, dead, temp };
}

export interface CleanupOptions {
  /** Print the list and prompt before writing. */
  interactive: boolean;
  /** Non-interactive write (only used when `interactive === false`). */
  yes?: boolean;
  /** Optional readline (when called from inside `setup sync-projects`). */
  rl?: import("readline/promises").Interface;
}

export interface CleanupResult {
  /** Number of entries removed (dead + temp). */
  removed: number;
  /** Number of entries kept (alive). */
  kept: number;
  /** True when the registry was actually rewritten. */
  wrote: boolean;
}

function formatPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home + path.sep)) {
    return `~${path.sep}${p.slice(home.length + 1)}`;
  }
  return p;
}

function printCategorized(categorized: ClassifiedRegistry): void {
  if (categorized.alive.length > 0) {
    process.stdout.write(`\n ${color(c.text, "alive")}     ${color(c.textDim, `(${categorized.alive.length})`)}\n`);
    for (const p of categorized.alive) {
      process.stdout.write(`   ${color(c.ok, glyph.ok)}  ${color(c.textDim, formatPath(p))}\n`);
    }
  }
  if (categorized.dead.length > 0) {
    process.stdout.write(`\n ${color(c.text, "dead")}      ${color(c.textDim, `(${categorized.dead.length}) — no .gnosys/ directory`)}\n`);
    for (const p of categorized.dead) {
      process.stdout.write(`   ${color(c.fail, glyph.fail)}  ${color(c.textDim, formatPath(p))}\n`);
    }
  }
  if (categorized.temp.length > 0) {
    process.stdout.write(`\n ${color(c.text, "temp")}      ${color(c.textDim, `(${categorized.temp.length}) — under /tmp or /var/folders`)}\n`);
    for (const p of categorized.temp) {
      process.stdout.write(`   ${color(c.warn, glyph.warn)}  ${color(c.textDim, formatPath(p))}\n`);
    }
  }
  process.stdout.write("\n");
}

async function writeAlive(alivePaths: string[]): Promise<void> {
  const registryPath = getProjectRegistryPath();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify(alivePaths, null, 2), "utf-8");
}

/**
 * Run the cleanup. Interactive mode prompts before writing; non-interactive
 * writes when `yes === true`, otherwise just returns the diff (dry run).
 */
export async function cleanupRegistry(opts: CleanupOptions): Promise<CleanupResult> {
  const categorized = await classifyRegistryEntries();
  const toRemove = categorized.dead.length + categorized.temp.length;

  if (toRemove === 0) {
    if (opts.interactive) {
      process.stdout.write(`${Status("ok", "project registry is already clean", `${categorized.alive.length} entries`)}\n`);
    }
    return { removed: 0, kept: categorized.alive.length, wrote: false };
  }

  if (opts.interactive) {
    process.stdout.write("\n");
    process.stdout.write(Header(["gnosys", "cleanup"]) + "\n\n");
    process.stdout.write(`${Status("warn", `${toRemove} stale registry entries`, `${categorized.alive.length} alive`)}\n`);
    printCategorized(categorized);

    const ownsRl = !opts.rl;
    const rl = opts.rl ?? createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await safeQuestion(rl, ` ${color(c.accent, glyph.prompt)} remove ${toRemove} entries? [Y/n] `))
        .trim()
        .toLowerCase();
      if (answer === "n" || answer === "no") {
        process.stdout.write(`${Status("warn", "registry left unchanged")}\n`);
        return { removed: 0, kept: categorized.alive.length, wrote: false };
      }
    } finally {
      if (ownsRl) rl.close();
    }
  } else if (!opts.yes) {
    // Dry-run.
    if (toRemove > 0) printCategorized(categorized);
    return { removed: toRemove, kept: categorized.alive.length, wrote: false };
  }

  await writeAlive(categorized.alive);
  if (opts.interactive) {
    process.stdout.write(`${Status("ok", `removed ${toRemove} entries`, `${categorized.alive.length} kept`)}\n`);
  }
  return { removed: toRemove, kept: categorized.alive.length, wrote: true };
}
