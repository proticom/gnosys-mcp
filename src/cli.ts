#!/usr/bin/env node
/**
 * Gnosys CLI — Thin wrapper around the core modules.
 * Uses the resolver for layered multi-store support.
 */

import { Command } from "commander";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { readFileSync, existsSync, copyFileSync } from "fs";
// v5.8.0 (#4): only the lightweight modules are imported at top-level.
// Anything that pulls @huggingface/transformers, mammoth/pdf-parse/turndown,
// large file-walking machinery, or otherwise costs >100ms to load gets
// `await import(...)` inside its own action handler. This keeps
// `gnosys --help` and other lightweight commands fast.
import { GnosysResolver } from "./lib/resolver.js";
import { getGnosysHome } from "./lib/paths.js";
import { GnosysTagRegistry } from "./lib/tags.js";
import { computeStats, type TimePeriod } from "./lib/timeline.js";
import { loadConfig, generateConfigTemplate, type GnosysConfig, DEFAULT_CONFIG, writeConfig, updateConfig, resolveTaskModel, ALL_PROVIDERS, type LLMProviderName, getProviderModel } from "./lib/config.js";
import { getLLMProvider, isProviderAvailable, type LLMProvider } from "./lib/llm.js";
import { GnosysDB } from "./lib/db.js";
import { logError } from "./lib/log.js";
import { getSecureStorageSetupHint } from "./lib/platform.js";
import { createProjectIdentity, readProjectIdentity, findProjectIdentity, migrateProject } from "./lib/projectIdentity.js";
import { setPreference, getPreference, getAllPreferences, deletePreference, KNOWN_PREFERENCE_KEYS, suggestPreferenceKey } from "./lib/preferences.js";
import { syncRules, syncToTarget } from "./lib/rulesGen.js";
// Lazy-loaded inside action handlers (each ~200ms-2.5s on cold cache):
//   - ./lib/embeddings.js       (@huggingface/transformers — 80MB)
//   - ./lib/hybridSearch.js     (depends on embeddings)
//   - ./lib/ask.js              (depends on hybridSearch)
//   - ./lib/import.js           (mammoth, pdf-parse, turndown)
//   - ./lib/bootstrap.js        (file walking — 2.5s)
//   - ./lib/ingest.js           (LLM machinery)
//   - ./lib/migrate.js          (only migrate-db needs it)

// Load API keys from ~/.config/gnosys/.env (same as MCP server)
// IMPORTANT: We use dotenv.parse() instead of dotenv.config() because
// dotenv v17+ writes injection notices to stdout, which corrupts
// --json output and piped usage. parse() is a pure function with no side effects.
const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
try {
  const envFile = readFileSync(path.join(home, ".config", "gnosys", ".env"), "utf8");
  const parsed = dotenv.parse(envFile);
  for (const [key, val] of Object.entries(parsed)) {
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env file not found — that's fine, env vars may be set elsewhere
}
// Also try .env from current directory as fallback
try {
  const localEnv = readFileSync(".env", "utf8");
  const localParsed = dotenv.parse(localEnv);
  for (const [key, val] of Object.entries(localParsed)) {
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // No local .env — fine
}

// Read version from package.json at build time
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));

const program = new Command();

/**
 * Phase F: True if the CLI process is running inside a test harness.
 * Any code path that would otherwise OPEN the central DB (which
 * implicitly creates ~/.gnosys/gnosys.db) MUST short-circuit on this.
 */
function isTestEnv(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.CI === "true"
  );
}

// v5.9.3 Phase H: `maybePrintUpgradeNudge` (cli.ts:92-118 in v5.9.2) was
// the second of two upgrade-nag mechanisms — both fired on every CLI
// invocation and both opened the central DB. It is now deleted; the
// post-install block at the BOTTOM of this file is the single source of
// truth, runs on stderr only, and is downgrade-aware (`reverted`/
// `upgraded`).

/**
 * v5.6.0 back-compat shim: rewrite `gnosys export --to <dir>` →
 * `gnosys export vault --to <dir>` before commander parses argv. The v5.6.0
 * restructure made `export` a parent command with `vault` and `project`
 * subcommands; without this shim, the bare `--to` form prints usage instead
 * of running the vault export.
 *
 * Pattern: argv[2]==="export" AND argv[3] is not a known subcommand AND any
 * of the v5.5.x flags appear (`--to`, `--all`, `--overwrite`, etc.).
 */
function rewriteLegacyExport(): void {
  if (process.argv[2] !== "export") return;
  const next = process.argv[3];
  if (next === "vault" || next === "project" || next === "--help" || next === "-h") return;
  // Any v5.5.x-style flag → assume legacy vault invocation
  const looksLegacy = process.argv.slice(3).some((a) =>
    a === "--to" || a.startsWith("--to=") ||
    a === "--all" || a === "--overwrite" ||
    a === "--no-summaries" || a === "--no-reviews" || a === "--no-graph" ||
    a === "--json"
  );
  if (looksLegacy) {
    process.argv.splice(3, 0, "vault");
  }
}

rewriteLegacyExport();

async function getResolver(): Promise<GnosysResolver> {
  const resolver = new GnosysResolver();
  await resolver.resolve();
  return resolver;
}

/**
 * v3.0: Resolve projectId from nearest .gnosys/gnosys.json.
 * Used by CLI write commands to tag memories with the correct project.
 */
async function resolveProjectId(dir?: string): Promise<string | null> {
  const result = await findProjectIdentity(dir || process.cwd());
  return result?.identity.projectId || null;
}

/**
 * Output helper: if --json flag is set, output JSON; otherwise call the
 * human-readable formatter function.
 */
function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

program
  .name("gnosys")
  .description("Gnosys — Persistent memory for AI agents. Sandbox-first runtime, central SQLite brain, federated search, reflection API, process tracing, preferences, Dream Mode, Obsidian export. Also runs as a full MCP server.")
  .version(pkg.version)
  .addHelpText("after", `
Commands by group (alphabetical within group):
  Setup & status:    setup · status · doctor · check · upgrade
  Memory ops:        add · add-structured · update · read · reinforce · ingest
                     bootstrap · import · export
  Search:            discover · search · hybrid-search · semantic-search · ask · recall
                     fsearch · briefing · lens
  Project mgmt:      init · projects · list · stats · timeline · graph · tags · tags-add
                     stale · history · rollback · audit · links
  Chat (TUI):        chat
  Maintenance:       maintain · reindex · reindex-graph · dearchive · dream · backup · restore · prune
  Multi-machine:     setup remote (configure | status | push | pull | sync | resolve)
  Agent runtime:     serve · sandbox · helper · pref · sync · update-status · working-set
  Legacy / advanced: dashboard · migrate · migrate-db · stores · config

Run 'gnosys <command> --help' for command-specific help.
`)
  .hook("preAction", async () => {
    // v5.8.5: warn only when the DB stamp is NEWER than the running binary
    // (i.e. another machine on the shared brain already upgraded). The old
    // check fired whenever the versions differed — including the common
    // "you just installed a newer gnosys but haven't run sync-projects yet"
    // case, which produced a misleading "Run: npm install -g gnosys"
    // banner on every command.
    //
    // v5.9.3 (Phase F): skip in tests so we don't auto-create the central DB.
    if (isTestEnv()) return;
    try {
      const centralDb = GnosysDB.openCentral();
      if (centralDb.isAvailable()) {
        const dbVersion = centralDb.getMeta("app_version");
        if (dbVersion && compareSemver(dbVersion, pkg.version) > 0) {
          const upgradedBy = centralDb.getMeta("upgraded_by") || "another machine";
          console.error(
            `\n⚠ Gnosys DB was upgraded to v${dbVersion} by ${upgradedBy}.` +
            `\n  You are running v${pkg.version}. Run: npm install -g gnosys && gnosys upgrade\n`
          );
        }
        centralDb.close();
      }
    } catch {
      // non-critical — don't block the command
    }
  });

