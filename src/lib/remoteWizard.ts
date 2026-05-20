/**
 * Interactive wizard for `gnosys remote configure`.
 *
 * Handles three primary scenarios:
 *  1. Fresh setup — local DB only, configuring a remote for the first time
 *  2. Reconfigure — already have a remote, want to change it or disconnect
 *  3. Join existing — second machine joining a remote that already has data
 */

import { readdirSync, statSync } from "fs";
import * as path from "path";
import { createInterface, Interface } from "readline/promises";
import { GnosysDB } from "./db.js";
import { RemoteSync, validateLocation } from "./remote.js";
import { safeQuestion } from "./setup/ui/safePrompt.js";
import { Spinner } from "./setup/ui/spinner.js";
import { printStatus } from "./setup/ui/status.js";
import { Footer } from "./setup/ui/footer.js";
import {
  renderRemoteIntro,
  renderValidationSummary,
  renderRemoteDiff,
  SYNC_MODE_LABELS,
  type SyncMode,
} from "./setup/remoteRender.js";

const REMOTE_PATH_KEY = "remote_path";
const REMOTE_MODE_KEY = "remote_mode";

// ─── Helpers ────────────────────────────────────────────────────────────

/** List likely remote candidates from /Volumes/. Filters out system volumes. */
function detectVolumeCandidates(): string[] {
  try {
    const entries = readdirSync("/Volumes");
    const skip = new Set([
      "Macintosh HD",
      "Macintosh HD - Data",
      "Recovery",
      "Update",
      "Preboot",
      "VM",
    ]);
    return entries
      .filter((name) => !name.startsWith(".") && !skip.has(name))
      .filter((name) => !/Backups of /i.test(name))
      .map((name) => `/Volumes/${name}`)
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

async function ask(rl: Interface, prompt: string): Promise<string> {
  return (await safeQuestion(rl, prompt)).trim();
}

async function askChoice(
  rl: Interface,
  prompt: string,
  choices: { key: string; label: string }[],
  defaultKey?: string
): Promise<string> {
  const lines = [prompt];
  for (const c of choices) {
    const marker = c.key === defaultKey ? " (default)" : "";
    lines.push(`  ${c.key}) ${c.label}${marker}`);
  }
  console.log(lines.join("\n"));
  const valid = new Set(choices.map((c) => c.key));
  for (let attempts = 0; attempts < 5; attempts++) {
    const answer = (await ask(rl, "Choice: ")).toLowerCase();
    if (!answer && defaultKey) return defaultKey;
    if (valid.has(answer)) return answer;
    console.log(`Invalid choice. Pick one of: ${[...valid].join(", ")}`);
  }
  throw new Error("Too many invalid responses");
}

async function askConfirm(rl: Interface, prompt: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await ask(rl, prompt + hint)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function showValidationSummary(validation: Awaited<ReturnType<typeof validateLocation>>): void {
  // v5.9.3 Screen 6 — route through the renderer so each check renders as
  // a `✓` / `✗` status line. Identical content, atom-styled output.
  console.log(
    renderValidationSummary({
      pathExists: validation.checks.pathExists,
      writable: validation.checks.writable,
      sqliteCompatible: validation.checks.sqliteCompatible,
      latencyMs: validation.checks.latencyMs,
      existing: {
        found: validation.checks.existingDb.found,
        memoryCount: validation.checks.existingDb.memoryCount ?? null,
        lastModified: validation.checks.existingDb.lastModified ?? null,
      },
      warnings: validation.warnings,
      errors: validation.errors,
    }),
  );
}

/**
 * Hierarchical sync-mode picker. Per design §4 Screen 6 the default
 * `read & write` is one keystroke (enter), and the other modes hide
 * behind a `more options` affordance.
 *
 * Returns the chosen mode, or null when the user explicitly cancels.
 */
async function pickSyncMode(rl: Interface): Promise<SyncMode | null> {
  console.log("");
  console.log("  Sync mode");
  console.log("");
  console.log(`    1   read & write       ${SYNC_MODE_LABELS["read-write"]}            ◂ recommended`);
  console.log(`    2   more options       pull-only, push-only`);
  console.log("");
  console.log(Footer("1–2 · pick    enter · use recommended"));
  const answer = (await safeQuestion(rl, " > ")).trim();
  if (!answer || answer === "1") return "read-write";
  if (answer !== "2") {
    printStatus("warn", "invalid choice — using `read & write`");
    return "read-write";
  }
  // Nested submenu — all three modes + back.
  console.log("");
  console.log(`    1   read & write       ${SYNC_MODE_LABELS["read-write"]}            ◂ recommended`);
  console.log(`    2   pull-only          ${SYNC_MODE_LABELS["pull-only"]}`);
  console.log(`    3   push-only          ${SYNC_MODE_LABELS["push-only"]}`);
  console.log(`    4   back`);
  console.log("");
  console.log(Footer("1–4 · pick"));
  const sub = (await safeQuestion(rl, " > ")).trim();
  switch (sub) {
    case "1": return "read-write";
    case "2": return "pull-only";
    case "3": return "push-only";
    case "4": return null;
    default:
      printStatus("warn", "invalid choice — using `read & write`");
      return "read-write";
  }
}

// ─── Main wizard ────────────────────────────────────────────────────────

export async function runConfigureWizard(
  centralDb: GnosysDB,
  externalRl?: Interface
): Promise<boolean> {
  const ownsRl = !externalRl;
  const rl = externalRl ?? createInterface({ input: process.stdin, output: process.stdout });
  try {
    const localCount = centralDb.getMemoryCount();
    const currentRemote = centralDb.getMeta(REMOTE_PATH_KEY);

    console.log("");
    console.log(renderRemoteIntro(localCount.active, localCount.archived, currentRemote || null));
    console.log("");

    if (currentRemote) {
      // Reconfigure flow
      const choice = await askChoice(rl, "What would you like to do?", [
        { key: "1", label: "Change remote location" },
        { key: "2", label: "Re-validate current remote" },
        { key: "3", label: "Disconnect remote (back to local-only)" },
        { key: "4", label: "Cancel" },
      ], "4");

      if (choice === "4") return false;
      if (choice === "3") return await disconnectRemote(rl, centralDb);
      if (choice === "2") return await revalidateRemote(rl, centralDb, currentRemote);
      // choice === "1": fall through to setup flow
    }

    // Setup flow (new or change)
    return await setupRemoteFlow(rl, centralDb, localCount.active);
  } finally {
    if (ownsRl) {
      rl.close();
    }
  }
}

// ─── Setup flow ─────────────────────────────────────────────────────────

async function setupRemoteFlow(rl: Interface, centralDb: GnosysDB, localActiveCount: number): Promise<boolean> {
  console.log("");
  console.log("Step 1: Choose remote location");
  console.log("");

  const candidates = detectVolumeCandidates();
  let remotePath: string | undefined;

  if (candidates.length > 0) {
    // askChoice() prints the option list — don't double-print it here.
    const choices = [
      ...candidates.map((_, i) => ({ key: String(i + 1), label: candidates[i] })),
      { key: String(candidates.length + 1), label: "Custom path" },
      { key: String(candidates.length + 2), label: "Skip" },
    ];
    const choice = await askChoice(rl, "Detected mounted volumes — select one:", choices);

    if (choice === String(candidates.length + 2)) return false;
    if (choice === String(candidates.length + 1)) {
      remotePath = await ask(rl, "Custom path (e.g. /Volumes/nas/gnosys): ");
    } else {
      const idx = parseInt(choice, 10) - 1;
      const volume = candidates[idx];
      // Suggest a gnosys subdirectory inside the volume
      const suggested = path.join(volume, "gnosys");
      const useSubdir = await askConfirm(rl, `Use ${suggested} (recommended subdirectory)?`);
      remotePath = useSubdir ? suggested : volume;
    }
  } else {
    console.log("No mounted volumes detected at /Volumes/.");
    console.log("Common options: NAS via SMB/AFP, external drive, or Tailscale-mounted share.\n");
    remotePath = await ask(rl, "Enter remote path (e.g. /Volumes/nas/gnosys): ");
  }

  if (!remotePath) {
    console.log("No path provided. Cancelling.");
    return false;
  }

  // Step 2: Validate — v5.9.3 Screen 6: animate the validation under a
  // Spinner so the path-check feedback lands before the mode picker.
  console.log("");
  const validateSpinner = Spinner(`checking ${remotePath}…`);
  const validation = await validateLocation(remotePath);
  if (validation.ok) {
    const latency = validation.checks.latencyMs;
    validateSpinner.ok("path exists, writable", latency !== null ? `${latency} ms` : undefined);
  } else {
    validateSpinner.fail("validation failed");
  }
  showValidationSummary(validation);

  if (!validation.ok) {
    printStatus("fail", "remote not configured");
    return false;
  }

  if (validation.warnings.length > 0) {
    const proceed = await askConfirm(rl, "Continue despite warnings?", true);
    if (!proceed) return false;
  }

  // v5.9.3 Screen 6 — hierarchical sync-mode picker before data strategy.
  // Default is read-write (one keystroke). Persisted to remote_mode meta.
  const syncMode = await pickSyncMode(rl);
  if (syncMode === null) {
    printStatus("warn", "cancelled at mode picker — no changes written");
    return false;
  }

  // Step 3: Decide what to do based on existing DB state
  console.log("\nStep 3: Data strategy");
  console.log("");

  const remoteHasData = validation.checks.existingDb.found && (validation.checks.existingDb.memoryCount ?? 0) > 0;
  const localHasData = localActiveCount > 0;

  let strategy: "migrate" | "merge" | "pull" | "configure-only" = "configure-only";

  if (!remoteHasData && !localHasData) {
    // Both empty — just point at remote
    console.log("  Both local and remote are empty. Configuring remote without data transfer.");
    strategy = "configure-only";
  } else if (!remoteHasData && localHasData) {
    // Local has data, remote is empty — initial migration
    console.log(`  Your local DB has ${localActiveCount} memories.`);
    console.log("  The remote is empty.");
    const migrate = await askConfirm(rl, "Copy your local memories to the remote now?", true);
    strategy = migrate ? "migrate" : "configure-only";
  } else if (remoteHasData && !localHasData) {
    // Remote has data, local empty — pull from remote (this is the "second machine" scenario)
    console.log(`  The remote has ${validation.checks.existingDb.memoryCount} memories.`);
    console.log("  Your local DB is empty.");
    const pull = await askConfirm(rl, "Pull all memories from remote to local now?", true);
    strategy = pull ? "pull" : "configure-only";
  } else {
    // BOTH have data — the tricky case
    // Reword to match deci-037: remote is the canonical source of truth,
    // local is an offline-resilience cache. The two counts shown here are
    // pre-merge snapshots, not "two co-equal copies".
    console.log(`  Remote DB (source of truth):   ${validation.checks.existingDb.memoryCount} memories`);
    console.log(`  Local cache (offline backup):  ${localActiveCount} memories`);
    console.log("");
    const choice = await askChoice(rl, "How do you want to combine them?", [
      { key: "1", label: "Merge — push local-only memories up, pull remote-only down, flag conflicts (recommended)" },
      { key: "2", label: "Replace remote with local (overwrites remote — destructive)" },
      { key: "3", label: "Replace local with remote (overwrites local cache)" },
      { key: "4", label: "Skip — configure remote without touching either DB" },
    ], "1");

    if (choice === "1") strategy = "merge";
    else if (choice === "2") strategy = "migrate"; // overwrites
    else if (choice === "3") strategy = "pull";
    else strategy = "configure-only"; // "Skip" is configure-only, not cancel

    if (strategy === "migrate" || strategy === "pull") {
      const confirm = await askConfirm(
        rl,
        `\nThis will overwrite the ${strategy === "migrate" ? "remote" : "local"} DB. Are you sure?`,
        false
      );
      if (!confirm) {
        console.log("Cancelled.");
        return false;
      }
    }
  }

  // Step 4: Save config and execute strategy. v5.9.3 Screen 6 wraps the
  // long-running sync calls in Spinners and prints a final Diff() block.
  const previousRemote = centralDb.getMeta(REMOTE_PATH_KEY) || null;
  centralDb.setMeta(REMOTE_PATH_KEY, remotePath);
  centralDb.setMeta(REMOTE_MODE_KEY, syncMode);

  const sync = new RemoteSync(centralDb, remotePath);
  try {
    if (strategy === "migrate") {
      const spin = Spinner(`doing first sync to ${remotePath}…`);
      const result = await sync.migrate();
      if (result.ok) {
        spin.ok("first sync complete", `${result.copied} memories pushed`);
      } else {
        spin.fail("migration had errors");
        for (const e of result.errors) printStatus("fail", e);
        return false;
      }
    } else if (strategy === "pull") {
      const spin = Spinner(`doing first sync from ${remotePath}…`);
      const result = await sync.pull({ strategy: "newer-wins" });
      spin.ok("first sync complete", `${result.pulled} memories pulled`);
      for (const e of result.errors) printStatus("fail", e);
    } else if (strategy === "merge") {
      const spin = Spinner(`merging local and remote at ${remotePath}…`);
      const result = await sync.sync();
      spin.ok(
        "merge complete",
        `pushed ${result.pushed} · pulled ${result.pulled} · conflicts ${result.conflicts.length}`,
      );
      if (result.conflicts.length > 0) {
        printStatus("warn", "conflicts need resolution");
        for (const c of result.conflicts) console.log(`     ${c.memoryId}: ${c.title}`);
        printStatus("progress", "resolve with", "gnosys remote resolve <memory-id> --keep <local|remote>");
      }
      for (const e of result.errors) printStatus("fail", e);
    }
  } finally {
    sync.closeRemote();
  }

  // Final Diff + save confirmation per the design.
  console.log("");
  console.log(renderRemoteDiff({ previousRemote, newRemote: remotePath, mode: syncMode }));
  printStatus("ok", "saved", "~/.gnosys/gnosys.json");
  console.log(Footer("run `gnosys remote status` anytime to check sync state"));
  return true;
}

// ─── Reconfigure helpers ────────────────────────────────────────────────

async function disconnectRemote(rl: Interface, centralDb: GnosysDB): Promise<boolean> {
  const confirm = await askConfirm(
    rl,
    "Disconnect the remote? Your local DB will remain. The remote DB itself is not deleted.",
    false
  );
  if (!confirm) {
    console.log("Cancelled.");
    return false;
  }
  centralDb.setMeta(REMOTE_PATH_KEY, "");
  console.log("✓ Remote disconnected. Gnosys is now local-only.");
  return true;
}

async function revalidateRemote(_rl: Interface, _centralDb: GnosysDB, currentRemote: string): Promise<boolean> {
  console.log("");
  const spin = Spinner(`checking ${currentRemote}…`);
  const validation = await validateLocation(currentRemote);
  if (validation.ok) {
    spin.ok("remote is healthy");
  } else {
    spin.fail("validation failed", "the remote may be unreachable or the path is wrong");
  }
  showValidationSummary(validation);
  return validation.ok;
}

// ─── Non-interactive mode ───────────────────────────────────────────────

export async function configureFromPath(
  centralDb: GnosysDB,
  remotePath: string,
  opts: { migrate?: boolean } = {}
): Promise<boolean> {
  console.log(`\nValidating ${remotePath}...`);
  const validation = await validateLocation(remotePath);
  showValidationSummary(validation);

  if (!validation.ok) {
    console.log("\nValidation failed. Remote not configured.");
    return false;
  }

  centralDb.setMeta(REMOTE_PATH_KEY, remotePath);
  console.log(`\n✓ Remote configured: ${remotePath}`);

  if (opts.migrate && !validation.checks.existingDb.found) {
    console.log("\nMigrating local DB to remote...");
    const sync = new RemoteSync(centralDb, remotePath);
    try {
      const result = await sync.migrate();
      if (result.ok) {
        console.log(`  ✓ Copied ${result.copied} memories to remote.`);
      } else {
        console.log(`  ✗ Migration had errors:`);
        for (const e of result.errors) console.log(`    ${e}`);
        return false;
      }
    } finally {
      sync.closeRemote();
    }
  } else if (validation.checks.existingDb.found) {
    console.log("\nExisting DB found at remote. Run 'gnosys remote sync' to merge.");
  }

  return true;
}
