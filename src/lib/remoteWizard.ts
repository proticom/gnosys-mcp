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

const REMOTE_PATH_KEY = "remote_path";

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
  return (await rl.question(prompt)).trim();
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
  console.log(`  Path exists:        ${validation.checks.pathExists ? "✓" : "✗"}`);
  console.log(`  Writable:           ${validation.checks.writable ? "✓" : "✗"}`);
  console.log(`  SQLite compatible:  ${validation.checks.sqliteCompatible ? "✓" : "✗"}`);
  if (validation.checks.latencyMs !== null) {
    console.log(`  Latency:            ${validation.checks.latencyMs}ms`);
  }
  if (validation.checks.existingDb.found) {
    const c = validation.checks.existingDb;
    const dateStr = c.lastModified ? c.lastModified.split("T")[0] : "unknown";
    console.log(`  Existing DB found:  ${c.memoryCount ?? "?"} memories (last modified ${dateStr})`);
  }
  for (const w of validation.warnings) console.log(`  ⚠ ${w}`);
  for (const e of validation.errors) console.log(`  ✗ ${e}`);
}

// ─── Main wizard ────────────────────────────────────────────────────────

export async function runConfigureWizard(centralDb: GnosysDB): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const localCount = centralDb.getMemoryCount();
    const currentRemote = centralDb.getMeta(REMOTE_PATH_KEY);

    console.log("");
    console.log("  Gnosys Remote Sync — Configuration Wizard");
    console.log("  ─────────────────────────────────────────");
    console.log("");
    console.log(`  Local DB:  ~/.gnosys/gnosys.db  (${localCount.active} active, ${localCount.archived} archived)`);
    console.log(`  Remote:    ${currentRemote || "not configured"}`);
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
    rl.close();
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
    console.log("Detected mounted volumes:");
    candidates.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
    console.log(`  ${candidates.length + 1}) Custom path`);
    console.log(`  ${candidates.length + 2}) Cancel`);

    const choices = [
      ...candidates.map((_, i) => ({ key: String(i + 1), label: candidates[i] })),
      { key: String(candidates.length + 1), label: "Custom path" },
      { key: String(candidates.length + 2), label: "Cancel" },
    ];
    const choice = await askChoice(rl, "Select a volume or enter a custom path:", choices);

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

  // Step 2: Validate
  console.log(`\nStep 2: Validating ${remotePath}...`);
  const validation = await validateLocation(remotePath);
  showValidationSummary(validation);

  if (!validation.ok) {
    console.log("\nValidation failed. Remote not configured.");
    return false;
  }

  if (validation.warnings.length > 0) {
    const proceed = await askConfirm(rl, "Continue despite warnings?", true);
    if (!proceed) return false;
  }

  // Step 3: Decide what to do based on existing DB state
  console.log("\nStep 3: Data strategy");
  console.log("");

  const remoteHasData = validation.checks.existingDb.found && (validation.checks.existingDb.memoryCount ?? 0) > 0;
  const localHasData = localActiveCount > 0;

  let strategy: "migrate" | "merge" | "pull" | "configure-only" | "cancel" = "configure-only";

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
    console.log(`  Local DB:   ${localActiveCount} memories`);
    console.log(`  Remote DB:  ${validation.checks.existingDb.memoryCount} memories`);
    console.log("");
    const choice = await askChoice(rl, "How do you want to combine them?", [
      { key: "1", label: "Merge — push local-only memories up, pull remote-only down, flag any conflicts (recommended)" },
      { key: "2", label: "Replace remote with my local (overwrites the remote — destructive)" },
      { key: "3", label: "Replace local with remote (your local memories will be lost — destructive)" },
      { key: "4", label: "Cancel" },
    ], "1");

    if (choice === "1") strategy = "merge";
    else if (choice === "2") strategy = "migrate"; // overwrites
    else if (choice === "3") strategy = "pull";
    else strategy = "cancel";

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

  if (strategy === "cancel") {
    console.log("Cancelled.");
    return false;
  }

  // Step 4: Save config and execute strategy
  centralDb.setMeta(REMOTE_PATH_KEY, remotePath);
  console.log(`\n✓ Remote configured: ${remotePath}`);

  const sync = new RemoteSync(centralDb, remotePath);
  try {
    if (strategy === "migrate") {
      console.log("\nCopying local memories to remote...");
      const result = await sync.migrate();
      if (result.ok) {
        console.log(`  ✓ Copied ${result.copied} memories.`);
      } else {
        console.log(`  ✗ Migration had errors:`);
        for (const e of result.errors) console.log(`    ${e}`);
        return false;
      }
    } else if (strategy === "pull") {
      console.log("\nPulling memories from remote...");
      const result = await sync.pull({ strategy: "newer-wins" });
      console.log(`  ✓ Pulled ${result.pulled} memories.`);
      if (result.errors.length > 0) {
        for (const e of result.errors) console.log(`  ✗ ${e}`);
      }
    } else if (strategy === "merge") {
      console.log("\nMerging local and remote...");
      const result = await sync.sync();
      console.log(`  Pushed: ${result.pushed} | Pulled: ${result.pulled} | Conflicts: ${result.conflicts.length}`);
      if (result.conflicts.length > 0) {
        console.log("\n  Conflicts need resolution:");
        for (const c of result.conflicts) {
          console.log(`    ${c.memoryId}: ${c.title}`);
        }
        console.log("\n  Resolve with: gnosys remote resolve <memory-id> --keep <local|remote>");
      }
      if (result.errors.length > 0) {
        for (const e of result.errors) console.log(`  ✗ ${e}`);
      }
    }
  } finally {
    sync.closeRemote();
  }

  console.log("\nDone! Run 'gnosys remote status' anytime to check sync state.");
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
  console.log(`\nValidating ${currentRemote}...`);
  const validation = await validateLocation(currentRemote);
  showValidationSummary(validation);
  if (validation.ok) {
    console.log("\n✓ Remote is healthy.");
    return true;
  } else {
    console.log("\n✗ Validation failed. The remote may be unreachable or the path is wrong.");
    return false;
  }
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