/**
 * Compare two semver-like strings. Returns -1, 0, 1. Tolerant of suffixes —
 * compares the dotted-numeric prefix only.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(/[-+]/)[0].split(".").map((p) => parseInt(p, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const ap = av[i] ?? 0;
    const bp = bv[i] ?? 0;
    if (ap !== bp) return ap > bp ? 1 : -1;
  }
  return 0;
}

// ─── gnosys read <path> ──────────────────────────────────────────────────
program
  .command("read <memoryPath>")
  .description(
    "Read a specific memory. Supports layer prefix (e.g., project:decisions/auth.md)"
  )
  .option("--json", "Output as JSON")
  .action(async (memoryPath: string, opts: { json?: boolean }) => {
    const { runReadCommand } = await import("./lib/readCommand.js");
    await runReadCommand(getResolver, memoryPath, opts);
  });

// ─── gnosys discover <query> ─────────────────────────────────────────────
program
  .command("discover <query>")
  .description("Discover relevant memories by keyword. Use --federated for tier-boosted cross-scope discovery.")
  .option("-n, --limit <number>", "Max results", "20")
  .option("--json", "Output as JSON")
  .option("--federated", "Use federated discovery with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated for multiple)")
  .option("-d, --directory <dir>", "Project directory for context")
  .option("--id-format <format>", "ID display format: short | long | raw (default: short)", "short")
  .action(async (query: string, opts: { limit: string; json?: boolean; federated?: boolean; scope?: string; directory?: string; idFormat?: string }) => {
    const { runDiscoverCommand } = await import("./lib/discoverCommand.js");
    await runDiscoverCommand(query, opts);
  });

// ─── gnosys search <query> ───────────────────────────────────────────────
program
  .command("search <query>")
  .description("Search memories by keyword. Use --federated for tier-boosted cross-scope search.")
  .option("-n, --limit <number>", "Max results", "20")
  .option("--json", "Output as JSON")
  .option("--federated", "Use federated search with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated for multiple)")
  .option("-d, --directory <dir>", "Project directory for context")
  .option("--id-format <format>", "ID display format: short | long | raw (default: short)", "short")
  .action(async (query: string, opts: { limit: string; json?: boolean; federated?: boolean; scope?: string; directory?: string; idFormat?: string }) => {
    const { runSearchCommand } = await import("./lib/searchCommand.js");
    await runSearchCommand(query, opts);
  });

// ─── gnosys list ─────────────────────────────────────────────────────────
program
  .command("list")
  .description("List all memories across all stores")
  .option("-c, --category <category>", "Filter by category")
  .option("-t, --tag <tag>", "Filter by tag")
  .option("-s, --store <store>", "Filter by store layer (project|user|global)")
  .option("--json", "Output as JSON")
  .option("--id-format <format>", "ID display format: short | long | raw (default: short)", "short")
  .action(async (opts: { category?: string; tag?: string; store?: string; json?: boolean; idFormat?: string }) => {
    const { runListCommand } = await import("./lib/listCommand.js");
    await runListCommand(opts);
  });

// ─── gnosys add <input> ──────────────────────────────────────────────────
program
  .command("add <input>")
  .description("Add a new memory (uses LLM to structure raw input)")
  .option(
    "-a, --author <author>",
    "Author (human|ai|human+ai)",
    "human"
  )
  .option(
    "--authority <authority>",
    "Authority level (declared|observed|imported|inferred)",
    "declared"
  )
  .option(
    "-s, --store <store>",
    "Target store (project|personal|global)",
    undefined
  )
  .action(
    async (
      input: string,
      opts: { author: string; authority: string; store?: string }
    ) => {
      const { runAddCommand } = await import("./lib/addCommand.js");
      await runAddCommand(getResolver, input, opts, resolveProjectId);
    }
  );

// ─── gnosys setup (parent command) ──────────────────────────────────────
const setupCmd = program
  .command("setup")
  .description("Configure Gnosys — LLM provider, models, remote sync, and IDE integration");

// Bare `gnosys setup` — when config exists, opens the summary-first menu
// so the user can edit one section without re-running the whole wizard.
// First-time setup or `--full` runs the linear 5-step flow.
setupCmd
  .option("--non-interactive", "Skip prompts, use defaults (for CI/scripting)")
  .option("--full", "Run the linear 5-step wizard even when a config exists")
  .action(async (opts: { nonInteractive?: boolean; full?: boolean }) => {
    const { runSetup } = await import("./lib/setup.js");
    const projectDir = process.cwd();

    // Detect existing config — if present and the user didn't pass --full,
    // route to the summary-first menu.
    const configPath = path.join(os.homedir(), ".gnosys", "gnosys.json");
    const hasConfig = existsSync(configPath);

    if (hasConfig && !opts.full && !opts.nonInteractive) {
      const { runSummaryWizard } = await import("./lib/setup/summary.js");
      await runSummaryWizard({ directory: projectDir });
      return;
    }

    await runSetup({
      directory: projectDir,
      nonInteractive: opts.nonInteractive,
    });
  });

// `gnosys setup models` — just configure LLM provider/model/key
setupCmd
  .command("models")
  .description("Update LLM provider and model configuration")
  .option("-p, --provider <name>", "Set provider directly (anthropic, openai, xai, groq, mistral, ollama, lmstudio, custom)")
  .option("-m, --model <name>", "Set model name directly")
  .option("--no-validate", "Skip the test API call")
  .action(async (opts: { provider?: string; model?: string; validate?: boolean }) => {
    const { runModelsSetup } = await import("./lib/setup.js");
    await runModelsSetup({
      directory: process.cwd(),
      provider: opts.provider,
      model: opts.model,
      validate: opts.validate,
    });
  });

// ─── gnosys setup remote (parent + subcommands) ────────────────────────
// v5.7.0: the standalone `gnosys remote` parent was dropped; everything
// (configure, status, push, pull, sync, resolve) lives here now.
const setupRemoteCmd = setupCmd
  .command("remote")
  .description("Multi-machine sync — configure, sync, and resolve conflicts");

// Bare `gnosys setup remote` — configure wizard (back-compat with v5.6.x)
setupRemoteCmd
  .option("--path <path>", "Set remote path directly (non-interactive)")
  .action(async (opts: { path?: string }) => {
    const { GnosysDB } = await import("./lib/db.js");
    const db = GnosysDB.openLocal();
    if (!db.isAvailable()) {
      console.error("Central DB not available.");
      db.close();
      process.exit(1);
    }
    try {
      if (opts.path) {
        const { configureFromPath } = await import("./lib/remoteWizard.js");
        await configureFromPath(db, opts.path);
      } else {
        const { runConfigureWizard } = await import("./lib/remoteWizard.js");
        await runConfigureWizard(db);
      }
    } finally {
      db.close();
    }
  });

setupRemoteCmd
  .command("status")
  .description("Show remote sync status: pending changes, conflicts, last sync")
  .option("--json", "Output as JSON")
  .action(async (opts: { json: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openLocal();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const remotePath = centralDb.getMeta("remote_path");
      if (!remotePath) {
        if (opts.json) {
          console.log(JSON.stringify({ configured: false, message: "Remote not configured. Run 'gnosys setup remote'." }, null, 2));
        } else {
          console.log("Remote sync: not configured.");
          console.log("Run 'gnosys setup remote' to set up multi-machine sync.");
        }
        return;
      }

      const { RemoteSync, formatStatus } = await import("./lib/remote.js");
      const { withHeartbeat } = await import("./lib/heartbeat.js");
      const sync = new RemoteSync(centralDb, remotePath);
      const status = await withHeartbeat(
        "Checking remote sync status",
        () => sync.getStatus(),
      );
      sync.closeRemote();

      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(formatStatus(status));
        if (status.conflicts.length > 0) {
          console.log("\nConflicts:");
          for (const c of status.conflicts) {
            console.log(`  ${c.memoryId}: ${c.title}`);
            console.log(`    local:  ${c.localModified}`);
            console.log(`    remote: ${c.remoteModified}`);
          }
          console.log("\nResolve with: gnosys setup remote resolve <memory-id> --keep <local|remote>");
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

setupRemoteCmd
  .command("push")
  .description("Push local changes to remote")
  .option("--newer-wins", "Auto-resolve conflicts by taking the newer version")
  .option("--verbose", "Stream per-memory progress to stderr")
  .action(async (opts: { newerWins?: boolean; verbose?: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openLocal();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const remotePath = centralDb.getMeta("remote_path");
      if (!remotePath) { console.error("Remote not configured."); process.exit(1); }

      const { RemoteSync } = await import("./lib/remote.js");
      const { withHeartbeat } = await import("./lib/heartbeat.js");
      const { createProgress } = await import("./lib/progress.js");
      const progress = createProgress(!!opts.verbose);
      const sync = new RemoteSync(centralDb, remotePath);
      // Suppress heartbeat when verbose is on (progress already streams).
      const runPush = () =>
        sync.push({
          strategy: opts.newerWins ? "newer-wins" : "skip-and-flag",
          onProgress: progress.noop ? undefined : progress.emit.bind(progress),
        });
      const result = opts.verbose
        ? await runPush()
        : await withHeartbeat("Pushing to remote", runPush);
      sync.closeRemote();

      const projParts = (result.projectsPushed || 0) > 0 ? ` | Projects pushed: ${result.projectsPushed}` : "";
      const auditParts = (result.auditPushed || 0) > 0 ? ` | Audit pushed: ${result.auditPushed}` : "";
      console.log(`Pushed: ${result.pushed} | Skipped: ${result.skipped} | Conflicts: ${result.conflicts.length}${projParts}${auditParts}`);
      if (result.errors.length > 0) {
        console.log("\nErrors:");
        for (const e of result.errors) console.log(`  ${e}`);
      }
      if (result.conflicts.length > 0) {
        console.log("\nConflicts flagged (run 'gnosys setup remote status' for details):");
        for (const c of result.conflicts) console.log(`  ${c.memoryId} — ${c.title}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

setupRemoteCmd
  .command("pull")
  .description("Pull remote changes to local")
  .option("--newer-wins", "Auto-resolve conflicts by taking the newer version")
  .option("--verbose", "Stream per-memory progress to stderr")
  .action(async (opts: { newerWins?: boolean; verbose?: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openLocal();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const remotePath = centralDb.getMeta("remote_path");
      if (!remotePath) { console.error("Remote not configured."); process.exit(1); }

      const { RemoteSync } = await import("./lib/remote.js");
      const { withHeartbeat } = await import("./lib/heartbeat.js");
      const { createProgress } = await import("./lib/progress.js");
      const progress = createProgress(!!opts.verbose);
      const sync = new RemoteSync(centralDb, remotePath);
      const runPull = () =>
        sync.pull({
          strategy: opts.newerWins ? "newer-wins" : "skip-and-flag",
          onProgress: progress.noop ? undefined : progress.emit.bind(progress),
        });
      const result = opts.verbose
        ? await runPull()
        : await withHeartbeat("Pulling from remote", runPull);
      sync.closeRemote();

      const projParts = (result.projectsPulled || 0) > 0 ? ` | Projects pulled: ${result.projectsPulled}` : "";
      const auditParts = (result.auditPulled || 0) > 0 ? ` | Audit pulled: ${result.auditPulled}` : "";
      console.log(`Pulled: ${result.pulled} | Skipped: ${result.skipped} | Conflicts: ${result.conflicts.length}${projParts}${auditParts}`);
      if (result.errors.length > 0) {
        console.log("\nErrors:");
        for (const e of result.errors) console.log(`  ${e}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

setupRemoteCmd
  .command("sync")
  .description("Two-way sync: push local changes then pull remote changes")
  .option("--auto", "Run silently for cron/LaunchAgent (skip-and-flag for conflicts)")
  .option("--newer-wins", "Auto-resolve conflicts by taking the newer version")
  .option("--verbose", "Stream per-memory progress to stderr")
  .action(async (opts: { auto?: boolean; newerWins?: boolean; verbose?: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openLocal();
      if (!centralDb.isAvailable()) {
        if (!opts.auto) console.error("Central DB not available.");
        process.exit(1);
      }

      const remotePath = centralDb.getMeta("remote_path");
      if (!remotePath) {
        if (!opts.auto) console.error("Remote not configured.");
        process.exit(opts.auto ? 0 : 1);
      }

      const { RemoteSync } = await import("./lib/remote.js");
      const { withHeartbeat } = await import("./lib/heartbeat.js");
      const { createProgress } = await import("./lib/progress.js");
      const progress = createProgress(!!opts.verbose);
      const sync = new RemoteSync(centralDb, remotePath);
      const runSync = () =>
        sync.sync({
          auto: opts.auto,
          strategy: opts.newerWins ? "newer-wins" : "skip-and-flag",
          onProgress: progress.noop ? undefined : progress.emit.bind(progress),
        });
      // Auto mode + verbose mode both bypass the heartbeat. Auto mode is
      // for non-interactive runs (no spinner). Verbose streams its own output.
      const result =
        opts.auto || opts.verbose
          ? await runSync()
          : await withHeartbeat("Syncing with remote", runSync);
      sync.closeRemote();

      if (!opts.auto || result.conflicts.length > 0 || result.errors.length > 0) {
        const pp = result.projectsPushed || 0;
        const pl = result.projectsPulled || 0;
        const ap = result.auditPushed || 0;
        const al = result.auditPulled || 0;
        const projParts = (pp + pl) > 0 ? ` | Projects: ↑${pp}/↓${pl}` : "";
        const auditParts = (ap + al) > 0 ? ` | Audit: ↑${ap}/↓${al}` : "";
        console.log(`Pushed: ${result.pushed} | Pulled: ${result.pulled} | Conflicts: ${result.conflicts.length}${projParts}${auditParts}`);
        if (result.errors.length > 0) {
          console.log("\nErrors:");
          for (const e of result.errors) console.log(`  ${e}`);
        }
        if (result.conflicts.length > 0) {
          console.log("\nConflicts need resolution (run 'gnosys setup remote status' for details).");
        }
      }
    } catch (err) {
      if (!opts.auto) console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

setupRemoteCmd
  .command("resolve <memoryId>")
  .description("Resolve a sync conflict by choosing local, remote, or merged content")
  .option("--keep <choice>", "Choice: local | remote", "local")
  .action(async (memoryId: string, opts: { keep: string }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openLocal();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const remotePath = centralDb.getMeta("remote_path");
      if (!remotePath) { console.error("Remote not configured."); process.exit(1); }

      if (opts.keep !== "local" && opts.keep !== "remote") {
        console.error(`--keep must be 'local' or 'remote' (got: ${opts.keep})`);
        process.exit(1);
      }

      const { RemoteSync } = await import("./lib/remote.js");
      const sync = new RemoteSync(centralDb, remotePath);
      const result = await sync.resolve(memoryId, opts.keep as "local" | "remote");
      sync.closeRemote();

      if (result.ok) {
        console.log(`Resolved ${memoryId}: kept ${opts.keep} version.`);
      } else {
        console.error(`Failed to resolve: ${result.error}`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// `gnosys setup dream` — configure dream mode (designation, provider, schedule)
setupCmd
  .command("dream")
  .description("Configure Dream Mode — designate this machine, pick provider/model, set schedule")
  .action(async () => {
    const { runDreamSetup } = await import("./lib/setup.js");
    await runDreamSetup({ directory: process.cwd() });
  });

// `gnosys setup chat` — configure chat TUI (provider, recall, tools, prefix)
setupCmd
  .command("chat")
  .description("Configure the chat TUI — provider/model, recall behavior, tools, system-prompt prefix")
  .action(async () => {
    const { runChatSetup } = await import("./lib/setup.js");
    await runChatSetup({ directory: process.cwd() });
  });

// `gnosys setup ides` — configure IDE / MCP integrations standalone
setupCmd
  .command("ides")
  .description("Configure IDE MCP integrations (Claude Code/Desktop, Cursor, Codex, Grok Build, Gemini CLI, Antigravity)")
  .option("--all", "Configure MCP for all supported IDEs (non-interactive)")
  .action(async (opts: { all?: boolean }) => {
    if (opts.all) {
      const { runIdesSetupAll } = await import("./lib/setup/sections/ides.js");
      const { configured, errors } = await runIdesSetupAll(process.cwd());
      console.log(`\n${configured} ides configured · ${errors} errors`);
      return;
    }
    const readline = await import("readline/promises");
    const { runIdesSetup } = await import("./lib/setup/sections/ides.js");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await runIdesSetup({ rl, directory: process.cwd() });
    } finally {
      rl.close();
    }
  });

// `gnosys setup routing` — task-routing wizard standalone
setupCmd
  .command("routing")
  .description("Configure per-task LLM routing (structuring, synthesis, vision, transcription, dream)")
  .action(async () => {
    const readline = await import("readline/promises");
    const { runRoutingSetup } = await import("./lib/setup/sections/routing.js");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await runRoutingSetup({ rl, directory: process.cwd() });
    } finally {
      rl.close();
    }
  });

// `gnosys setup preferences` — review user-scope preferences
setupCmd
  .command("preferences")
  .description("Review and clean up user-scope preferences (incl. legacy imports)")
  .action(async () => {
    const readline = await import("readline/promises");
    const { runPreferencesReview } = await import("./lib/setup/sections/preferences.js");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await runPreferencesReview(rl);
    } finally {
      rl.close();
    }
  });

// v5.4.2 removal: `gnosys models` (top-level shortcut) was removed in favor
// of the canonical `gnosys setup models` form. The implementation function
// runModelsCommand() in setup.ts is no longer wired but kept for now in case
// we need to revive a top-level shortcut later.

// ─── gnosys init ─────────────────────────────────────────────────────────
program
  .command("init")
  .description("Initialize Gnosys in the current directory (project store, identity, central DB). Wire IDE MCP servers with: gnosys setup ides")
  .option("-d, --directory <dir>", "Target directory (default: cwd)")
  .option("-n, --name <name>", "Project name (default: directory basename)")
  .action(async (opts: { directory?: string; name?: string }) => {
    const targetDir = opts.directory
      ? path.resolve(opts.directory)
      : process.cwd();
    const storePath = path.join(targetDir, ".gnosys");

    // Check if already exists — re-sync identity instead of failing
    let isResync = false;
    try {
      await fs.stat(storePath);
      isResync = true;
    } catch {
      // Good — fresh init
    }

    if (!isResync) {
      // Create directory structure (DB is sole source of truth — no category folders or changelog)
      await fs.mkdir(storePath, { recursive: true });
      await fs.mkdir(path.join(storePath, ".config"), { recursive: true });

      const defaultRegistry = {
        domain: [
          "architecture", "api", "auth", "database", "devops",
          "frontend", "backend", "testing", "security", "performance",
        ],
        type: [
          "decision", "concept", "convention", "requirement",
          "observation", "fact", "question",
        ],
        concern: ["dx", "scalability", "maintainability", "reliability"],
        status_tag: ["draft", "stable", "deprecated", "experimental"],
      };
      await fs.writeFile(
        path.join(storePath, ".config", "tags.json"),
        JSON.stringify(defaultRegistry, null, 2),
        "utf-8"
      );

      // Write default gnosys.json config (LLM settings)
      await fs.writeFile(
        path.join(storePath, ".config", "gnosys-config.json"),
        generateConfigTemplate() + "\n",
        "utf-8"
      );

      // v5.0: Create attachments directory and empty manifest
      await fs.mkdir(path.join(storePath, "attachments"), { recursive: true });
      await fs.writeFile(
        path.join(storePath, "attachments", "attachments.json"),
        JSON.stringify({ attachments: [] }, null, 2) + "\n",
        "utf-8"
      );

      // Create .gitignore inside .gnosys to exclude large binary attachments
      const storeGitignore = "# Large binary attachments (tracked via manifest, not git)\nattachments/\n";
      await fs.writeFile(
        path.join(storePath, ".gitignore"),
        storeGitignore,
        "utf-8"
      );
    }

    // v3.0: Create/update project identity and register in central DB
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) centralDb = null;
    } catch {
      centralDb = null;
    }

    const identity = await createProjectIdentity(targetDir, {
      projectName: opts.name,
      centralDb: centralDb || undefined,
    });

    // Register in file-based project registry so resolver can find it
    const tempResolver = new GnosysResolver();
    await tempResolver.registerProject(targetDir);

    // Add .gnosys/ to project's .gitignore (runs on both init and re-sync)
    try {
      const projectGitignore = path.join(targetDir, ".gitignore");
      let gitignoreContent = "";
      try {
        gitignoreContent = await fs.readFile(projectGitignore, "utf-8");
      } catch {
        // No .gitignore yet
      }
      if (!gitignoreContent.includes(".gnosys")) {
        const entry = "\n# Gnosys memory store\n.gnosys/\n";
        await fs.writeFile(projectGitignore, gitignoreContent + entry, "utf-8");
      }
    } catch {
      // Non-critical
    }

    if (centralDb) centralDb.close();

    const action = isResync ? "re-synced" : "initialized";
    console.log(`Gnosys store ${action} at ${storePath}`);
    console.log(`\nProject Identity:`);
    console.log(`  ID:        ${identity.projectId}`);
    console.log(`  Name:      ${identity.projectName}`);
    console.log(`  Directory: ${identity.workingDirectory}`);
    console.log(`  Agent:     ${identity.agentRulesTarget || "none detected"}`);
    console.log(`  Central DB: ${centralDb ? "registered ✓" : "not available"}`);

    if (!isResync) {
      console.log(`\nCreated:`);
      console.log(`  gnosys.json   (project identity)`);
      console.log(`  .config/      (internal config)`);
      console.log(`  tags.json     (tag registry)`);
    }

    // Configure IDE hooks for automatic memory recall
    const { configureIdeHooks } = await import("./lib/projectIdentity.js");
    const hookResult = await configureIdeHooks(targetDir);
    if (hookResult.configured) {
      console.log(`\nIDE hooks (${hookResult.ide}):`);
      console.log(`  ${hookResult.details}`);
      console.log(`  File: ${hookResult.filePath}`);
    } else {
      console.log(`\nIDE hooks: ${hookResult.details}`);
    }

    console.log(`\nWire IDE MCP servers: gnosys setup ides`);
    console.log(`Start adding memories with: gnosys add "your knowledge here"`);
  });

// ─── gnosys migrate ─────────────────────────────────────────────────────
program
  .command("migrate")
  .description("Interactively migrate a .gnosys/ store to a new directory. Moves files, updates project name/paths, syncs to central DB, and cleans up.")
  .option("--from <dir>", "Source directory containing .gnosys/ (skips prompt)")
  .option("--to <dir>", "Target directory to move .gnosys/ into (skips prompt)")
  .option("--name <name>", "New project name (skips prompt, default: basename of target)")
  .option("--yes", "Skip all confirmation prompts (non-interactive mode)")
  .action(async (opts: { from?: string; to?: string; name?: string; yes?: boolean }) => {
    const { runMigrateCommand } = await import("./lib/migrateCommand.js");
    await runMigrateCommand(opts);
  });

// ─── gnosys stale ───────────────────────────────────────────────────────
program
  .command("stale")
  .description("Find memories not modified within a given number of days")
  .option("-d, --days <number>", "Days threshold", "90")
  .option("-n, --limit <number>", "Max results", "20")
  .action(async (opts: { days: string; limit: string }) => {
    const { runStaleCommand } = await import("./lib/staleCommand.js");
    await runStaleCommand(getResolver, opts);
  });

// ─── gnosys tags ─────────────────────────────────────────────────────────
program
  .command("tags")
  .description("List all tags in the registry")
  .action(async () => {
    const { runTagsCommand } = await import("./lib/tagsCommand.js");
    await runTagsCommand(getResolver);
  });

// ─── gnosys update <path> ────────────────────────────────────────────────
program
  .command("update <memoryPath>")
  .description("Update an existing memory's frontmatter and/or content")
  .option("--title <title>", "New title")
  .option("--status <status>", "New status (active|archived|superseded)")
  .option("--confidence <n>", "New confidence (0-1)")
  .option("--relevance <keywords>", "Updated relevance keyword cloud")
  .option("--supersedes <id>", "ID of memory this supersedes")
  .option("--superseded-by <id>", "ID of memory that supersedes this one")
  .option("--content <content>", "New markdown content (replaces body)")
  .action(
    async (
      memoryPath: string,
      opts: {
        title?: string;
        status?: string;
        confidence?: string;
        relevance?: string;
        supersedes?: string;
        supersededBy?: string;
        content?: string;
      },
    ) => {
      const { runUpdateCommand } = await import("./lib/updateCommand.js");
      await runUpdateCommand(getResolver, memoryPath, opts);
    },
  );

// ─── gnosys reinforce <memoryId> ────────────────────────────────────────
program
  .command("reinforce <memoryId>")
  .description("Signal whether a memory was useful, not relevant, or outdated")
  .requiredOption(
    "--signal <signal>",
    "Reinforcement signal (useful|not_relevant|outdated)"
  )
  .option("--context <context>", "Why this signal was given")
  .action(async (memoryId: string, opts: { signal: string; context?: string }) => {
    const { runReinforceCommand } = await import("./lib/reinforceCommand.js");
    await runReinforceCommand(getResolver, memoryId, opts);
  });

// ─── gnosys add-structured ──────────────────────────────────────────────
program
  .command("add-structured")
  .description("Add a memory with structured input (no LLM needed)")
  .requiredOption("--title <title>", "Memory title")
  .requiredOption("--category <category>", "Category directory name")
  .requiredOption("--content <content>", "Memory content as markdown")
  .option("--tags <json>", "Tags as JSON object", "{}")
  .option("--relevance <keywords>", "Keyword cloud for discovery search", "")
  .option("-a, --author <author>", "Author", "human")
  .option("--authority <authority>", "Authority level", "declared")
  .option("--confidence <n>", "Confidence 0-1", "0.8")
  .option("-s, --store <store>", "Target store", undefined)
  .option("--user", "Store as user-scoped memory (scope: user)")
  .option("--global", "Store as global-scoped memory (scope: global)")
  .action(
    async (opts: {
      title: string;
      category: string;
      content: string;
      tags: string;
      relevance: string;
      author: string;
      authority: string;
      confidence: string;
      store?: string;
      user?: boolean;
      global?: boolean;
    }) => {
      const { runAddStructuredCommand } = await import("./lib/addStructuredCommand.js");
      await runAddStructuredCommand(opts, resolveProjectId);
    }
  );

// ─── gnosys chat (TUI) ───────────────────────────────────────────────────
program
  .command("chat")
  .description("Interactive memory-aware terminal chat (TUI)")
  .option("--resume <sessionId>", "Resume an existing chat session")
  .option("--list", "List recent chat sessions and exit")
  .option("--search <query>", "Full-text search across session logs")
  .option("--provider <name>", "Override LLM provider (anthropic, openai, groq, ollama, …)")
  .option("--model <name>", "Override LLM model name")
  .option("--limit <n>", "Limit for --list / --search (default 20)", "20")
  .action(async (opts: { resume?: string; list?: boolean; search?: string; provider?: string; model?: string; limit: string }) => {
    const { runChatCommand } = await import("./lib/chatCommand.js");
    await runChatCommand(getResolver, opts);
  });

// ─── gnosys ingest <file> ─────────────────────────────────────────────────
program
  .command("ingest <fileOrGlob>")
  .description("Ingest a file (PDF, DOCX, TXT, MD) into Gnosys memory. Extracts text, splits into chunks, and creates atomic memories.")
  .option("--mode <mode>", "Ingestion mode: llm or structured", "llm")
  .option("-s, --store <store>", "Target store: project, personal, global")
  .option("-a, --author <author>", "Author", "human")
  .option("--authority <authority>", "Authority level", "imported")
  .option("--dry-run", "Preview what would be created without writing")
  .option("--list-attachments", "List all stored attachments")
  .option("-d, --directory <dir>", "Project directory")
  .action(async (fileOrGlob: string, opts: {
    mode: string;
    store?: string;
    author: string;
    authority: string;
    dryRun?: boolean;
    listAttachments?: boolean;
    directory?: string;
  }) => {
    const { runIngestCommand } = await import("./lib/ingestCommand.js");
    await runIngestCommand(getResolver, fileOrGlob, opts);
  });

// ─── gnosys tags-add ────────────────────────────────────────────────────
program
  .command("tags-add")
  .description("Add a new tag to the registry")
  .requiredOption("--category <category>", "Tag category (domain, type, concern, status_tag)")
  .requiredOption("--tag <tag>", "The new tag to add")
  .action(async (opts: { category: string; tag: string }) => {
    const { runTagsAddCommand } = await import("./lib/tagsAddCommand.js");
    await runTagsAddCommand(getResolver, opts);
  });

// ─── gnosys commit-context <context> ─────────────────────────────────────
program
  .command("commit-context <context>")
  .description("Pre-compaction sweep: extract atomic memories from a context string, check novelty, commit novel ones")
  .option("--dry-run", "Show what would be committed without writing")
  .option("-s, --store <store>", "Target store (project|personal|global)", undefined)
  .action(async (context: string, opts: { dryRun?: boolean; store?: string }) => {
    const { runCommitContextCommand } = await import("./lib/commitContextCommand.js");
    await runCommitContextCommand(getResolver, resolveProjectId, context, opts);
  });

// ─── gnosys lens ────────────────────────────────────────────────────────
program
  .command("lens")
  .description("Filtered view of memories. Combine criteria to focus on what matters.")
  .option("-c, --category <category>", "Filter by category")
  .option("-t, --tag <tags...>", "Filter by tag(s)")
  .option("--match <mode>", "Tag match mode: any (default) or all", "any")
  .option("--status <statuses...>", "Filter by status (active, archived, superseded)")
  .option("--author <authors...>", "Filter by author (human, ai, human+ai)")
  .option("--authority <authorities...>", "Filter by authority (declared, observed, imported, inferred)")
  .option("--min-confidence <n>", "Minimum confidence (0-1)")
  .option("--max-confidence <n>", "Maximum confidence (0-1)")
  .option("--created-after <date>", "Created after ISO date")
  .option("--created-before <date>", "Created before ISO date")
  .option("--modified-after <date>", "Modified after ISO date")
  .option("--modified-before <date>", "Modified before ISO date")
  .option("--or", "Combine filters with OR instead of AND (default: AND)")
  .option("--json", "Output as JSON")
  .action(async (opts: {
    category?: string;
    tag?: string[];
    match: string;
    status?: string[];
    author?: string[];
    authority?: string[];
    minConfidence?: string;
    maxConfidence?: string;
    createdAfter?: string;
    createdBefore?: string;
    modifiedAfter?: string;
    modifiedBefore?: string;
    or?: boolean;
    json?: boolean;
  }) => {
    const { runLensCommand } = await import("./lib/lensCommand.js");
    await runLensCommand(getResolver, opts);
  });

// ─── gnosys history <path> ───────────────────────────────────────────────
program
  .command("history <memoryPath>")
  .description("Show audit history for a memory")
  .option("-n, --limit <number>", "Max entries", "20")
  .option("--json", "Output as JSON")
  .action(async (memoryPath: string, opts: { limit: string; json?: boolean }) => {
    const { runHistoryCommand } = await import("./lib/historyCommand.js");
    await runHistoryCommand(memoryPath, opts);
  });

// ─── gnosys timeline ────────────────────────────────────────────────────
program
  .command("timeline")
  .description("Show when memories were created and modified over time")
  .option("-p, --period <period>", "Group by: day, week, month (default), year", "month")
  .option("--project <id>", "Filter to a specific project ID (default: all projects)")
  .option("--limit-titles <n>", "Show titles inline when an entry has <= N memories (default 5)", "5")
  .option("--json", "Output as JSON")
  .action(async (opts: { period: string; project?: string; limitTitles: string; json?: boolean }) => {
    const { runTimelineCommand } = await import("./lib/timelineCommand.js");
    await runTimelineCommand(opts);
  });

// ─── gnosys stats ───────────────────────────────────────────────────────
program
  .command("stats")
  .description("Show summary statistics for the memory store. Use --by-project for a per-project breakdown across the central DB.")
  .option("--json", "Output as JSON")
  .option("--by-project", "Show a per-project breakdown table instead of single-store stats")
  .option("--all", "Include all projects (don't filter to current project)")
  .action(async (opts: { json?: boolean; byProject?: boolean; all?: boolean }) => {
    const { runStatsCommand } = await import("./lib/statsCommand.js");
    await runStatsCommand(opts);
  });

// ─── gnosys links <path> ─────────────────────────────────────────────────
program
  .command("links <memoryPath>")
  .description("Show wikilinks for a memory — both outgoing [[links]] and backlinks from other memories")
  .option("--json", "Output as JSON")
  .action(async (memoryPath: string, opts: { json?: boolean }) => {
    const { runLinksCommand } = await import("./lib/linksCommand.js");
    await runLinksCommand(getResolver, memoryPath, opts);
  });

// ─── gnosys graph ───────────────────────────────────────────────────────
program
  .command("graph")
  .description("Show the [[wikilink]] cross-reference graph between memories. Empty until you start using [[Title]] in memory content — then this shows which memories reference each other.")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { runGraphCommand } = await import("./lib/graphCommand.js");
    await runGraphCommand(opts);
  });

// ─── gnosys bootstrap <sourceDir> ────────────────────────────────────────
program
  .command("bootstrap <sourceDir>")
  .description("Batch-import existing documents into the memory store")
  .option("-p, --pattern <patterns...>", "File patterns to match (default: **/*.md)")
  .option("--skip-existing", "Skip files whose titles already exist in the store")
  .option("-c, --category <category>", "Default category (default: imported)", "imported")
  .option("-a, --author <author>", "Default author", "human")
  .option("--authority <authority>", "Default authority", "imported")
  .option("--confidence <n>", "Default confidence (0-1)", "0.7")
  .option("--preserve-frontmatter", "Preserve existing YAML frontmatter if present")
  .option("--dry-run", "Show what would be imported without writing")
  .option("-s, --store <store>", "Target store (project|personal|global)", undefined)
  .action(
    async (
      sourceDir: string,
      opts: {
        pattern?: string[];
        skipExisting?: boolean;
        category: string;
        author: string;
        authority: string;
        confidence: string;
        preserveFrontmatter?: boolean;
        dryRun?: boolean;
        store?: string;
      }
    ) => {
      const { runBootstrapCommand } = await import("./lib/bootstrapCommand.js");
      await runBootstrapCommand(getResolver, sourceDir, opts);
    }
  );

// ─── gnosys import (parent + subcommands) ───────────────────────────────
const importCmd = program
  .command("import [fileOrUrl]")
  .enablePositionalOptions()
  .description(
    "Import data into Gnosys (bulk CSV/JSON/JSONL — see also: 'gnosys import project <bundle>')"
  )
  .option(
    "--format <format>",
    "Data format: csv, json, jsonl (required for bulk import)"
  )
  .option(
    "--mapping <json>",
    'Field mapping as JSON: \'{"source_field":"gnosys_field"}\'. Valid targets: title, category, content, tags, relevance'
  )
  .option("--mode <mode>", "Processing mode: llm or structured", "structured")
  .option("--limit <n>", "Max records to import", parseInt)
  .option("--offset <n>", "Skip first N records", parseInt)
  .option("--skip-existing", "Skip records whose titles already exist")
  .option("--batch-commit", "Single git commit for all imports (default)", true)
  .option("--no-batch-commit", "Commit each record individually")
  .option("--concurrency <n>", "Parallel LLM calls (default: 5)", parseInt)
  .option("--dry-run", "Preview without writing")
  .option(
    "--store <store>",
    "Target store: project, personal, global",
    "project"
  )
  .action(
    async (
      fileOrUrl: string | undefined,
      opts: {
        format?: string;
        mapping?: string;
        mode: string;
        limit?: number;
        offset?: number;
        skipExisting?: boolean;
        batchCommit: boolean;
        concurrency?: number;
        dryRun?: boolean;
        store: string;
      }
    ) => {
      const { runImportCommand } = await import("./lib/importCommand.js");
      await runImportCommand(getResolver, fileOrUrl, opts);
    }
  );

// `gnosys import project <bundle>` — restore a portable .json.gz bundle
importCmd
  .command("project <bundlePath>")
  .description("Import a project bundle (.json.gz) created by 'gnosys export project'")
  .option("--strategy <strategy>", "Conflict handling: merge (default), replace, new-id", "merge")
  .option("--working-directory <dir>", "Override the bundle's working_directory (e.g. when restoring on a different machine)")
  .option("--json", "Output the result as JSON")
  .action(async (bundlePath: string, opts: { strategy: string; workingDirectory?: string; json?: boolean }) => {
    const validStrategies = ["merge", "replace", "new-id"] as const;
    if (!validStrategies.includes(opts.strategy as typeof validStrategies[number])) {
      console.error(`Invalid strategy: ${opts.strategy}. Use one of: ${validStrategies.join(", ")}`);
      process.exit(1);
    }

    const { GnosysDB: DbClass } = await import("./lib/db.js");
    const { importProject } = await import("./lib/importProject.js");

    const centralDb = DbClass.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB unavailable.");
      process.exit(1);
    }

    try {
      const result = importProject(centralDb, {
        bundlePath: path.resolve(bundlePath),
        strategy: opts.strategy as typeof validStrategies[number],
        workingDirectoryOverride: opts.workingDirectory,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Imported project ${result.projectName} (${result.projectId})`);
        console.log(`  Strategy:        ${result.strategy}`);
        console.log(`  Memories:        ${result.memoriesInserted} inserted, ${result.memoriesSkipped} skipped, ${result.memoriesReplaced} replaced`);
        console.log(`  Relationships:   ${result.relationshipsInserted}`);
        console.log(`  Audit entries:   ${result.auditEntriesInserted}`);
      }
    } catch (err) {
      console.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      centralDb.close();
    }
  });

// ─── gnosys reindex ──────────────────────────────────────────────────────
program
  .command("reindex")
  .description(
    "Rebuild semantic embeddings for every memory in the central DB. Run after bulk imports, schema changes, or if hybrid search starts returning poor matches. Downloads the all-MiniLM-L6-v2 model (~80 MB) on first run.",
  )
  .action(async () => {
    const { runReindexCommand } = await import("./lib/reindexCommand.js");
    await runReindexCommand(getResolver);
  });

// ─── gnosys hybrid-search <query> ───────────────────────────────────────
program
  .command("hybrid-search <query>")
  .description("Search using hybrid keyword + semantic fusion (RRF). Use --federated for cross-scope.")
  .option("-l, --limit <n>", "Max results", "15")
  .option("-m, --mode <mode>", "Search mode: keyword | semantic | hybrid", "hybrid")
  .option("--json", "Output as JSON")
  .option("--federated", "Use federated search with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated)")
  .option("-d, --directory <dir>", "Project directory for context")
  .action(async (query: string, opts: { limit: string; mode: string; json?: boolean; federated?: boolean; scope?: string; directory?: string }) => {
    const { runHybridSearchCommand } = await import("./lib/hybridSearchCommand.js");
    await runHybridSearchCommand(getResolver, query, opts);
  });

// ─── gnosys semantic-search <query> ─────────────────────────────────────
program
  .command("semantic-search <query>")
  .description("Search using semantic similarity only (requires embeddings)")
  .option("-l, --limit <n>", "Max results", "15")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: { limit: string; json?: boolean }) => {
    const { runSemanticSearchCommand } = await import("./lib/semanticSearchCommand.js");
    await runSemanticSearchCommand(getResolver, query, opts);
  });

// ─── gnosys ask <question> ──────────────────────────────────────────────
program
  .command("ask <question>")
  .description(
    "Ask a natural-language question and get a synthesized answer with citations. Use --federated for cross-scope."
  )
  .option("-l, --limit <n>", "Max memories to retrieve", "15")
  .option("-m, --mode <mode>", "Search mode: keyword | semantic | hybrid", "hybrid")
  .option("--no-stream", "Disable streaming output")
  .option("--federated", "Use federated search with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated)")
  .option("-d, --directory <dir>", "Project directory for context")
  .option("--json", "Output as JSON")
  .action(async (question: string, opts: { limit: string; mode: string; stream: boolean; federated?: boolean; scope?: string; directory?: string; json?: boolean }) => {
    const { runAskCommand } = await import("./lib/askCommand.js");
    await runAskCommand(getResolver, question, opts);
  });

// ─── gnosys stores ───────────────────────────────────────────────────────
program
  .command("stores")
  .description("Show all active stores, their layers, paths, and permissions")
  .action(async () => {
    const { runStoresCommand } = await import("./lib/storesCommand.js");
    await runStoresCommand(getResolver);
  });

// ─── gnosys config ──────────────────────────────────────────────────────
const configCmd = program
  .command("config")
  .description("View and manage LLM provider configuration");

configCmd
  .command("show")
  .description("Show current LLM configuration")
  .option("--json", "Dump the raw effective config as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { runConfigShowCommand } = await import("./lib/configCommand.js");
    await runConfigShowCommand(getResolver, opts);
  });

configCmd
  .command("set <key> <value> [extra...]")
  .description("Set a config value. Keys: provider, model, ollama-url, groq-model, openai-model, lmstudio-url, task <task> <provider> <model>")
  .action(async (key: string, value: string, extra: string[]) => {
    const { runConfigSetCommand } = await import("./lib/configCommand.js");
    await runConfigSetCommand(getResolver, key, value, extra);
  });

configCmd
  .command("init")
  .description("Generate a blank gnosys.json template (deprecated — prefer `gnosys setup`)")
  .option("--force", "Skip the deprecation warning and write the template")
  .action(async (opts: { force?: boolean }) => {
    const { runConfigInitCommand } = await import("./lib/configCommand.js");
    await runConfigInitCommand(getResolver, opts);
  });

// ─── gnosys reindex-graph ───────────────────────────────────────────────
program
  .command("reindex-graph")
  .description("Build or rebuild the wikilink graph (.gnosys/graph.json)")
  .action(async () => {
    const { runReindexGraphCommand } = await import("./lib/reindexGraphCommand.js");
    await runReindexGraphCommand(getResolver);
  });

// `gnosys dashboard` was removed in v5.7.1.
// Use `gnosys status --system` instead. Hard removal — commander will emit
// the standard "unknown command" error.

// ─── gnosys maintain ─────────────────────────────────────────────────────
program
  .command("maintain")
  .description("Run vault maintenance: detect duplicates, apply confidence decay, consolidate similar memories")
  .option("--dry-run", "Show what would change without modifying anything")
  .option("--auto-apply", "Automatically apply all changes (no prompts)")
  .action(async (opts: { dryRun?: boolean; autoApply?: boolean }) => {
    const { runMaintainCommand } = await import("./lib/maintainCommand.js");
    await runMaintainCommand(getResolver, opts);
  });

// ─── gnosys dearchive ───────────────────────────────────────────────────
program
  .command("dearchive <query>")
  .description("Force-dearchive memories matching a query from archive.db back to active")
  .option("--limit <n>", "Max memories to dearchive", "5")
  .action(async (query: string, opts: { limit: string }) => {
    const { GnosysArchive } = await import("./lib/archive.js");

    const resolver = await getResolver();
    const stores = resolver.getStores();

    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run gnosys init first.");
      process.exit(1);
    }

    const writeTarget = resolver.getWriteTarget();
    if (!writeTarget) {
      console.error("No writable store found.");
      process.exit(1);
    }

    const archive = new GnosysArchive(writeTarget.path);
    if (!archive.isAvailable()) {
      console.error("Archive not available. Install it with: npm install better-sqlite3");
      process.exit(1);
    }

    const results = archive.searchArchive(query, parseInt(opts.limit));
    if (results.length === 0) {
      console.log(`No archived memories found matching "${query}".`);
      archive.close();
      return;
    }

    console.log(`Found ${results.length} archived memories matching "${query}":\n`);
    for (const r of results) {
      console.log(`  • ${r.title} (${r.id})`);
    }
    console.log("");

    // Dearchive all found
    const ids = results.map((r) => r.id);
    const restored = await archive.dearchiveBatch(ids, writeTarget.store);
    archive.close();

    console.log(`Dearchived ${restored.length} memories back to active:`);
    for (const rp of restored) {
      console.log(`  → ${rp}`);
    }
  });

// NOTE: gnosys migrate is defined below (near the end) with --to-central support

// ─── gnosys upgrade  +  gnosys setup sync-projects ──────────────────────
//
// v5.7.1 (#15) split this command:
//
//   gnosys upgrade            — upgrade the gnosys CLI/MCP itself
//                               (npm install + restart signal to MCPs)
//   gnosys setup sync-projects — what the old `gnosys upgrade` used to do
//                               (re-init project identities, agent rules,
//                                central DB stamp, portfolio dashboard)
//
// The body of the legacy command is preserved verbatim below as
// `syncProjectsAction`, called from the new `setup sync-projects` command.

async function syncProjectsAction(opts: { skipDashboard?: boolean }): Promise<void> {
    const currentVersion = pkg.version;
    // v5.9.3 Screen 10 — Header + leading spinner + hierarchical sections.
    const {
      renderSyncHeader,
      renderUpgradedSection,
      renderSkippedSection,
      renderFailedSection,
      renderMachinesSection,
      renderDivider,
      renderDoneLine,
      renderDashboardSummary,
    } = await import("./lib/setup/syncProjectsRender.js");
    const { Spinner } = await import("./lib/setup/ui/spinner.js");

    console.log("");
    console.log(renderSyncHeader(currentVersion));
    console.log("");

    // 1. Read registered projects from file registry AND central DB
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const registryPath = path.join(home, ".config", "gnosys", "projects.json");
    let fileProjects: string[] = [];
    try {
      fileProjects = JSON.parse(await fs.readFile(registryPath, "utf-8"));
    } catch {
      // No file registry yet
    }

    // Also check central DB for projects not in the file registry. Also
    // capture project titles so the Screen 10 row labels can use the
    // human-readable name where available.
    let dbProjects: string[] = [];
    const titleByDir = new Map<string, string>();
    try {
      const centralDb = GnosysDB.openCentral();
      if (centralDb.isAvailable()) {
        const allProjects = centralDb.getAllProjects();
        dbProjects = allProjects.map((p) => p.working_directory);
        for (const p of allProjects) titleByDir.set(p.working_directory, p.name);
        centralDb.close();
      }
    } catch {
      // non-critical
    }

    // Merge: deduplicate by resolved path
    const seen = new Set<string>();
    const projects: string[] = [];
    for (const p of [...fileProjects, ...dbProjects]) {
      const resolved = path.resolve(p);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        projects.push(resolved);
      }
    }

    if (projects.length === 0) {
      console.log(" no registered projects found");
      console.log(" run `gnosys init` in each project first");
      return;
    }

    // Lead-in spinner: shows we're churning through the registry. Resolves
    // to ✓ summary after the iteration loop completes (or fail on hard error).
    const syncSpinner = Spinner(`syncing ${projects.length} registered projects…`);

    // Sync the merged list back to file registry
    try {
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(registryPath, JSON.stringify(projects, null, 2), "utf-8");
    } catch {
      // non-critical
    }

    // 2. Iterate and upgrade each project that exists on this machine
    const upgraded: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const projectDir of projects) {
      // Skip test/temp directories
      if (projectDir.startsWith("/tmp/") || projectDir.startsWith("/private/tmp/") || projectDir.startsWith("/var/folders/") || projectDir.startsWith("/private/var/folders/")) {
        continue;
      }

      const storePath = path.join(projectDir, ".gnosys");
      try {
        await fs.stat(storePath);
      } catch {
        skipped.push(projectDir);
        continue;
      }

      try {
        // Re-create project identity (re-syncs with central DB)
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          if (!centralDb.isAvailable()) centralDb = null;
        } catch {
          centralDb = null;
        }

        await createProjectIdentity(projectDir, { centralDb: centralDb || undefined });

        // Re-register in file-based registry (idempotent)
        const tempResolver = new GnosysResolver();
        await tempResolver.registerProject(projectDir);

        // Re-generate agent rules for all detected IDEs
        if (centralDb) {
          const { syncToTarget } = await import("./lib/rulesGen.js");
          const { readProjectIdentity } = await import("./lib/projectIdentity.js");
          const identity = await readProjectIdentity(projectDir);
          const projectId = identity?.projectId || null;

          try {
            await syncToTarget(centralDb, projectDir, "all", projectId);
          } catch {
            // Some projects may not have IDE configs — that's ok
          }

          centralDb.close();
        }

        // Configure IDE hooks for automatic memory recall
        const { configureIdeHooks } = await import("./lib/projectIdentity.js");
        await configureIdeHooks(projectDir);

        upgraded.push(projectDir);
      } catch (err) {
        failed.push(`${projectDir} (${(err as Error).message})`);
      }
    }

    // Stop the lead-in spinner now that the iteration is done. Resolved
    // before any per-section output so the cursor is on a fresh line.
    syncSpinner.ok(
      `synced ${projects.length} registered projects`,
      `${upgraded.length} upgraded · ${skipped.length} skipped · ${failed.length} failed`,
    );

    // 3. Update global agent rules
    try {
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) centralDb = null;
      } catch {
        centralDb = null;
      }
      if (centralDb) {
        const { syncToTarget } = await import("./lib/rulesGen.js");
        await syncToTarget(centralDb, process.cwd(), "global", null);
        centralDb.close();
        const { printStatus } = await import("./lib/setup/ui/status.js");
        printStatus("ok", "global agent rules updated", "~/.claude/CLAUDE.md");
      }
    } catch {
      const { printStatus } = await import("./lib/setup/ui/status.js");
      printStatus("warn", "could not update global agent rules");
    }

    // 4. Stamp the central DB with current version and machine info
    try {
      const centralDb = GnosysDB.openCentral();
      if (centralDb.isAvailable()) {
        const hostname = os.hostname();
        centralDb.setMeta("app_version", currentVersion);
        centralDb.setMeta("last_upgrade", new Date().toISOString());
        centralDb.setMeta("upgraded_by", hostname);

        // Track all machines that have accessed this DB
        let machines: Record<string, { version: string; lastSeen: string }> = {};
        try {
          const raw = centralDb.getMeta("machines");
          if (raw) machines = JSON.parse(raw);
        } catch { /* fresh start */ }
        machines[hostname] = { version: currentVersion, lastSeen: new Date().toISOString() };
        centralDb.setMeta("machines", JSON.stringify(machines));

        centralDb.close();
      }
    } catch {
      // non-critical
    }

    // 5. Report — v5.9.3 Screen 10 hierarchical layout. Section helpers
    // turn the raw path arrays into ProjectRow lists (title + fullPath)
    // and emit dividers between groups.
    function rowFor(p: string): { title: string; fullPath: string } {
      const title = titleByDir.get(p) ?? titleByDir.get(path.resolve(p)) ?? path.basename(p);
      return { title, fullPath: p };
    }
    const upgradedRows = upgraded.map(rowFor);
    const skippedRows = skipped.map(rowFor);
    const failedRows = failed.map((f) => {
      // failed entries are "<path> (<err>)" — extract path for the title.
      const match = f.match(/^(.+?)\s\((.+)\)$/);
      const projectPath = match ? match[1] : f;
      return { title: titleByDir.get(projectPath) ?? path.basename(projectPath), fullPath: f };
    });

    console.log("");
    for (const line of renderUpgradedSection(upgradedRows)) console.log(line);
    if (upgradedRows.length > 0 && (skippedRows.length > 0 || failedRows.length > 0)) {
      console.log("");
    }
    for (const line of renderSkippedSection(skippedRows)) console.log(line);
    if (failedRows.length > 0) {
      console.log("");
      for (const line of renderFailedSection(failedRows)) console.log(line);
    }

    // Connected-machines callout (separate divider per design spec).
    let machineLines: string[] = [];
    try {
      const centralDb = GnosysDB.openCentral();
      if (centralDb.isAvailable()) {
        const raw = centralDb.getMeta("machines");
        if (raw) {
          const machines = JSON.parse(raw) as Record<string, { version: string; lastSeen: string }>;
          const entries = Object.entries(machines);
          const currentHost = os.hostname();
          const machineRows = entries.map(([host, info]) => ({
            hostname: host,
            version: info.version,
            lastSeen: info.lastSeen,
            isCurrent: host === currentHost,
          }));
          machineLines = renderMachinesSection(machineRows, currentVersion);
        }
        centralDb.close();
      }
    } catch {
      // non-critical
    }

    if (machineLines.length > 0) {
      console.log("");
      console.log(renderDivider());
      console.log("");
      for (const line of machineLines) console.log(line);
    }

    console.log("");
    console.log(renderDivider());
    console.log("");
    console.log(renderDoneLine(currentVersion));

    if (skippedRows.length > 0) {
      // v5.9.3 Phase H: offer one-keystroke cleanup. Stays interactive
      // by default; users on a TTY get the prompt, non-TTY runs silently
      // (sync-projects is sometimes invoked from CI).
      console.log("");
      if (process.stdout.isTTY) {
        try {
          const { cleanupRegistry } = await import("./lib/cleanup.js");
          await cleanupRegistry({ interactive: true });
        } catch (err) {
          const { printStatus } = await import("./lib/setup/ui/status.js");
          printStatus("warn", "cleanup skipped", err instanceof Error ? err.message : String(err));
        }
      } else {
        const { printStatus } = await import("./lib/setup/ui/status.js");
        printStatus("progress", "tip", "run `gnosys cleanup` to remove stale entries");
      }
    }

    // 6. Regenerate portfolio dashboard
    if (!opts.skipDashboard) {
      try {
        const dashboardPath = path.join(home, "gnosys-dashboard.html");
        const dashboardMdPath = path.join(home, "gnosys-dashboard.md");
        const centralDb = GnosysDB.openCentral();
        if (centralDb.isAvailable()) {
          const { generatePortfolio, formatPortfolioMarkdown } = await import("./lib/portfolio.js");
          const { generatePortfolioHtml } = await import("./lib/portfolioHtml.js");
          const report = generatePortfolio(centralDb);
          await fs.writeFile(dashboardPath, generatePortfolioHtml(report, dashboardPath), "utf-8");
          await fs.writeFile(dashboardMdPath, formatPortfolioMarkdown(report), "utf-8");
          centralDb.close();
          console.log("");
          for (const line of renderDashboardSummary(dashboardPath, dashboardMdPath)) {
            console.log(line);
          }
        }
      } catch {
        const { printStatus } = await import("./lib/setup/ui/status.js");
        console.log("");
        printStatus("warn", "could not regenerate portfolio dashboard");
      }
    }
}

// `gnosys setup sync-projects` — re-init project identities + agent rules.
// (This is what `gnosys upgrade` used to do; renamed in v5.7.1.)
setupCmd
  .command("sync-projects")
  .description("Re-initialize all registered projects after upgrading gnosys: refresh agent rules, project registry, central DB stamp, and portfolio dashboard.")
  .option("--skip-dashboard", "Skip regenerating the portfolio dashboard")
  .action(syncProjectsAction);

// `gnosys cleanup` — prune dead/temp entries from the project registry.
// Standalone top-level command per Phase H. Also reusable from inside
// `setup sync-projects` when the skipped list is non-empty (see
// road-015).
program
  .command("cleanup")
  .description("Remove dead and temp-dir entries from the project registry")
  .option("--yes", "Non-interactive, remove without prompting")
  .option("--dry-run", "Show what would be removed without writing")
  .action(async (opts: { yes?: boolean; dryRun?: boolean }) => {
    const { cleanupRegistry } = await import("./lib/cleanup.js");
    const result = await cleanupRegistry({
      interactive: !opts.yes && !opts.dryRun,
      yes: opts.yes,
    });
    if (opts.yes || opts.dryRun) {
      console.log(JSON.stringify(result, null, 2));
    }
  });

// `gnosys upgrade` — upgrade the gnosys CLI/MCP itself, then prompt the
// user to run sync-projects. Writes ~/.gnosys/last-upgrade-at so running
// MCP servers exit cleanly and the host respawns them against the new
// global binary (see src/lib/upgrade.ts).
program
  .command("upgrade")
  .description("Upgrade gnosys itself and signal running MCP servers to restart. After upgrading, suggests running 'gnosys setup sync-projects'.")
  .option("--yes", "Skip the post-upgrade sync-projects prompt and exit")
  .option("--no-sync", "Don't suggest running sync-projects afterward")
  .action(async (opts: { yes?: boolean; sync?: boolean }) => {
    const currentVersion = pkg.version;
    console.log(`Gnosys CLI: currently v${currentVersion}`);

    const { detectPackageManager, upgradeCommand } = await import("./lib/packageManager.js");
    const pm = detectPackageManager();
    const cmd = upgradeCommand(pm);
    if (!cmd) {
      console.log(
        "Running under npx — there's no global install to upgrade. Use `npx gnosys@latest` to run the latest.",
      );
      return;
    }

    console.log(`Running: ${cmd} ...`);

    const { execSync } = await import("child_process");
    try {
      execSync(cmd, { stdio: "inherit" });
    } catch (err) {
      console.error(`\nUpgrade failed: ${err instanceof Error ? err.message : err}`);
      console.error(`Try running '${cmd}' manually.`);
      process.exit(1);
    }

    // Read the newly-installed version (best-effort — we may still be the
    // old binary in-process; this is purely informational).
    let newVersion = "(see npm output)";
    try {
      const out = execSync("npm ls -g gnosys --depth=0 --json", { encoding: "utf8" });
      const parsed = JSON.parse(out);
      newVersion = parsed?.dependencies?.gnosys?.version || newVersion;
    } catch {
      // Best-effort lookup only.
    }

    // v5.8.5: surface the version transition so it's obvious the upgrade
    // worked, even though this process is still on the old binary in-memory.
    if (newVersion !== "(see npm output)" && newVersion !== currentVersion) {
      console.log(`\n✓ Installed gnosys v${newVersion} (was v${currentVersion})`);
    } else if (newVersion === currentVersion) {
      console.log(`\n✓ Already on latest: v${currentVersion}`);
    }

    // Write the marker so any running MCP servers exit and respawn.
    const { writeUpgradeMarker } = await import("./lib/upgrade.js");
    try {
      writeUpgradeMarker(typeof newVersion === "string" && newVersion !== "(see npm output)"
        ? newVersion
        : currentVersion);
      console.log(`\n✓ Upgrade marker written: ~/.gnosys/last-upgrade-at`);
      console.log(`  Any running MCP servers will detect this within 10s and restart cleanly.`);
      console.log(`  (Your MCP client — Claude Code, Cursor, VS Code — will auto-respawn.)`);
    } catch (err) {
      console.error(`\nCould not write upgrade marker: ${err instanceof Error ? err.message : err}`);
      console.error(`Running MCP servers will need to be restarted manually.`);
    }

    if (opts.sync === false || opts.yes) {
      console.log(`\nDone. Run 'gnosys setup sync-projects' when you're ready to refresh registered projects.`);
      return;
    }

    // Prompt for sync-projects.
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
      rl.question(`\nRun 'gnosys setup sync-projects' now to refresh registered projects? [Y/n] `, resolve),
    );
    rl.close();

    if (answer.trim().toLowerCase() === "n" || answer.trim().toLowerCase() === "no") {
      console.log(`Done. You can run 'gnosys setup sync-projects' later.`);
      return;
    }

    console.log(``);
    // v5.8.5: shell out to the freshly-installed binary instead of running
    // syncProjectsAction in-process. The in-process call reuses pkg.version
    // captured at startup (the OLD version), so the banner said "Gnosys
    // v5.8.3 — upgrading registered projects" right after installing 5.8.4.
    // execSync spawns a new process that resolves `gnosys` on PATH to the
    // upgraded global binary, so the right version banner shows.
    try {
      execSync("gnosys setup sync-projects", { stdio: "inherit" });
    } catch (err) {
      console.error(`\nSync-projects failed: ${err instanceof Error ? err.message : err}`);
      console.error(`Run 'gnosys setup sync-projects' manually.`);
      process.exit(1);
    }
  });

// ─── gnosys doctor ──────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check system health: stores, LLM connectivity, embeddings, archive")
  .option("--fix", "Offer interactive cleanup of legacy artifacts (e.g. per-store gnosys.db)")
  .action(async (opts: { fix?: boolean }) => {
    const { runDoctorCommand } = await import("./lib/doctorCommand.js");
    await runDoctorCommand(getResolver, opts);
  });

// ─── gnosys check ─────────────────────────────────────────────────────────
program
  .command("check")
  .description("Test LLM connectivity for each configured task (structuring, synthesis, chat, vision, transcription, dream)")
  .option("-t, --task <name>", "Test only one task (structuring | synthesis | chat | vision | transcription | dream)")
  .action(async (opts: { task?: string }) => {
    const projectDir = process.cwd();
    const storePath = path.join(projectDir, ".gnosys");
    const globalStorePath = getGnosysHome();

    // Load config: try project-level first, fall back to global ~/.gnosys/
    let cfg: GnosysConfig;
    let configSource: string;
    try {
      const projectCfg = await loadConfig(storePath);
      // Check if it's just defaults (no actual config file) by seeing if dream has been configured
      const hasProjectConfig = projectCfg.dream?.provider !== DEFAULT_CONFIG.dream?.provider ||
        projectCfg.llm?.defaultProvider !== DEFAULT_CONFIG.llm?.defaultProvider;
      if (hasProjectConfig) {
        cfg = projectCfg;
        configSource = storePath;
      } else {
        cfg = await loadConfig(globalStorePath);
        configSource = globalStorePath;
      }
    } catch {
      cfg = await loadConfig(globalStorePath);
      configSource = globalStorePath;
    }

    const GREEN = "\x1b[32m";
    const RED = "\x1b[31m";
    const YELLOW = "\x1b[33m";
    const DIM = "\x1b[2m";
    const BOLD = "\x1b[1m";
    const RESET = "\x1b[0m";
    const CHECK = `${GREEN}✓${RESET}`;
    const CROSS = `${RED}✗${RESET}`;
    const WARN = `${YELLOW}⚠${RESET}`;

    console.log(`\n${BOLD}Gnosys LLM Check${RESET} ${DIM}(config: ${configSource})${RESET}\n`);

    // Define the 5 tasks and how to resolve each
    interface TaskCheck {
      name: string;
      description: string;
      resolve: () => { provider: string; model: string };
      needsKey?: boolean;
    }

    const tasks: TaskCheck[] = [
      {
        name: "structuring",
        description: "adding memories, tagging",
        resolve: () => resolveTaskModel(cfg, "structuring"),
      },
      {
        name: "synthesis",
        description: "Q&A answers (gnosys ask)",
        resolve: () => resolveTaskModel(cfg, "synthesis"),
      },
      {
        name: "chat",
        description: "interactive chat (gnosys chat)",
        // Chat reuses the synthesis task's model — surface it under its own name
        // so users can see exactly what their TUI will use.
        resolve: () => resolveTaskModel(cfg, "synthesis"),
      },
      {
        name: "vision",
        description: "images, PDFs",
        resolve: () => resolveTaskModel(cfg, "vision"),
      },
      {
        name: "transcription",
        description: "audio files",
        resolve: () => resolveTaskModel(cfg, "transcription"),
      },
      {
        name: "dream",
        description: "overnight consolidation",
        resolve: () => ({
          provider: cfg.dream?.provider || "ollama",
          model: cfg.dream?.model || "llama3.2",
        }),
      },
    ];

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    // Filter to a single task if --task was given.
    const filteredTasks = opts.task
      ? tasks.filter((t) => t.name === opts.task)
      : tasks;
    if (opts.task && filteredTasks.length === 0) {
      console.error(`Unknown task: ${opts.task}. Pick one of: ${tasks.map((t) => t.name).join(", ")}`);
      process.exit(1);
    }

    for (const task of filteredTasks) {
      const { provider, model } = task.resolve();
      const label = `${task.name.padEnd(16)} ${DIM}${provider} / ${model}${RESET}`;
      const desc = `${DIM}(${task.description})${RESET}`;

      // Special handling for dream — check if enabled
      if (task.name === "dream" && !cfg.dream?.enabled) {
        console.log(`  ${WARN} ${label}  disabled  ${desc}`);
        skipped++;
        continue;
      }

      // Check provider availability (API key, etc.)
      const availability = isProviderAvailable(cfg, provider as LLMProviderName);
      if (!availability.available) {
        console.log(`  ${CROSS} ${label}  ${RED}${availability.error}${RESET}  ${desc}`);
        failed++;
        continue;
      }

      // Test actual connection with timing
      const start = Date.now();
      try {
        const llmProvider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: provider as LLMProviderName } });
        await llmProvider.testConnection();
        const ms = Date.now() - start;
        console.log(`  ${CHECK} ${label}  ${GREEN}${ms}ms${RESET}  ${desc}`);
        passed++;
      } catch (err) {
        const ms = Date.now() - start;
        const errMsg = err instanceof Error ? err.message : String(err);
        // Truncate long error messages
        const shortErr = errMsg.length > 60 ? errMsg.slice(0, 57) + "..." : errMsg;
        console.log(`  ${CROSS} ${label}  ${RED}${shortErr}${RESET} (${ms}ms)  ${desc}`);
        failed++;
      }
    }

    console.log();
    const total = passed + failed + skipped;
    if (failed === 0) {
      console.log(`${CHECK} All ${passed}/${total} tasks connected.`);
    } else {
      console.log(`${passed}/${total} connected, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}.`);
      console.log(`\n${DIM}Fix: Run 'gnosys setup' to configure providers and API keys.${RESET}`);
    }
    console.log();
  });

// ─── gnosys dream (parent command) ───────────────────────────────────────
const dreamCmd = program
  .command("dream")
  .description("Dream Mode — idle-time consolidation (run a cycle, view log)");

// Shared executor — used by both bare `gnosys dream` and `gnosys dream run`.
type DreamRunOpts = {
  maxRuntime?: string;
  critique?: boolean;
  summaries?: boolean;
  relationships?: boolean;
  json?: boolean;
  force?: boolean;
};

async function runDreamCycle(opts: DreamRunOpts): Promise<void> {
  const resolver = new GnosysResolver();
  await resolver.resolve();
  const stores = resolver.getStores();
  if (stores.length === 0) {
    console.error("No Gnosys stores found. Run 'gnosys init' first.");
    process.exit(1);
  }

  const { GnosysDB: DbClass } = await import("./lib/db.js");
  const { GnosysDreamEngine, formatDreamReport } = await import("./lib/dream.js");
  const { getMachineId } = await import("./lib/remote.js");

  const storePath = stores[0].path;
  const cfg = await loadConfig(storePath);
  const db = new DbClass(storePath);

  if (!db.isAvailable() || !db.isMigrated()) {
    console.error("Dream Mode requires gnosys.db (v2.0). Run 'gnosys migrate' first.");
    process.exit(1);
  }

  // Designation gate — warn (and exit unless --force) if this isn't the
  // designated dream machine. Manual runs from non-designated machines are
  // useful for testing but shouldn't happen by accident on shared brains.
  const centralDb = GnosysDB.openCentral();
  if (centralDb.isAvailable()) {
    const designated = centralDb.getDreamMachineId();
    if (designated) {
      const localId = getMachineId(centralDb);
      if (designated !== localId && !opts.force) {
        console.error(
          `Dream is designated to machine ${designated}, but this is ${localId}.\n` +
          `Pass --force to run anyway, or run 'gnosys setup dream' to redesignate.`
        );
        centralDb.close();
        db.close();
        process.exit(1);
      }
    }
    centralDb.close();
  }

  const dreamConfig = {
    enabled: true,
    idleMinutes: 0,
    maxRuntimeMinutes: opts.maxRuntime ? parseInt(opts.maxRuntime, 10) : 30,
    selfCritique: opts.critique !== false,
    generateSummaries: opts.summaries !== false,
    discoverRelationships: opts.relationships !== false,
    minMemories: 1,
    provider: cfg.dream?.provider || ("ollama" as const),
    model: cfg.dream?.model,
  };

  console.error("Starting Dream Mode cycle...");
  const engine = new GnosysDreamEngine(db, cfg, dreamConfig);
  const report = await engine.dream((phase, detail) => {
    console.error(`  [${phase}] ${detail}`);
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDreamReport(report));
  }

  db.close();
}

// Bare `gnosys dream` runs a cycle (preserves v5.4.1 behavior).
dreamCmd
  .option("--max-runtime <minutes>", "Max runtime in minutes (default: 30)")
  .option("--no-critique", "Skip self-critique phase")
  .option("--no-summaries", "Skip summary generation")
  .option("--no-relationships", "Skip relationship discovery")
  .option("--force", "Run even if this machine is not the designated dream node")
  .option("--json", "Output raw JSON report")
  .action(runDreamCycle);

// `gnosys dream run` — explicit alias matching the `gnosys dream log|run`
// pattern. Same options + behavior as the bare command.
dreamCmd
  .command("run")
  .description("Force a dream cycle now (manual trigger)")
  .option("--max-runtime <minutes>", "Max runtime in minutes (default: 30)")
  .option("--no-critique", "Skip self-critique phase")
  .option("--no-summaries", "Skip summary generation")
  .option("--no-relationships", "Skip relationship discovery")
  .option("--force", "Run even if this machine is not the designated dream node")
  .option("--json", "Output raw JSON report")
  .action(runDreamCycle);

// `gnosys dream log` — view recent dream runs from audit_log
dreamCmd
  .command("log")
  .description("Show recent dream runs from the audit log (default: last 20)")
  .option("--last <N>", "Number of most recent runs to show", "20")
  .option("--since <YYYY-MM-DD>", "Only runs since this date")
  .option("--failures-only", "Only runs with errors or unreachable provider")
  .option("--json", "Output raw audit rows as JSON")
  .action(async function (this: import("commander").Command, opts: { last: string; since?: string; failuresOnly?: boolean; json?: boolean }) {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available.");
        process.exit(1);
      }
      const limit = Math.max(1, parseInt(opts.last) || 20);
      const sinceIso = opts.since ? `${opts.since}T00:00:00Z` : undefined;
      const runs = centralDb.getRecentDreamRuns(limit, {
        failuresOnly: !!opts.failuresOnly,
        sinceIso,
      });
      // Commander v13 hoists `--json` to the parent when both parent and
      // subcommand define it. Check the parent (dreamCmd) too so users can
      // type `gnosys dream log --json` and get JSON output.
      const wantJson = !!opts.json || !!(this.parent?.opts().json);
      // JSON path always emits a structured response — including empty runs.
      if (wantJson) {
        console.log(JSON.stringify({ count: runs.length, runs }, null, 2));
        return;
      }
      if (runs.length === 0) {
        console.log("No dream runs recorded.");
        return;
      }
      const DIM = "\x1b[2m";
      const RESET = "\x1b[0m";
      const RED = "\x1b[31m";
      const GREEN = "\x1b[32m";
      console.log(`${runs.length} dream run(s):\n`);
      for (const r of runs) {
        const d = r.details as Record<string, unknown>;
        const dur = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—";
        const summaries = Number(d.summariesGenerated || 0);
        const decays = Number(d.decayUpdated || 0);
        const reviews = Number(d.reviewSuggestions || 0);
        const rels = Number(d.relationshipsDiscovered || 0);
        const errors = Number(d.errors || 0);
        const unreachable = Boolean(d.providerUnreachable);
        const status = unreachable
          ? `${RED}provider unreachable${RESET}`
          : errors > 0
            ? `${RED}${errors} error(s)${RESET}`
            : summaries + decays + rels > 0
              ? `${GREEN}did work${RESET}`
              : `${DIM}no LLM work${RESET}`;
        console.log(`  ${r.completed} ${DIM}(${dur})${RESET} ${status}`);
        console.log(`    decays=${decays} summaries=${summaries} reviews=${reviews} relations=${rels}`);
        if (d.provider) {
          console.log(`    ${DIM}provider=${d.provider}${d.model ? "/" + d.model : ""}${RESET}`);
        }
      }
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys export (parent + subcommands) ────────────────────────────────
type VaultExportOpts = { to: string; all?: boolean; overwrite?: boolean; summaries?: boolean; reviews?: boolean; graph?: boolean; json?: boolean };

async function runVaultExport(opts: VaultExportOpts): Promise<void> {
  const resolver = new GnosysResolver();
  await resolver.resolve();
  const stores = resolver.getStores();
  if (stores.length === 0) {
    console.error("No Gnosys stores found. Run 'gnosys init' first.");
    process.exit(1);
  }

  const { GnosysDB: DbClass } = await import("./lib/db.js");
  const { GnosysExporter, formatExportReport } = await import("./lib/export.js");

  const storePath = stores[0].path;
  const db = new DbClass(storePath);

  if (!db.isAvailable() || !db.isMigrated()) {
    console.error("Export requires gnosys.db (v2.0). Run 'gnosys migrate' first.");
    process.exit(1);
  }

  const targetDir = path.resolve(opts.to);
  console.error(`Exporting to: ${targetDir}`);

  const exporter = new GnosysExporter(db);
  const report = await exporter.export({
    targetDir,
    activeOnly: !opts.all,
    includeSummaries: opts.summaries !== false,
    includeReviews: opts.reviews !== false,
    includeGraph: opts.graph !== false,
    overwrite: opts.overwrite || false,
    onProgress: (current, total, file) => {
      if (current % 10 === 0 || current === total) {
        console.error(`  [${current}/${total}] ${file}`);
      }
    },
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatExportReport(report));
  }

  db.close();
}

const exportCmd = program
  .command("export")
  .description("Export memory to a vault (markdown) or a project bundle (.json.gz)")
  .enablePositionalOptions();

// Bare `gnosys export` shows the canonical subcommand forms. Back-compat for
// the v5.5.x form `gnosys export --to <dir>` is handled in a pre-parse shim
// at the top of the file (rewrites argv to insert "vault" before "--to").
exportCmd.action(() => {
  console.error("Usage: gnosys export vault --to <dir>             # Obsidian vault export");
  console.error("       gnosys export project [id] --to <bundle>   # portable .json.gz bundle");
  process.exit(1);
});

// `gnosys export vault` — explicit alias for the default behavior
exportCmd
  .command("vault")
  .description("Export gnosys.db to an Obsidian-compatible vault (one-way)")
  .requiredOption("--to <dir>", "Target directory for export")
  .option("--all", "Export all memories (active + archived)")
  .option("--overwrite", "Overwrite existing files")
  .option("--no-summaries", "Skip category summaries")
  .option("--no-reviews", "Skip review suggestions")
  .option("--no-graph", "Skip relationship graph")
  .option("--json", "Output raw JSON report")
  .action(runVaultExport);

// `gnosys export project [id]` — bundle a single project for portability
exportCmd
  .command("project [projectId]")
  .description("Export a single project to a portable .json.gz bundle (round-trips with 'gnosys import project')")
  .requiredOption("--to <file>", "Output bundle file path (e.g. ./gnosys-public.gnosys.json.gz)")
  .option("--include-archived", "Include archived and superseded memories (default: active only)")
  .option("--no-audit", "Skip the audit log")
  .option("--json", "Output the result as JSON")
  .action(async (projectIdArg: string | undefined, opts: { to: string; includeArchived?: boolean; audit?: boolean; json?: boolean }) => {
    const { GnosysDB: DbClass } = await import("./lib/db.js");
    const { exportProject } = await import("./lib/exportProject.js");

    const centralDb = DbClass.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB unavailable.");
      process.exit(1);
    }

    let projectId = projectIdArg;
    if (!projectId) {
      // Auto-detect from cwd
      const proj = centralDb.getProjectByDirectory(process.cwd());
      if (!proj) {
        console.error("No project ID given and current directory is not a registered project.");
        console.error("Usage: gnosys export project <projectId> --to <file>");
        process.exit(1);
      }
      projectId = proj.id;
    }

    try {
      const result = exportProject(centralDb, {
        projectId,
        outputPath: path.resolve(opts.to),
        includeArchived: !!opts.includeArchived,
        includeAudit: opts.audit !== false,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const ratio = (result.compressedBytes / result.uncompressedBytes * 100).toFixed(1);
        console.log(`Exported project ${projectId}`);
        console.log(`  Memories:      ${result.memoryCount}`);
        if (result.archivedExcluded > 0) {
          console.log(
            `  Archived:      ${result.archivedExcluded} excluded — re-run with --include-archived for a full backup`,
          );
        }
        console.log(`  Relationships: ${result.relationshipCount}`);
        console.log(`  Audit entries: ${result.auditEntryCount}`);
        console.log(`  Bundle:        ${result.outputPath}`);
        console.log(`  Size:          ${(result.compressedBytes / 1024).toFixed(1)} KB compressed (${ratio}% of ${(result.uncompressedBytes / 1024).toFixed(1)} KB)`);
      }
    } finally {
      centralDb.close();
    }
  });

// ─── gnosys serve ────────────────────────────────────────────────────────
program
  .command("serve")
  .description(
    "Start the MCP server (stdio mode). Used by IDE integrations — Claude Code/Desktop, Cursor, Codex, etc. spawn this command in the background to talk to gnosys via the Model Context Protocol. You don't normally invoke this yourself; `gnosys setup ides` wires gnosys-mcp into your IDE configs.",
  )
  .option("--with-maintenance", "Run maintenance every 6 hours in background")
  .option("--transport <mode>", "Transport: 'stdio' (default) or 'http' (central-server topology)", "stdio")
  .option("--host <addr>", "HTTP bind address — http transport (default 127.0.0.1; use a tailnet addr to share)", "127.0.0.1")
  .option("--port <n>", "HTTP port — http transport", "7777")
  .option("--token <token>", "Require 'Authorization: Bearer <token>' — http transport")
  .action(async (opts: { withMaintenance?: boolean; transport?: string; host?: string; port?: string; token?: string }) => {
    if (opts.transport === "http") {
      process.env.GNOSYS_TRANSPORT = "http";
      process.env.GNOSYS_HTTP_HOST = opts.host || "127.0.0.1";
      process.env.GNOSYS_HTTP_PORT = String(opts.port || "7777");
      if (opts.token) process.env.GNOSYS_SERVE_TOKEN = opts.token;
    }
    if (opts.withMaintenance) {
      // Start background maintenance loop
      const SIX_HOURS = 6 * 60 * 60 * 1000;
      const runMaintenance = async () => {
        try {
          const { GnosysMaintenanceEngine } = await import("./lib/maintenance.js");
          const resolver = new (await import("./lib/resolver.js")).GnosysResolver();
          await resolver.resolve();
          const stores = resolver.getStores();
          if (stores.length > 0) {
            const cfg = await loadConfig(stores[0].path);
            const engine = new GnosysMaintenanceEngine(resolver, cfg);
            const report = await engine.maintain({ autoApply: true });
            console.error(`[maintenance] Completed: ${report.actions.length} action(s), ${report.duplicates.length} duplicate(s), ${report.staleMemories.length} stale`);
          }
        } catch (err) {
          console.error(`[maintenance] Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      // Run immediately on start, then every 6 hours
      setTimeout(runMaintenance, 30000); // 30s after server start
      setInterval(runMaintenance, SIX_HOURS);
      console.error("[maintenance] Background maintenance enabled (every 6 hours)");
    }

    const { startMcpServer } = await import("./index.js");
    await startMcpServer();
  });

// ─── gnosys recall ───────────────────────────────────────────────────────
program
  .command("recall <query>")
  .description("Always-on memory recall — injects most relevant memories as context. Use --federated for cross-scope.")
  .option("--limit <n>", "Max memories to return (default from config)")
  .option("--aggressive", "Force aggressive mode (inject even medium-relevance memories)")
  .option("--no-aggressive", "Force filtered mode (hard cutoff at minRelevance)")
  .option("--trace-id <id>", "Trace ID for audit correlation")
  .option("--json", "Output raw JSON instead of formatted text")
  .option("--host", "Output in host-friendly <gnosys-recall> format (default for MCP)")
  .option("--federated", "Use federated search with tier boosting (project > user > global)")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated)")
  .option("-d, --directory <dir>", "Project directory for context")
  .action(async (query: string, opts: { limit?: string; aggressive?: boolean; traceId?: string; json?: boolean; host?: boolean; federated?: boolean; scope?: string; directory?: string }) => {
    const { runRecallCommand } = await import("./lib/recallCommand.js");
    await runRecallCommand(query, opts);
  });

// ─── gnosys audit ────────────────────────────────────────────────────────
program
  .command("audit")
  .description("View the structured audit trail of memory operations from the central DB")
  .option("--days <n>", "Show entries from the last N days", "7")
  .option("--operation <op>", "Filter by operation type (read, write, recall, dream_*, etc.)")
  .option("--limit <n>", "Max entries to show")
  .option("--json", "Output raw JSON instead of formatted timeline")
  .action(async (opts: { days: string; operation?: string; limit?: string; json?: boolean }) => {
    const { readAuditFromDb, formatAuditTimeline } = await import("./lib/audit.js");
    const centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB unavailable.");
      process.exit(1);
    }
    try {
      const entries = readAuditFromDb(centralDb, {
        days: parseInt(opts.days, 10),
        operation: opts.operation as import("./lib/audit.js").AuditOperation | undefined,
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        console.log(formatAuditTimeline(entries));
      }
    } finally {
      centralDb.close();
    }
  });

// ─── gnosys backup ──────────────────────────────────────────────────────
program
  .command("backup")
  .description("Create a backup of the central Gnosys database and config")
  .option("-o, --output <dir>", "Backup output directory (default: ~/.gnosys/)")
  .option("--to <dir>", "Alias for --output")
  .option("--json", "Output as JSON")
  .action(async (opts: { output?: string; to?: string; json?: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      const outputDir = opts.to || opts.output;
      const backupPath = await centralDb.backup(outputDir);
      const counts = centralDb.getMemoryCount();
      const projectCount = centralDb.getAllProjects().length;

      // Copy sandbox log if it exists
      const centralDir = GnosysDB.getCentralDbDir();
      const copiedFiles: string[] = [backupPath];
      const backupDir = path.dirname(backupPath);
      const sandboxLog = path.join(centralDir, "sandbox", "sandbox.log");
      if (existsSync(sandboxLog)) {
        const logDest = path.join(backupDir, "sandbox.log.bak");
        copyFileSync(sandboxLog, logDest);
        copiedFiles.push(logDest);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true, backupPath, memories: counts.total,
          active: counts.active, archived: counts.archived,
          projects: projectCount, files: copiedFiles,
        }));
      } else {
        console.log(`Backup created: ${backupPath}`);
        console.log(`  Memories: ${counts.total} (${counts.active} active, ${counts.archived} archived)`);
        console.log(`  Projects: ${projectCount}`);
        if (copiedFiles.length > 1) console.log(`  Additional files: ${copiedFiles.length - 1}`);
      }
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Backup failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys restore ─────────────────────────────────────────────────────
program
  .command("restore <backupFile>")
  .description("Restore the central Gnosys database from a backup")
  .option("--from <file>", "Alias: backup file to restore from")
  .option("--json", "Output as JSON")
  .action(async (backupFile: string, opts: { from?: string; json?: boolean }) => {
    const resolved = path.resolve(opts.from || backupFile);
    try {
      const db = GnosysDB.restore(resolved);
      const counts = db.getMemoryCount();
      const projectCount = db.getAllProjects().length;

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true, source: resolved, memories: counts.total,
          active: counts.active, archived: counts.archived, projects: projectCount,
        }));
      } else {
        console.log(`Database restored from ${resolved}`);
        console.log(`  Memories: ${counts.total} (${counts.active} active, ${counts.archived} archived)`);
        console.log(`  Projects: ${projectCount}`);
      }
      db.close();
    } catch (err) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } else {
        console.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
      }
      process.exit(1);
    }
  });

// ─── gnosys migrate-db ──────────────────────────────────────────────────
program
  .command("migrate-db")
  .description("Legacy data migration. Use --to-central to move per-project stores into the central DB.")
  .option("--to-central", "Migrate all discovered per-project stores into ~/.gnosys/gnosys.db")
  .option("-v, --verbose", "Verbose output")
  .action(async (opts: { toCentral?: boolean; verbose?: boolean }) => {
    if (!opts.toCentral) {
      // Legacy v1→v2 migration (existing behavior)
      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget();
      if (!writeTarget) {
        console.error("No writable store found. Run 'gnosys init' first.");
        process.exit(1);
      }
      const { migrate, formatMigrationReport } = await import("./lib/migrate.js");
      const stats = await migrate(writeTarget.store.getStorePath(), { verbose: opts.verbose });
      console.log(formatMigrationReport(stats));
      return;
    }

    // v3.0: Migrate per-project stores into central DB
    console.log("Migrating per-project stores to central DB (~/.gnosys/gnosys.db)...\n");

    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }
    } catch (err) {
      console.error(`Cannot open central DB: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // Discover all registered project stores
    const resolver = await getResolver();
    const detectedStores = await resolver.detectAllStores();
    const projectDirs = detectedStores
      .filter(s => s.hasGnosys)
      .map(s => s.path);

    if (projectDirs.length === 0) {
      console.log("No per-project stores found to migrate.");
      centralDb.close();
      return;
    }

    console.log(`Found ${projectDirs.length} project store(s) to migrate:\n`);

    let totalMemories = 0;
    let totalProjects = 0;

    for (const projectDir of projectDirs) {
      const storePath = path.join(projectDir, ".gnosys");
      const log = opts.verbose ? console.log : () => {};

      try {
        // Create project identity if it doesn't exist
        const identity = await createProjectIdentity(projectDir, {
          centralDb: centralDb!,
        });

        log(`  [${identity.projectName}] ID: ${identity.projectId}`);

        // Open per-project DB and import memories
        const projectDb = new GnosysDB(storePath);
        if (!projectDb.isAvailable() || !projectDb.isMigrated()) {
          log(`  [${identity.projectName}] No migrated gnosys.db — skipping`);
          continue;
        }

        const memories = projectDb.getAllMemories();
        let count = 0;
        centralDb!.transaction(() => {
          for (const mem of memories) {
            centralDb!.insertMemory({
              ...mem,
              project_id: identity.projectId,
              scope: "project",
            });
            count++;
          }
        });

        projectDb.close();
        totalMemories += count;
        totalProjects++;
        console.log(`  ✓ ${identity.projectName}: ${count} memories migrated`);
      } catch (err) {
        console.error(`  ✗ ${projectDir}: ${err instanceof Error ? err.message : err}`);
      }
    }

    centralDb!.close();

    console.log(`\n╔════════════════════════════════════════╗`);
    console.log(`║  Central Migration Complete            ║`);
    console.log(`╚════════════════════════════════════════╝`);
    console.log(`  Projects migrated: ${totalProjects}`);
    console.log(`  Memories imported:  ${totalMemories}`);
    console.log(`\n  Per-project gnosys.db files are untouched.`);
    console.log(`  Central DB: ${GnosysDB.getCentralDbPath()}`);
  });

// ─── gnosys projects ────────────────────────────────────────────────────
/**
 * Returns true if a project's working directory no longer exists on disk.
 * Used by `gnosys projects` to filter dead entries by default and by
 * `gnosys projects --prune` to delete them. We deliberately do NOT pattern-
 * match on tmp paths — active test fixtures live in /var/folders/ and
 * /tmp/ and we want them visible while they're in use.
 */
function isDeadProjectDir(dir: string): boolean {
  return !existsSync(dir);
}

program
  .command("connect")
  .description("Point an IDE at a remote gnosys server (central-server topology) instead of spawning a local one")
  .requiredOption("--url <url>", "Remote MCP URL, e.g. http://studio.tailnet.ts.net:7777/mcp")
  .option("--token <token>", "Bearer token if the server requires auth")
  .option("--ide <ide>", "IDE config to write: cursor | claude-desktop", "cursor")
  .option("--dir <dir>", "Project dir for cursor config (default: cwd)")
  .option("--print", "Print the config snippet instead of writing files")
  .action(async (opts: { url: string; token?: string; ide?: string; dir?: string; print?: boolean }) => {
    const m = await import("./lib/mcpClientConfig.js");
    const remote = { url: opts.url, token: opts.token };
    if (opts.print) {
      console.log(JSON.stringify({ mcpServers: { gnosys: m.remoteMcpEntry(remote) } }, null, 2));
      return;
    }
    const ide: "cursor" | "claude-desktop" = opts.ide === "claude-desktop" ? "claude-desktop" : "cursor";
    try {
      const file = await m.writeRemoteClientConfig(ide, opts.dir || process.cwd(), remote);
      console.log(`✓ Pointed ${ide} at ${opts.url}`);
      console.log(`  wrote: ${file}${opts.token ? "  (bearer token included)" : ""}`);
      console.log("  Restart the IDE / MCP servers to pick it up.");
    } catch (e) {
      console.error(`connect failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  });

program
  .command("centralize")
  .description("Copy this machine's local brain (~/.gnosys/gnosys.db) to seed a central server — a Docker volume or another host")
  .requiredOption("--to <dir>", "Target directory to write gnosys.db into (e.g. a mounted volume)")
  .option("--from-local", "Source is this machine's local brain (default)")
  .option("--force", "Overwrite an existing gnosys.db at the target")
  .action(async (opts: { to: string; force?: boolean }) => {
    const { centralizeDb } = await import("./lib/centralize.js");
    try {
      const r = await centralizeDb({ to: opts.to, force: opts.force });
      const mb = (r.bytes / 1024 / 1024).toFixed(1);
      console.log("✓ Seeded central brain:");
      console.log(`  from: ${r.source}`);
      console.log(`  to:   ${r.target} (${mb} MB)`);
      console.log("");
      console.log(`Run the server against it with GNOSYS_HOME=${opts.to}, or mount this dir as the container's /data volume.`);
    } catch (e) {
      console.error(`centralize failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  });

const machineCmd = program
  .command("machine")
  .description("Manage this machine's local config (machine.json: machineId, roots, remote)");

machineCmd
  .command("show")
  .description("Show this machine's machine.json")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { readMachineConfig } = await import("./lib/machineConfig.js");
    const { getMachineConfigPath } = await import("./lib/paths.js");
    const cfg = readMachineConfig();
    if (!cfg) {
      console.log(`No machine.json yet (${getMachineConfigPath()}).`);
      console.log("Run 'gnosys machine migrate' (existing setup) or 'gnosys scan' to create it.");
      return;
    }
    outputResult(!!opts.json, cfg, () => {
      console.log(`machine.json: ${getMachineConfigPath()}`);
      console.log(`  machineId: ${cfg.machineId}`);
      console.log(`  hostname:  ${cfg.hostname}`);
      console.log(`  roots:     ${JSON.stringify(cfg.roots)}`);
      console.log(`  remote:    ${cfg.remote.enabled ? (cfg.remote.path ?? "(enabled, no path)") : "(disabled)"}`);
    });
  });

machineCmd
  .command("migrate")
  .description("Move machine-local config (machineId, remote) out of the synced DB into machine.json, set roots, and scan")
  .option("--root <dir>", "Set the 'dev' root for this machine (default: derived from the registry)")
  .option("--no-scan", "Skip the project scan after migrating")
  .action(async (opts: { root?: string; scan?: boolean }) => {
    const { migrateMachine } = await import("./lib/machineMigrate.js");
    const { getMachineConfigPath } = await import("./lib/paths.js");
    const db = GnosysDB.openLocal();
    if (!db.isAvailable()) {
      console.error("Central DB not available (better-sqlite3 missing).");
      process.exit(1);
    }
    const res = await migrateMachine(db, { root: opts.root, scan: opts.scan });
    db.close();

    console.log(`✓ machine.json written: ${getMachineConfigPath()}`);
    const idNote = res.adoptedMachineId
      ? " (adopted from synced meta)"
      : res.regeneratedMachineId ? " (regenerated)" : "";
    console.log(`  machineId: ${res.machineId}${idNote}`);
    if (res.adoptedRemotePath) {
      console.log("  remote: adopted remote_path from synced meta (removed from shared DB)");
    }
    console.log(`  roots: ${JSON.stringify(res.rootsConfigured)}`);
    if (res.scan) {
      console.log(`  scanned ${res.scan.entries.length} project(s):`);
      for (const e of res.scan.entries) console.log(`    ${e.name}  [${e.mode}]  ${e.absPath}`);
    } else {
      console.log("  (scan skipped — set a root in machine.json, then run 'gnosys scan')");
    }
  });

program
  .command("scan")
  .description("Discover projects under this machine's roots (machine.json) and record their machine-portable locations")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { ensureMachineConfig } = await import("./lib/machineConfig.js");
    const { getMachineConfigPath } = await import("./lib/paths.js");
    const { scanProjects } = await import("./lib/projectScan.js");

    const ens = ensureMachineConfig();
    const machine = ens.config;
    if (Object.keys(machine.roots).length === 0) {
      console.error("No project roots configured for this machine.");
      console.error(`Add roots to ${getMachineConfigPath()}, e.g.`);
      console.error('  { "roots": { "dev": "/Users/edward/MSDev/projects" } }');
      process.exit(1);
    }

    const db = GnosysDB.openCentral();
    if (!db.isAvailable()) {
      console.error("Central DB not available (better-sqlite3 missing).");
      process.exit(1);
    }
    const result = await scanProjects(db, machine);
    db.close();

    outputResult(!!opts.json, {
      machineId: machine.machineId,
      roots: result.roots,
      count: result.entries.length,
      entries: result.entries,
    }, () => {
      if (ens.regenerated) {
        console.log("⚠ machine.json hostname mismatch — regenerated machineId for this machine.\n");
      }
      console.log(`Scanned ${result.roots.length} root(s); registered ${result.entries.length} project(s):`);
      for (const e of result.entries) {
        console.log(`  ${e.name}  [${e.mode}]  ${e.absPath}`);
      }
    });
  });

program
  .command("projects")
  .description("List registered projects from the central DB")
  .option("--json", "Output as JSON")
  .option("--all", "Include dead projects (deleted directories)")
  .option("--prune", "Delete registry entries whose directory no longer exists (interactive by default)")
  .option("--dry-run", "With --prune: list what would be deleted, don't actually delete")
  .option("--yes", "With --prune: skip the confirmation prompt (scripting/automation)")
  .action(async (opts: { json?: boolean; all?: boolean; prune?: boolean; dryRun?: boolean; yes?: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      const allProjects = centralDb.getAllProjects();

      // v5.11: resolve each project's path for THIS machine (machine.json),
      // falling back to working_directory when machine.json is absent.
      const { readMachineConfig } = await import("./lib/machineConfig.js");
      const { effectiveProjectPath } = await import("./lib/projectPaths.js");
      const machine = readMachineConfig();
      const resolvedDirOf = (p: typeof allProjects[number]): string | null =>
        effectiveProjectPath(centralDb!, p, machine);
      const isNotHere = (p: typeof allProjects[number]): boolean => {
        const ep = resolvedDirOf(p);
        return ep === null || !existsSync(ep);
      };

      if (opts.prune) {
        // Find dead projects first — never just delete without showing
        // them. v5.7.0 adds confirmation by default; --yes skips for
        // scripted use; --dry-run shows the list without deleting.
        const deadProjects = allProjects.filter((p) => isDeadProjectDir(p.working_directory));

        if (deadProjects.length === 0) {
          console.log("No dead projects to prune.");
          return;
        }

        const DIM = "\x1b[2m";
        const RESET = "\x1b[0m";

        // Always show what would be removed first.
        console.log(`Found ${deadProjects.length} dead project(s):\n`);
        for (const p of deadProjects) {
          const memCount = centralDb.getMemoriesByProject(p.id, true).length;
          console.log(`  ${p.name}  ${DIM}${p.working_directory}${RESET}  (${memCount} memorie(s))`);
        }
        console.log();

        if (opts.dryRun) {
          console.log("[dry-run] No changes made. Re-run without --dry-run to delete.");
          return;
        }

        if (!opts.yes) {
          const readline = await import("readline/promises");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = (await rl.question(`Delete these ${deadProjects.length} project registry entries? [y/N] `)).trim().toLowerCase();
          rl.close();
          if (answer !== "y" && answer !== "yes") {
            console.log("Cancelled.");
            return;
          }
        }

        for (const p of deadProjects) {
          centralDb.deleteProject(p.id);
        }

        outputResult(!!opts.json, {
          deleted: deadProjects.length,
          remaining: allProjects.length - deadProjects.length,
          deletedProjects: deadProjects.map((p) => ({ id: p.id, name: p.name, directory: p.working_directory })),
        }, () => {
          console.log(`✓ Pruned ${deadProjects.length} project(s). ${allProjects.length - deadProjects.length} remain.`);
        });
        return;
      }

      // Normal listing — filter dead / not-on-this-machine projects by default
      const visibleProjects = opts.all
        ? allProjects
        : allProjects.filter((p) => !isNotHere(p));

      if (visibleProjects.length === 0) {
        const deadCount = allProjects.length;
        outputResult(!!opts.json, {
          count: 0,
          totalRegistered: deadCount,
          deadCount,
          projects: [],
        }, () => {
          if (deadCount === 0) {
            console.log("No projects registered. Run 'gnosys init' in a project directory.");
          } else {
            console.log(`No live projects (${deadCount} dead — run 'gnosys projects --all' to see them or 'gnosys projects --prune' to remove them).`);
          }
        });
        centralDb.close();
        return;
      }

      const projectData = visibleProjects.map((p) => ({
        ...p,
        resolvedDir: resolvedDirOf(p) ?? "(not on this machine)",
        memoryCount: centralDb!.getMemoriesByProject(p.id).length,
      }));

      const deadCount = allProjects.length - visibleProjects.length;

      outputResult(!!opts.json, {
        count: visibleProjects.length,
        totalRegistered: allProjects.length,
        deadCount,
        projects: projectData,
      }, () => {
        const header = deadCount > 0 && !opts.all
          ? `${visibleProjects.length} live project(s) (${deadCount} dead hidden — use --all or --prune):\n`
          : `${visibleProjects.length} registered project(s):\n`;
        console.log(header);
        for (const p of projectData) {
          console.log(`  ${p.name}`);
          console.log(`    ID:        ${p.id}`);
          console.log(`    Directory: ${p.resolvedDir}`);
          console.log(`    Memories:  ${p.memoryCount}`);
          console.log(`    Created:   ${p.created}`);
          console.log();
        }
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys pref ─────────────────────────────────────────────────────────
const prefCmd = program
  .command("pref")
  .description(
    "User preferences — small key-value memories scoped to you (not a project), surfaced into every agent's context. Use for cross-project conventions like 'prefer simple solutions' or 'no emoji in UI'. Subcommands: set, get, delete. Review/clean up with `gnosys setup preferences`.",
  );

prefCmd
  .command("set <key> <value>")
  .description("Set a user preference. Key should be kebab-case (e.g. 'commit-convention').")
  .option("-t, --title <title>", "Human-readable title")
  .option("--tags <tags>", "Comma-separated tags")
  .action(async (key: string, value: string, opts: { title?: string; tags?: string }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      if (!(KNOWN_PREFERENCE_KEYS as readonly string[]).includes(key)) {
        const suggestion = suggestPreferenceKey(key);
        if (suggestion) {
          console.error(`Unknown preference key \`${key}\` — did you mean \`${suggestion}\`?`);
          process.exit(1);
        }
      }

      const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()) : undefined;
      const pref = setPreference(centralDb, key, value, { title: opts.title, tags });
      console.log(`Preference set: ${pref.title}`);
      console.log(`  Key:   ${pref.key}`);
      console.log(`  Value: ${pref.value}`);
      console.log(`\nRun 'gnosys sync' to update agent rules files.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

prefCmd
  .command("get [key]")
  .description("Get a preference by key, or list all preferences if no key given.")
  .option("--json", "Output as JSON")
  .action(async (key: string | undefined, opts: { json?: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      if (key) {
        const pref = getPreference(centralDb, key);
        if (!pref) {
          console.log(`No preference found for key "${key}".`);
          return;
        }
        outputResult(!!opts.json, pref, () => {
          console.log(`${pref.title} (${pref.key})\n`);
          console.log(pref.value);
          console.log(`\nConfidence: ${pref.confidence}`);
          console.log(`Modified: ${pref.modified}`);
        });
      } else {
        const prefs = getAllPreferences(centralDb);
        if (prefs.length === 0) {
          outputResult(!!opts.json, { preferences: [] }, () => {
            console.log("No preferences set. Use 'gnosys pref set <key> <value>' to add some.");
          });
          return;
        }
        outputResult(!!opts.json, { count: prefs.length, preferences: prefs }, () => {
          console.log(`${prefs.length} user preference(s):\n`);
          for (const p of prefs) {
            console.log(`  ${p.title} (${p.key})`);
            console.log(`    ${p.value.split("\n")[0]}`);
            console.log();
          }
        });
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

prefCmd
  .command("delete <key>")
  .description("Delete a user preference.")
  .action(async (key: string) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      const deleted = deletePreference(centralDb, key);
      if (!deleted) {
        console.log(`No preference found for key "${key}".`);
        return;
      }
      console.log(`Preference "${key}" deleted.`);
      console.log(`Run 'gnosys sync' to update agent rules files.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys sync ─────────────────────────────────────────────────────────
program
  .command("sync")
  .description("Regenerate agent rules files from user preferences and project conventions. Injects GNOSYS:START/GNOSYS:END block.")
  .option("-d, --directory <dir>", "Project directory (default: cwd)")
  .option("-t, --target <target>", "Target: claude, cursor, codex, all, or global (default: auto-detect)")
  .option("--global", "Sync to global ~/.claude/CLAUDE.md")
  .action(async (opts: { directory?: string; target?: string; global?: boolean }) => {
    const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();
    const target = opts.global ? "global" : (opts.target || null);

    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) {
        console.error("Central DB not available (better-sqlite3 missing).");
        process.exit(1);
      }

      // For --global, we don't need project identity
      if (target === "global") {
        const results = await syncToTarget(centralDb, projectDir, "global", null);
        for (const result of results) {
          const action = result.created ? "Created" : "Updated";
          console.log(`${action} global rules: ${result.filePath}`);
          console.log(`  Preferences injected: ${result.prefCount}`);
        }
        console.log(`\nContent is inside <!-- GNOSYS:START --> / <!-- GNOSYS:END --> markers.`);
        console.log(`User content outside these markers is preserved.`);
        return;
      }

      // Read project identity
      const identity = await readProjectIdentity(projectDir);
      if (!identity) {
        console.error("No project identity found. Run 'gnosys init' first.");
        process.exit(1);
      }

      // Use explicit target, or fall back to auto-detected, or "all"
      const resolvedTarget = target || identity.agentRulesTarget || "all";

      const results = await syncToTarget(
        centralDb,
        projectDir,
        resolvedTarget,
        identity.projectId
      );

      if (results.length === 0) {
        console.error("No targets found. Create a CLAUDE.md, .cursor/, or .codex/ directory first.");
        process.exit(1);
      }

      for (const result of results) {
        const action = result.created ? "Created" : "Updated";
        console.log(`${action} rules file: ${result.filePath}`);
        console.log(`  Preferences injected: ${result.prefCount}`);
        console.log(`  Project conventions:  ${result.conventionCount}`);
      }
      console.log(`\nContent is inside <!-- GNOSYS:START --> / <!-- GNOSYS:END --> markers.`);
      console.log(`User content outside these markers is preserved.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys fsearch (federated search) ───────────────────────────────────
program
  .command("fsearch <query>")
  .description("Federated search across all scopes with tier boosting (project > user > global)")
  .option("-l, --limit <n>", "Max results", "20")
  .option("-d, --directory <dir>", "Project directory for context")
  .option("--no-global", "Exclude global-scope memories")
  .option("--scope <scope>", "Filter by scope: project, user, global (comma-separated)")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: { limit: string; directory?: string; global: boolean; scope?: string; json: boolean }) => {
    const { runFsearchCommand } = await import("./lib/fsearchCommand.js");
    await runFsearchCommand(query, opts);
  });

// ─── gnosys ambiguity ────────────────────────────────────────────────────
program
  .command("ambiguity <query>")
  .description("Check if a query matches memories in multiple projects")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: { json: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const { detectAmbiguity } = await import("./lib/federated.js");
      const ambiguity = detectAmbiguity(centralDb, query);

      if (opts.json) {
        console.log(JSON.stringify({ query, ambiguous: !!ambiguity, ...(ambiguity || {}) }, null, 2));
      } else if (!ambiguity) {
        console.log(`No ambiguity for "${query}" — matches at most one project.`);
      } else {
        console.log(ambiguity.message);
        for (const c of ambiguity.candidates) {
          console.log(`\n  ${c.projectName} (${c.projectId})`);
          console.log(`    Dir: ${c.workingDirectory}`);
          console.log(`    Matching memories: ${c.memoryCount}`);
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys briefing ─────────────────────────────────────────────────────
program
  .command("briefing [projectNameOrId]")
  .description("Generate project briefing — memory state summary, categories, recent activity, top tags")
  .option("-p, --project <id>", "Project ID (auto-detects if omitted)")
  .option("-a, --all", "Generate briefings for all projects")
  .option("-d, --directory <dir>", "Project directory for auto-detection")
  .option("--json", "Output as JSON")
  .action(async (projectNameOrId: string | undefined, opts: { project?: string; all?: boolean; directory?: string; json: boolean }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const { generateBriefing, generateAllBriefings, detectCurrentProject } = await import("./lib/federated.js");

      if (opts.all) {
        const briefings = generateAllBriefings(centralDb);
        if (opts.json) {
          console.log(JSON.stringify({ count: briefings.length, briefings }, null, 2));
        } else {
          if (briefings.length === 0) { console.log("No projects registered."); return; }
          for (const b of briefings) {
            console.log(`\n## ${b.projectName}`);
            console.log(b.summary);
          }
        }
        return;
      }

      // v5.7.0: accept project name as positional argument in addition to --project <id>.
      // Resolution order: positional name → --project flag → cwd auto-detect.
      let pid = opts.project ?? null;
      if (!pid && projectNameOrId) {
        // Try as exact ID first, then by name lookup.
        const byId = centralDb.getProject(projectNameOrId);
        if (byId) {
          pid = byId.id;
        } else {
          const all = centralDb.getAllProjects();
          const byName = all.find((p) => p.name === projectNameOrId);
          if (byName) pid = byName.id;
        }
        if (!pid) {
          console.error(`Project not found: "${projectNameOrId}". Run 'gnosys projects' to list registered projects.`);
          process.exit(1);
        }
      }
      if (!pid) pid = await detectCurrentProject(centralDb, opts.directory || undefined);
      if (!pid) { console.error("No project specified and none detected."); process.exit(1); }

      const briefing = generateBriefing(centralDb, pid);
      if (!briefing) { console.error(`Project not found: ${pid}`); process.exit(1); }

      if (opts.json) {
        console.log(JSON.stringify(briefing, null, 2));
      } else {
        console.log(`# Briefing: ${briefing.projectName}`);
        console.log(`Directory: ${briefing.workingDirectory}`);
        console.log(`Active memories: ${briefing.activeMemories} / ${briefing.totalMemories}`);
        console.log(`\nCategories:`);
        for (const [cat, count] of Object.entries(briefing.categories).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${cat}: ${count}`);
        }
        console.log(`\nRecent activity (7d):`);
        if (briefing.recentActivity.length === 0) { console.log("  None"); }
        for (const r of briefing.recentActivity) {
          console.log(`  - ${r.title} (${r.modified})`);
        }
        console.log(`\nTop tags: ${briefing.topTags.slice(0, 10).map((t) => `${t.tag}(${t.count})`).join(", ") || "None"}`);
        console.log(`\n${briefing.summary}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// `gnosys portfolio` was removed in v5.7.1.
// Use `gnosys status --projects` (formerly --global) for the projects
// overview, or `gnosys status --web` for the HTML dashboard, or
// `gnosys status --projects --output file.html` to write to disk.

// ─── gnosys status ──────────────────────────────────────────────────────
// v5.7.1 (#11): the catch-all status command. Section flags select what to
// show; output flags control format. Default (no flag) is the current
// project. `dashboard` and `portfolio` were removed in v5.7.1 — their
// content lives under `--system` and `--projects` respectively.
program
  .command("status")
  .description("Show status. Sections: --projects (all projects) · --remote (sync) · --system (memory/LLM health) · default: current project. Output: --web · --json. Note: 'gnosys dashboard' and 'gnosys portfolio' were removed in v5.7.1 — use 'gnosys status --system' and 'gnosys status --projects' instead.")
  .option("-d, --directory <dir>", "Project directory (auto-detects if omitted)")
  .option("-p, --project <id>", "Project ID")
  .option("-g, --global", "(deprecated alias for --projects)")
  .option("--projects", "Show all projects portfolio (replaces the old 'gnosys portfolio')")
  .option("-r, --remote", "Show remote sync status (alias for 'gnosys setup remote status')")
  .option("-w, --web", "Open the HTML dashboard in the browser")
  .option("-s, --system", "Show system health (memory count, LLM connectivity, embeddings, archive)")
  .option("--json", "Output as JSON")
  .action(async (opts: { directory?: string; project?: string; global?: boolean; projects?: boolean; remote?: boolean; web?: boolean; system?: boolean; json: boolean }) => {
    // v5.7.1: --projects supersedes --global (kept as alias).
    if (opts.projects) opts.global = true;

    // v5.7.1: --remote — dispatch to RemoteSync.getStatus()
    if (opts.remote) {
      let remoteCentralDb: GnosysDB | null = null;
      try {
        remoteCentralDb = GnosysDB.openLocal();
        if (!remoteCentralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }
        const remotePath = remoteCentralDb.getMeta("remote_path");
        if (!remotePath) {
          if (opts.json) {
            console.log(JSON.stringify({ configured: false, message: "Remote not configured. Run 'gnosys setup remote'." }, null, 2));
          } else {
            console.log("Remote sync: not configured. Run 'gnosys setup remote' to set up multi-machine sync.");
          }
          return;
        }
        const { RemoteSync, formatStatus } = await import("./lib/remote.js");
        const { withHeartbeat } = await import("./lib/heartbeat.js");
        const sync = new RemoteSync(remoteCentralDb, remotePath);
        const status = await withHeartbeat("Checking remote sync status", () => sync.getStatus());
        sync.closeRemote();
        if (opts.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(formatStatus(status));
        }
        return;
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        remoteCentralDb?.close();
      }
    }
    // --system delegates to the dashboard formatter (formerly `gnosys dashboard`).
    if (opts.system) {
      const { collectDashboardData, formatDashboard, formatDashboardJSON } = await import("./lib/dashboard.js");
      const resolver = await getResolver();
      const stores = resolver.getStores();
      if (stores.length === 0) {
        console.error("No Gnosys stores found. Run gnosys init first.");
        process.exit(1);
      }
      const cfg = await loadConfig(stores[0].path);
      let dashDb: import("./lib/db.js").GnosysDB | undefined;
      try {
        const db = GnosysDB.openCentral();
        if (db.isAvailable() && db.isMigrated()) dashDb = db;
      } catch { /* non-fatal */ }
      const data = await collectDashboardData(resolver, cfg, pkg.version, dashDb);
      console.log(opts.json ? formatDashboardJSON(data) : formatDashboard(data));
      return;
    }

    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const { detectCurrentProject } = await import("./lib/federated.js");
      const { generatePortfolio, formatPortfolioMarkdown } = await import("./lib/portfolio.js");

      const report = generatePortfolio(centralDb);

      // --web: regenerate HTML dashboard and open it
      if (opts.web) {
        const { generatePortfolioHtml } = await import("./lib/portfolioHtml.js");
        const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
        const dashboardPath = path.join(home, "gnosys-dashboard.html");
        const { writeFileSync } = await import("fs");
        writeFileSync(dashboardPath, generatePortfolioHtml(report, dashboardPath), "utf-8");
        const { execFile } = await import("child_process");
        execFile("open", [dashboardPath]);
        console.log(`Dashboard opened: ${dashboardPath}`);
        return;
      }

      // --global: show all projects
      if (opts.global) {
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        console.log(`\n  Portfolio — ${report.totalProjects} projects, ${report.totalMemories} memories\n`);

        // Action items summary
        if (report.allActionItems.length > 0) {
          console.log(`  \x1b[31mACTION ITEMS (${report.allActionItems.length}):\x1b[0m`);
          for (const a of report.allActionItems.slice(0, 8)) {
            const icon = a.type === "question" ? "?" : a.type === "blocker" ? "!" : a.type === "manual" ? ">" : "*";
            console.log(`    [${icon}] ${a.projectName}: ${a.text.slice(0, 80)}`);
          }
          if (report.allActionItems.length > 8) console.log(`    ... and ${report.allActionItems.length - 8} more`);
          console.log("");
        }

        // Per-project summary
        for (const snap of report.projects) {
          const r = snap.readiness;
          const color = r.score >= 90 ? "\x1b[32m" : r.score >= 65 ? "\x1b[34m" : r.score >= 40 ? "\x1b[33m" : "\x1b[31m";
          const reset = "\x1b[0m";
          const blockers = snap.actionItems.length + r.blocking.length;
          const blockerStr = blockers > 0 ? ` — \x1b[31m${blockers} blocker${blockers !== 1 ? "s" : ""}\x1b[0m` : "";
          console.log(`  ${color}${String(r.score).padStart(3)}%${reset} ${r.label.padEnd(12)} ${snap.project.name}${blockerStr}`);
        }

        console.log(`\n  Run 'gnosys status --web' to open the visual dashboard.`);
        return;
      }

      // Single project (default): auto-detect from cwd
      let pid = opts.project || null;
      if (!pid) pid = await detectCurrentProject(centralDb, opts.directory || undefined);
      if (!pid) { console.error("No project detected. Run from a project directory, use --project, or use --global for all."); process.exit(1); }

      const project = centralDb.getProject(pid);
      if (!project) { console.error(`Project not found: ${pid}`); process.exit(1); }

      const snap = report.projects.find((s) => s.project.id === pid);

      if (!snap) {
        console.error(`No memories found for project: ${project.name}`);
        console.log(`\nRun 'gnosys update-status' to create a status snapshot.`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          project: project.name,
          readiness: snap.readiness,
          actionItems: snap.actionItems,
          memoryCounts: snap.memoryCounts,
          latestStatus: snap.latestStatus ? { id: snap.latestStatus.id, title: snap.latestStatus.title, modified: snap.latestStatus.modified } : null,
        }, null, 2));
        return;
      }

      // Formatted output
      const r = snap.readiness;
      const color = r.score >= 90 ? "\x1b[32m" : r.score >= 65 ? "\x1b[34m" : r.score >= 40 ? "\x1b[33m" : "\x1b[31m";
      const reset = "\x1b[0m";

      console.log(`\n  ${project.name} — ${color}${r.label} (${r.score}%)${reset}`);
      console.log(`  ${snap.memoryCounts.total} memories across ${Object.keys(snap.memoryCounts.byCategory).length} categories\n`);

      if (snap.latestStatus) {
        const age = Math.floor((Date.now() - new Date(snap.latestStatus.modified).getTime()) / (1000 * 60 * 60 * 24));
        const stale = age > 7 ? ` \x1b[33m(${age}d old — consider running 'gnosys update-status')\x1b[0m` : ` (${age}d ago)`;
        console.log(`  Last status: ${snap.latestStatus.title}${stale}\n`);
      } else {
        console.log(`  \x1b[33mNo status snapshot found. Run 'gnosys update-status' to create one.\x1b[0m\n`);
      }

      // Action items
      if (snap.actionItems.length > 0) {
        console.log(`  ACTION ITEMS (${snap.actionItems.length}):`);
        for (const a of snap.actionItems) {
          const icon = a.type === "question" ? "?" : a.type === "blocker" ? "!" : a.type === "manual" ? ">" : "*";
          console.log(`    [${icon}] ${a.text}`);
        }
        console.log("");
      }

      // Blocking
      if (r.blocking.length > 0) {
        console.log(`  BLOCKING GO-LIVE (${r.blocking.length}):`);
        for (const b of r.blocking.slice(0, 10)) {
          console.log(`    - ${b}`);
        }
        if (r.blocking.length > 10) console.log(`    ... and ${r.blocking.length - 10} more`);
        console.log("");
      }

      // Done summary
      if (r.done.length > 0) {
        console.log(`  COMPLETED (${r.done.length} items)`);
        for (const d of r.done.slice(0, 5)) {
          console.log(`    + ${d}`);
        }
        if (r.done.length > 5) console.log(`    ... and ${r.done.length - 5} more`);
        console.log("");
      }

      // Suggest update if no status or stale
      if (!snap.latestStatus) {
        console.log(`  Tip: Run 'gnosys update-status' to generate a status snapshot.`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys update-status ────────────────────────────────────────────────
program
  .command("update-status")
  .description("Show the prompt to give an AI agent to update this project's status for the portfolio dashboard")
  .option("-d, --directory <dir>", "Project directory (auto-detects if omitted)")
  .option("-p, --project <id>", "Project ID")
  .action(async (opts: { directory?: string; project?: string }) => {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }

      const { detectCurrentProject } = await import("./lib/federated.js");
      const { generateStatusPrompt } = await import("./lib/portfolio.js");

      let pid = opts.project || null;
      if (!pid) pid = await detectCurrentProject(centralDb, opts.directory || undefined);
      if (!pid) { console.error("No project specified and none detected."); process.exit(1); }

      const project = centralDb.getProject(pid);
      if (!project) { console.error(`Project not found: ${pid}`); process.exit(1); }

      const prompt = generateStatusPrompt(project.name, project.working_directory);
      console.log(prompt);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    } finally {
      centralDb?.close();
    }
  });

// ─── gnosys working-set ──────────────────────────────────────────────────
program
  .command("working-set")
  .description("Show the implicit working set — recently modified memories for the current project")
  .option("-d, --directory <dir>", "Project directory")
  .option("-w, --window <hours>", "Lookback window in hours", "24")
  .option("--json", "Output as JSON")
  .action(async (opts: { directory?: string; window: string; json: boolean }) => {
    const { runWorkingSetCommand } = await import("./lib/workingSetCommand.js");
    await runWorkingSetCommand(opts);
  });

// ─── gnosys sandbox start|stop|status ─────────────────────────────────────

const sandboxCmd = program
  .command("sandbox")
  .description(
    "Manage the Gnosys sandbox — a long-lived background process that holds the SQLite handle so agents can call gnosys.add()/recall() through a tiny helper library instead of paying the MCP roundtrip on every call. Lower latency, lower context cost. Most users don't need this; it's for high-throughput agent workflows.",
  );

sandboxCmd
  .command("start")
  .description("Start the Gnosys sandbox background process")
  .option("--persistent", "Keep running across reboots (future use)")
  .option("--db-path <path>", "Custom database directory")
  .option("--json", "Output as JSON")
  .action(async (opts: { persistent?: boolean; dbPath?: string; json?: boolean }) => {
    const { runSandboxStartCommand } = await import("./lib/sandboxStartCommand.js");
    await runSandboxStartCommand(opts);
  });

sandboxCmd
  .command("stop")
  .description("Stop the Gnosys sandbox background process")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { runSandboxStopCommand } = await import("./lib/sandboxStopCommand.js");
    await runSandboxStopCommand(opts);
  });

sandboxCmd
  .command("status")
  .description("Check if the Gnosys sandbox is running")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { runSandboxStatusCommand } = await import("./lib/sandboxStatusCommand.js");
    await runSandboxStatusCommand(opts);
  });

// ─── gnosys helper generate ───────────────────────────────────────────────

const helperCmd = program
  .command("helper")
  .description(
    "Generate a tiny TypeScript helper library that agents import to talk to the gnosys sandbox directly. Pairs with `gnosys sandbox start` — agents call gnosys.add()/recall() like normal code instead of issuing MCP tool calls. Run `gnosys helper generate` in your agent's project to drop in `gnosys-helper.ts`.",
  );

helperCmd
  .command("generate")
  .description("Generate a gnosys-helper.ts file in the current directory (or specified directory)")
  .option("-d, --directory <dir>", "Target directory (default: cwd)")
  .option("--json", "Output as JSON")
  .action(async (opts: { directory?: string; json?: boolean }) => {
    const { runHelperGenerateCommand } = await import("./lib/helperGenerateCommand.js");
    await runHelperGenerateCommand(opts);
  });

// ─── Phase 10: gnosys trace ─────────────────────────────────────────────

program
  .command("trace <directory>")
  .description("Trace a codebase and store procedural 'how' memories with call-chain relationships")
  .option("--max-files <n>", "Maximum number of source files to scan", "500")
  .option("--project-id <id>", "Project ID to associate memories with")
  .option("--json", "Output as JSON")
  .action(async (directory: string, opts: { maxFiles?: string; projectId?: string; json?: boolean }) => {
    const { runTraceCommand } = await import("./lib/traceCommand.js");
    await runTraceCommand(directory, opts);
  });

// ─── Phase 10: gnosys reflect ───────────────────────────────────────────

program
  .command("reflect <outcome>")
  .description("Reflect on an outcome to update memory confidence and create relationships")
  .option("--memory-ids <ids>", "Comma-separated list of memory IDs to relate to")
  .option("--failure", "Mark this as a failure (default: success)")
  .option("--notes <text>", "Additional notes about the outcome")
  .option("--confidence-delta <n>", "Custom confidence delta (e.g. 0.1 or -0.2)")
  .option("--json", "Output as JSON")
  .action(async (outcome: string, opts: { memoryIds?: string; failure?: boolean; notes?: string; confidenceDelta?: string; json?: boolean }) => {
    const { runReflectCommand } = await import("./lib/reflectCommand.js");
    await runReflectCommand(outcome, opts);
  });

// ─── Phase 10: gnosys traverse ──────────────────────────────────────────

program
  .command("traverse <memoryId>")
  .description("Traverse relationship chains starting from a memory (BFS, depth-limited)")
  .option("-d, --depth <n>", "Maximum traversal depth (default: 3, max: 10)", "3")
  .option("--rel-types <types>", "Comma-separated relationship types to follow (e.g. leads_to,requires)")
  .option("--json", "Output as JSON")
  .action(async (memoryId: string, opts: { depth?: string; relTypes?: string; json?: boolean }) => {
    const { runTraverseCommand } = await import("./lib/traverseCommand.js");
    await runTraverseCommand(memoryId, opts);
  });

// ─── gnosys web init|ingest|build-index|build|add|remove|update|status ──

async function getWebStorePath(): Promise<string> {
  const resolver = await getResolver();
  const stores = resolver.getStores();
  return stores.length > 0 ? stores[0].path : path.join(process.cwd(), ".gnosys");
}

const webCmd = program
  .command("web")
  .description("Web Knowledge Base — generate searchable knowledge from websites");

webCmd
  .command("init")
  .description("Interactive setup for web knowledge base")
  .option("--source <type>", "Source type: sitemap, directory, urls", "sitemap")
  .option("--output <dir>", "Output directory for knowledge files", "./knowledge")
  .option("--no-config", "Skip gnosys.json modification")
  .option("--non-interactive", "Skip prompts, use defaults")
  .option("--json", "Output as JSON")
  .action(async (opts: { source: string; output: string; config: boolean; nonInteractive?: boolean; json?: boolean }) => {
    const { runWebInitCommand } = await import("./lib/webInitCommand.js");
    await runWebInitCommand(getWebStorePath, opts);
  });

webCmd
  .command("ingest")
  .description("Crawl the configured source and generate knowledge markdown files")
  .option("--source <url>", "Override sitemap URL or content directory")
  .option("--prune", "Remove orphaned knowledge files")
  .option("--no-llm", "Force structured mode (no LLM)")
  .option("--concurrency <n>", "Parallel processing limit", "3")
  .option("--dry-run", "Show what would change without writing files")
  .option("--verbose", "Print per-page details")
  .option("--json", "Output results as JSON")
  .action(async (opts: { source?: string; prune?: boolean; llm: boolean; concurrency: string; dryRun?: boolean; verbose?: boolean; json?: boolean }) => {
    const { runWebIngestCommand } = await import("./lib/webIngestCommand.js");
    await runWebIngestCommand(getWebStorePath, opts);
  });

webCmd
  .command("build-index")
  .description("Generate search index JSON from the knowledge directory")
  .option("--input <dir>", "Override knowledge directory")
  .option("--output <path>", "Override output file path")
  .option("--no-stop-words", "Disable stop-word filtering")
  .option("--json", "Output index stats as JSON")
  .action(async (opts: { input?: string; output?: string; stopWords: boolean; json?: boolean }) => {
    const { runWebBuildIndexCommand } = await import("./lib/webBuildIndexCommand.js");
    await runWebBuildIndexCommand(getWebStorePath, opts);
  });

webCmd
  .command("build")
  .description("Run ingest + build-index in one shot")
  .option("--source <url>", "Override sitemap URL or content directory")
  .option("--prune", "Remove orphaned knowledge files")
  .option("--no-llm", "Force structured mode (no LLM)")
  .option("--concurrency <n>", "Parallel processing limit", "3")
  .option("--dry-run", "Show what would change without writing files")
  .option("--json", "Output results as JSON")
  .action(async (opts: { source?: string; prune?: boolean; llm: boolean; concurrency: string; dryRun?: boolean; json?: boolean }) => {
    const { runWebBuildCommand } = await import("./lib/webBuildCommand.js");
    await runWebBuildCommand(getWebStorePath, opts);
  });

webCmd
  .command("add <url>")
  .description("Ingest a single URL into the knowledge base")
  .option("--category <name>", "Override category inference")
  .option("--no-llm", "Force structured mode")
  .option("--no-reindex", "Skip index rebuild")
  .option("--json", "Output as JSON")
  .action(async (url: string, opts: { category?: string; llm: boolean; reindex: boolean; json?: boolean }) => {
    const { runWebAddCommand } = await import("./lib/webAddCommand.js");
    await runWebAddCommand(getWebStorePath, url, opts);
  });

webCmd
  .command("remove <filepath>")
  .description("Remove a knowledge file and rebuild the index")
  .option("--json", "Output as JSON")
  .action(async (filepath: string, opts: { json?: boolean }) => {
    const { runWebRemoveCommand } = await import("./lib/webRemoveCommand.js");
    await runWebRemoveCommand(getWebStorePath, filepath, opts);
  });

webCmd
  .command("update <urlOrPath>")
  .description("Re-ingest a URL or refresh a knowledge file, then rebuild the index")
  .option("--no-llm", "Force structured mode (no LLM)")
  .option("--category <name>", "Override category inference")
  .option("--json", "Output as JSON")
  .action(async (urlOrPath: string, opts: { llm: boolean; category?: string; json?: boolean }) => {
    const { runWebUpdateCommand } = await import("./lib/webUpdateCommand.js");
    await runWebUpdateCommand(getWebStorePath, urlOrPath, opts);
  });

webCmd
  .command("status")
  .description("Show the current state of the web knowledge base")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { runWebStatusCommand } = await import("./lib/webStatusCommand.js");
    await runWebStatusCommand(getWebStorePath, opts);
  });

// ─── Post-install upgrade nudge ─────────────────────────────────────────
// v5.8.5: only nudges when the running binary is NEWER than the DB stamp
// (i.e. you just installed a fresh version locally and haven't run
// sync-projects to refresh the stamp yet). The previous version fired on
// any mismatch — including "another machine bumped the stamp ahead of
// you" which is a separate concern handled by the preAction warning.
// Also avoids re-nudging once per command for the same version-pair by
// honoring a per-session env-var sentinel.
//
// v5.9.3 Phase H consolidation lives BELOW this block; Phase F guards us
// from touching the DB at all in tests.
if (!isTestEnv()) {
  try {
    const centralDb = GnosysDB.openCentral();
    if (centralDb.isAvailable()) {
      const lastVersion = centralDb.getMeta("app_version");
      // GNOSYS_FORCE_VERSION lets the upgrade-nag tests pin a synthetic
      // "running" version independent of the real release number, so a .0
      // minor release can't break the patch/minor scenarios. Production
      // always falls through to pkg.version.
      const currentVersion = process.env.GNOSYS_FORCE_VERSION || pkg.version;
      const isUpgradeCmd = process.argv.slice(2).some(a => a === "upgrade");
      const isSetupSyncCmd = process.argv.slice(2).join(" ").includes("setup sync-projects");
      // CRITICAL: `serve` writes JSON-RPC to stdout for MCP transport. Any
      // console.log during boot corrupts the protocol and the host (Grok, Codex,
      // etc.) sees the server as [unavailable]. Suppress the nag in serve mode.
      const isServeCmd = process.argv.slice(2).some(a => a === "serve");
      // v5.9.3 Phase H: fire on any mismatch (upgrade OR downgrade).
      const mismatch =
        lastVersion !== null && lastVersion !== undefined &&
        compareSemver(currentVersion, lastVersion) !== 0;
      if (mismatch && !isUpgradeCmd && !isSetupSyncCmd && !isServeCmd) {
        // v5.9.3 Phase H: emit on STDERR (was stdout). Safer invariant per
        // deci-045 — stdout is reserved for command output.
        const isMajorOrMinor = (() => {
          if (!lastVersion) return false;
          const oldParts = lastVersion.split(".").map(Number);
          const newParts = currentVersion.split(".").map(Number);
          return (oldParts[0] ?? 0) !== (newParts[0] ?? 0) || (oldParts[1] ?? 0) !== (newParts[1] ?? 0);
        })();
        const direction = compareSemver(currentVersion, lastVersion ?? "0.0.0") > 0 ? "upgraded" : "reverted";
        process.stderr.write("\n");
        process.stderr.write(` ⬢ gnosys ${direction} · v${lastVersion} → v${currentVersion}\n`);
        process.stderr.write("\n");
        if (direction === "upgraded") {
          process.stderr.write("   sync registered projects        gnosys upgrade\n");
          if (isMajorOrMinor) {
            process.stderr.write("   restart mcp                     cursor → MCP: restart all servers\n");
            process.stderr.write("                                   claude code → /mcp → restart gnosys\n");
            process.stderr.write("                                   codex → start new session\n");
          }
        } else {
          process.stderr.write("   if this was unintentional, run  gnosys upgrade\n");
        }
        process.stderr.write("\n");
      }
      centralDb.close();
    }
  } catch {
    // non-critical — don't block CLI startup
  }
}

program.parse();
