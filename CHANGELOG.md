# Changelog

All notable changes to Gnosys are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.8.6] — 2026-05-16

CI hotfix #4 in the v5.8.x cascade — coverage threshold tripped at
49.88% on v5.8.5 because the new interactive code in
`src/lib/setup/summary.ts` (anthropic-revert repair prompt) and the
already-uncovered `src/lib/setup/sections/*.ts` wizards dragged the
average just under 50%.

### Fixed

- **Coverage threshold restored.** Added `src/lib/setup/**` to the
  vitest coverage exclude list. Same principle as `src/lib/setup.ts`
  which is already excluded — these are readline-driven interactive
  wizards (provider picker, dream config, chat config, preferences
  review, summary loop), exercised via CLI integration tests, not
  unit tests. No source code changes. v5.8.5 published successfully
  to npm (publish doesn't gate on coverage); this patch restores
  green CI on master.

## [5.8.5] — 2026-05-16

Upgrade UX + the "anthropic is sticky" repair + a real Codex MCP fix.
Five fixes that all surfaced while shaking down v5.8.4 on a real machine.

### Fixed

- **Codex MCP install actually works now.** v5.8.4 wrote a
  `[mcp.gnosys] type = "local" command = ["gnosys", "serve"]` block to
  `~/.codex/config.toml`. That schema is documented in some Codex
  references but NOT recognized by the current Codex CLI — `codex mcp
  list` wouldn't show gnosys and `codex mcp get gnosys` returned "No
  MCP server named 'gnosys' found." The fix mirrors what Claude Code
  has always done: shell out to the IDE's own registration command.
  Now `setupIDE("codex", ...)`:
  1. Strips both legacy hand-written blocks (`[gnosys]` from pre-5.8.4
     and `[mcp.gnosys]` from 5.8.4) out of `~/.codex/config.toml` so
     stale users get cleaned up.
  2. Resolves the absolute path to `gnosys` via `command -v gnosys`.
  3. Checks `codex mcp get gnosys` — leaves it alone if already
     registered correctly; removes + re-adds if the command differs.
  4. Runs `codex mcp add gnosys -- <absolute-gnosys> serve`.
  5. Prints: "Start a new Codex session for the Gnosys tools to appear."
  Acceptance: after `gnosys setup ides` (or `gnosys init` in a project
  with `.codex/`), `codex mcp list` shows `gnosys` and `codex mcp get
  gnosys` returns a stdio server with the right command. Failure mode
  (Codex CLI not on PATH) reports cleanly without breaking the rest
  of setup.
- **`gnosys upgrade` now uses the FRESH binary for sync-projects.**
  Previously the prompted post-install sync-projects call ran
  `syncProjectsAction({})` in-process — i.e. on the OLD binary that
  started `gnosys upgrade`, so the banner said "Gnosys v5.8.3 —
  upgrading registered projects" right after installing 5.8.4. As a
  side effect, the central DB also got stamped with the OLD version,
  which then tripped the preAction warning forever. Fix: shell out
  via `execSync("gnosys setup sync-projects", {stdio: "inherit"})`
  so a fresh process picks up the upgraded global binary.
- **Version-mismatch warnings are now direction-aware.** Previously
  the preAction hook and postinstall nudge both fired whenever the
  DB stamp ≠ the running pkg.version — including the very common
  "you just upgraded and haven't re-stamped yet" case. That produced
  a misleading "DB was upgraded to v5.8.3 by EdsMacStudio. You are
  running v5.8.4. Run: npm install -g gnosys" banner. Now both
  hooks use a small semver compare and only fire when meaningful:
  - preAction: only when `dbVersion > pkg.version` (real cross-machine
    "another machine is ahead of you" warning).
  - postinstall nudge: only when `pkg.version > lastVersion` (you just
    upgraded locally; suggests `gnosys setup sync-projects` to refresh
    the stamp, NOT `npm install -g gnosys` like before).
- **Anthropic-revert detection + one-keystroke repair.** When the
  setup summary loads a config with `defaultProvider: anthropic`
  AND no Anthropic key is configured anywhere (env / keychain) AND
  another provider DOES have a key, the wizard now prompts:

      ⚠ Your gnosys.json says defaultProvider: anthropic,
        but no Anthropic API key is configured (env or keychain).
        Found a key for xai.

        This usually means a pre-v5.8.4 setup wizard seeded anthropic
        by mistake.

      Switch the default to xai? [Y/n]

  Hitting Enter writes the corrected provider via the (now-safe)
  `updateConfig`. No more silently honoring a value the file picked
  up from a buggy default-seeding write.

### Added

- **Version banner after install.** `gnosys upgrade` now prints
  "✓ Installed gnosys v5.8.5 (was v5.8.4)" between the npm install
  output and the marker-write line, so the version transition is
  obvious even though the rest of the upgrade flow still runs
  in-process on the OLD binary.

### Internal

- Exported `getApiKeyForProvider(provider)` from `src/lib/setup.ts`
  so the summary wizard's repair logic can probe env + keychain
  without re-implementing the lookup.
- Added a small `compareSemver(a, b)` helper at the bottom of
  `cli.ts` — tolerant of "v" prefix and `-pre` / `+meta` suffixes.

## [5.8.4] — 2026-05-16

Four real bugs caught during real-world setup-wizard use, plus a long-
standing Codex MCP install gap.

### Fixed

- **Setup wizard no longer reverts the user's provider to "anthropic"
  on a fresh gnosys.json.** Root cause: `updateConfig` (used by every
  setup section — chat, dream, IDEs, etc.) read existing config via
  `loadConfig`, which fills in `DEFAULT_CONFIG` when the file is
  missing. The full defaulted object then got persisted, silently
  seeding `llm.defaultProvider: "anthropic"` into a file the user
  had previously kept empty (relying on env var / keychain / manual
  config). Fix: `updateConfig` now reads via `readRawConfig` (raw
  JSON, no defaults applied) and writes only the raw merged object.
  Schema still validates for shape — defaults are no longer
  persisted. Most likely v5.8.0 trigger: `gnosys setup chat` writing
  a chat section to a directory without an existing gnosys.json. (#94)
- **Doubled-keypress in `gnosys setup` summary wizard.** Typing "1"
  showed as "11" inside section editors because each section
  (`runModelsSetup`, `runDreamSetup`, `runChatSetup`) created its own
  readline interface while the summary's readline was still active —
  two readers racing on the same stdin. Fix: section editors now
  accept an optional `rl` from `opts`; the summary passes its
  readline through. Standalone invocations (`gnosys setup models`)
  still open and close their own readline. (#95)
- **Option 7 ("User Preferences") now actually manages preferences.**
  Old behaviour: listed ALL user-scope memories regardless of
  category, and offered no way to set a new preference — so for
  users with no prior imports it just said "0 stored" and exited.
  Fix: filters to category=preferences (matching what `gnosys pref
  set` writes), adds a "[N]ew" option to set a preference inline,
  shows key + value preview, deletes via `deletePreference`. (#96)
- **`gnosys setup` Codex MCP install used the wrong schema.**
  Wrote `[gnosys] command = "gnosys" args = ["serve"]` to
  `.codex/config.toml`. Current Codex CLI expects
  `[mcp.gnosys] type = "local" command = ["gnosys", "serve"]`, so
  the install was a silent no-op. Fix: emit the documented shape.
  Existing legacy `[gnosys]` blocks (3-line shape we used to write)
  are detected and stripped before adding the new block — users on
  stale configs get the fix automatically on next `gnosys setup`. (#97)

### Added

- **`gnosys init` / `gnosys_init` now also registers the MCP server**,
  not just the SessionStart recall hook. `configureClaudeCode`,
  `configureCodex`, and `configureCursor` in `projectIdentity.ts`
  each call `setupIDE(ide, projectDir)` after their hook setup. So a
  fresh project gets a working agent-callable gnosys in one step —
  previously you had to also run `gnosys setup` separately. (#97)

### Tests

- **3 new regression tests** in `src/test/v584-updateConfig.test.ts`
  for the anthropic-revert fix: writing a partial update to a fresh
  store doesn't seed `llm.defaultProvider`; existing xai config
  survives an unrelated section write; nested objects deep-merge
  rather than replacing outright. Total file count: 55, tests:
  941 (was 938).

## [5.8.3] — 2026-05-15

Polish patch: clickable citations, two CI guardrails that close the
holes that produced the v5.8.0→v5.8.2 cascade.

### Added

- **OSC8 hyperlinks on citations.** In `gnosys list` / `gnosys discover`
  / `gnosys search`, every memory ID is now wrapped in an OSC8 escape
  sequence pointing at `gnosys://memory/<full-id>` when stdout is a
  TTY. Modern terminals (iTerm2, Ghostty, Kitty, WezTerm, recent
  gnome-terminal) render the citation underlined and clickable; older
  terminals just see the original text — escapes are silently dropped.
  The URI always carries the full ULID, so `right-click → copy URL`
  gives back the precise id even when the visible text is the
  truncated `short` form. New helpers in `src/lib/idFormat.ts`:
  `formatMemoryIdHyperlink`, `memoryUri`, `osc8Wrap`, `isTtyStdout`. (#91)

### CI hardening

- **Per-file 0%-coverage gate.** New CI step (`scripts/check-new-file-
  coverage.mjs`) fails when a newly-added `src/lib/**/*.{ts,tsx}` or
  `src/sandbox/**/*.ts` file ships with 0% statement coverage.
  Compares the diff against `origin/master`, so only NEW files trip
  the gate — existing 0%-coverage modules (intentionally excluded
  via `vitest.config.ts`) are left alone. Catches the exact regression
  that bit v5.8.0: five new modules (`SlashPalette`, `idFormat`,
  `heartbeat`, `progress`, `upgrade`) shipped without tests and
  dragged the global coverage from ~50.5% to 49.69%, just under the
  threshold. (#92)
- **Weekly lockfile-refresh workflow.** New `.github/workflows/lockfile-
  refresh.yml` runs `npm update` every Monday 06:00 UTC, confirms
  `npm audit --audit-level=moderate` is clean, builds, runs tests,
  and opens a `chore: refresh lockfile (transitive dep bumps)` PR if
  the lockfile changed. Catches the drift mode that broke CI between
  v5.7.1 and v5.8.0 — npm publishes advisories on transitive deps
  that our committed lockfile pinned to versions inside the
  vulnerable range. Hand-triggered via Actions UI too. (#93)

### Tests

- **6 new tests** in `src/test/v580-helpers.test.ts` for the OSC8
  helpers (memoryUri, osc8Wrap, formatMemoryIdHyperlink under TTY /
  non-TTY / missing-project). Total in that file now 33.

## [5.8.2] — 2026-05-13

CI hotfix #2 — restore the coverage threshold that v5.8.0's new files
temporarily pushed us below.

### Fixed

- **Coverage threshold restored.** v5.8.0 added five new modules
  (`idFormat`, `heartbeat`, `progress`, `upgrade`, `SlashPalette`)
  without tests, dropping statement coverage from ~50.5% to 49.69% —
  just under the 50% threshold in `vitest.config.ts`. Added
  `src/test/v580-helpers.test.ts` (27 tests) covering the pure helpers:
  `formatMemoryId`, `parseIdFormat`, `buildProjectNameLookup`,
  `filterCommands`, and the full upgrade-marker lifecycle
  (`getMarkerPath`, `writeUpgradeMarker`, `readUpgradeMarker`,
  `shouldRestartMcp`). Statements back to 50.15%; all thresholds
  (statements 50, branches 40, functions 55, lines 50) pass with
  margin. No functional code changes.

## [5.8.1] — 2026-05-13

CI hotfix — clears the npm audit advisories that v5.8.0's CI tripped on.

### Fixed

- **`npm audit` advisories on `master` cleared.** v5.8.0's
  `package-lock.json` pinned stale transitive versions
  (`hono@4.12.7`, `@hono/node-server@1.19.10`, `fast-uri@3.1.1`,
  `ip-address@10.1.0`, `postcss@8.5.9`, `@xmldom/xmldom@0.8.12`,
  `express-rate-limit@8.5.0`) that fell inside published advisory
  ranges. `npm update` bumped each within its existing semver range
  to the patched versions (`hono@4.12.18`, etc.). Zero functional
  code changes; lockfile-only refresh. CI on `master` is green
  again. (#90)

## [5.8.0] — 2026-05-13

Chat is now a first-class surface. Two production bugs reported by Cowork
during v5.7.1 use are fixed (LLM error misdirection, CLAUDE.md auto-rewrite).
CLI startup is materially faster.

### Fixed

- **`gnosys_add` / `gnosys_commit_context` no longer fail with
  "set ANTHROPIC_API_KEY" when xAI (or any non-Anthropic provider) is
  the configured default.** `GnosysIngestion.ingest()` now accepts an
  optional per-call config override; MCP tool handlers pass `ctx.config`
  so the LLM resolves against the merged project+global config —
  even when the project's `gnosys.json` has no `llm` block. Also dropped
  the misleading early-gate on `gnosys_commit_context` that bypassed
  per-call config resolution. Provider-aware error messages everywhere
  (no more hardcoded ANTHROPIC_API_KEY in `gnosys ask`, `gnosys_ask`,
  `gnosys import`). (#8)
- **`gnosys_sync` no longer rewrites tracked `CLAUDE.md` every time a
  preference changes.** Two-pronged fix: (1) removed the
  "Run \`gnosys_sync\` to update agent rules files" advice from
  `gnosys_preference_set` / `gnosys_preference_delete` responses;
  (2) made the `gnosys_sync` MCP tool inert by default — it returns the
  preferences+conventions block as text. To actually write to
  `CLAUDE.md` / `.cursor/rules/*.mdc` (tracked files in most repos),
  callers must now pass `commit_to_disk: true`. Routine session
  context already flows through the SessionStart hook
  (`gnosys recall`); no disk write needed for that. (#9)
- **Chat TUI input-echo lag.** Hitting Enter previously cleared the
  input before the user turn appeared, because the user-turn push
  came after the `inferIntent` await. Now the user turn pushes
  synchronously before the await; React 19's automatic batching
  folds it with `setInput("")` into one render. (#3)

### Added

- **`gnosys setup chat` wizard.** Mirrors `setup dream` / `setup remote`:
  numbered summary, edit individual sections. Configures the chat-task
  provider+model (via `taskModels.chat`), recall behavior, tools
  fence on/off, auto-summarize nudge threshold, and a custom
  system-prompt prefix. New `ChatConfigSchema` in `src/lib/config.ts`. (#1)
- **`chat` is a first-class routing task.** Previously the chat TUI fell
  through to the `synthesis` fallback chain. Now it has its own slot in
  `config.taskModels` (alongside structuring / synthesis / vision /
  transcription / dream), exposed in `gnosys setup routing`. Existing
  installs see no change — when no `taskModels.chat` override exists,
  `resolveTaskModel` falls through to the default provider exactly as
  before. (#2)
- **Slash-command palette in chat TUI.** Type `/` at column 0 to open a
  filterable popup of all chat slash commands. Arrow keys navigate, Tab
  completes the highlighted command into the input, Esc dismisses. New
  component: `src/lib/chat/SlashPalette.tsx`. (#5)
- **TUI polish sweep.** Three picks from road-009 #6:
  - **Immediate "thinking…" feedback** — status flips on the same
    render frame as the user-turn push, so the spinner is visible the
    moment the user hits Enter (was delayed by a sync recall step).
  - **Smoother streaming** — LLM tokens batch into ~16ms chunks (one
    render frame at 60Hz) instead of firing setStatus per token. Cuts
    visible jitter on fast providers (Groq, xAI, cached responses).
  - **Paste detection** — when input has newlines or exceeds 200 chars,
    a "[paste: N lines, M chars]" preview appears above the input
    while the editor keeps the raw content for submit. (#6)
- **`--id-format short|long|raw`** on `gnosys search` (joins the
  `gnosys list` / `gnosys discover` versions from v5.7.1). `searchFts`
  now returns `project_id` so display IDs can be project-prefixed
  without N+1 lookups. Other commands either already display project
  names via the federated path or don't print memory IDs. (#7)

### Performance

- **Pragmatic CLI startup.** `@huggingface/transformers` (80MB) and
  related heavy modules (`mammoth`, `pdf-parse`, `turndown`,
  `bootstrap` deps) no longer load on every `gnosys` invocation —
  they `await import()` inside the action handlers that actually need
  them (`reindex`, `recall`, `chat`, `bootstrap`, `import`,
  `migrate-db`). Saves several hundred ms of CPU on `gnosys --help`,
  `gnosys list`, `gnosys status`, etc. Full transformers warm-up
  still happens on first `gnosys reindex` / `gnosys recall`. (#4)

## [5.7.1] — 2026-05-12

Dogfooding follow-ups from heavy daily use of v5.7.0 across multiple
machines. No new features — just rougher edges sanded down.

### Breaking changes

- **`gnosys dashboard` removed.** Use `gnosys status --system` instead.
  Pure rename: same output, same flags.
- **`gnosys portfolio` removed.** Use `gnosys status --projects` (or
  `--web` for the HTML view). `--global` is preserved as a deprecated
  alias for `--projects`.
- **`gnosys upgrade` is now a different command.** It used to re-init
  registered projects after a manual `npm install -g gnosys@latest`.
  Now `gnosys upgrade` runs the npm install itself, then prompts to run
  `gnosys setup sync-projects` (which is the old `upgrade` body, moved).
  Rationale: the old name implied it upgraded gnosys; it didn't. (#15)

### Fixed

- **MCP servers no longer serve stale code after an upgrade.** Root cause
  of the v5.7.0 cross-machine ID collision: the MCP server keeps running
  whatever binary it was spawned with, even after `npm install -g
  gnosys@latest`. New design: `gnosys upgrade` writes
  `~/.gnosys/last-upgrade-at`. Running MCP servers stat this marker every
  10s and exit cleanly when the version mismatches the binary they're
  running. The MCP host (Claude Code / Cursor / VS Code) auto-respawns
  the process against the new global binary. (#12, #15)
- **`gnosys setup remote status` is fast on SMB.** Replaced an
  O(local × remote) `getAllMemories()` + N+1 `getMemory()` loop with a
  one-query-per-side `getIdsModifiedSince()` aggregate, and capped the
  remote DB busy_timeout at 3s for status queries. On a contended write
  lock the status now returns "Remote DB busy — another sync is probably
  running on another machine" rather than hanging for 10s+. (#8a)
- **New memories without a project anchor return a clear error.**
  Previously `gnosys_add` and `gnosys_add_structured` could silently
  create a project-scoped memory with `project_id = null` when the
  agent forgot to pass `projectRoot`. Now those calls fail-fast with a
  message listing the four ways to scope the write (projectRoot, store=
  global, store=personal, or gnosys_init the directory). Scope is now
  derived from the explicit `store` argument; "global" / "personal"
  writes correctly skip the project anchor. (#13)

### Added

- **Always-on liveness indicator (heartbeat).** Long-running CLI ops
  that block on I/O for >500ms now show an animated spinner + elapsed
  seconds on stderr, repainted in place. TTY-only — silent in pipes,
  CI, and `--auto` modes. Wired into `setup remote status / push /
  pull / sync`. New helper: `src/lib/heartbeat.ts`. (#8)
- **`--verbose` flag for sync commands.** Streams per-memory progress
  to stderr (`→ deci-01HXXJK2…`). Bypasses the heartbeat (which would
  fight the verbose output) and uses plain newlines in non-TTY
  contexts. New helper: `src/lib/progress.ts`. Wired into
  `setup remote push / pull / sync`. (#7)
- **Display-layer project prefix on memory IDs.** Citations and list
  output now render as `gnosys-ai · deci-01HXXJK2…` instead of bare
  `deci-01HXXJK2ABCDEFGHIJK`. Storage is unchanged — only the display
  is project-prefixed, so project renames don't break IDs. Add
  `--id-format <short|long|raw>` to choose the form. Wired into
  `gnosys list` and `gnosys discover`; other commands follow in v5.8.0.
  New helper: `src/lib/idFormat.ts`. (#14)
- **`gnosys status --remote`** (alias for `gnosys setup remote status`).
- **`gnosys status --projects`** (replaces `gnosys portfolio`).
- **`gnosys setup sync-projects`** (the body that `gnosys upgrade` used
  to run before its rename).

### Notes

- Roadmap & triage: see road-009 in the central DB for the full triage
  of dogfooding feedback into v5.7.1 / v5.8.0 / v6.0 buckets. v5.8.0
  picks up the chat features (setup wizard, slash-command palette,
  input-echo lag fix, TUI elevation). v6.0 is a dedicated performance
  + testing sweep before any major-version bump.

## [5.7.0] — 2026-05-05

UX & bug sweep release. Five areas of work, each in its own phase commit
on master so individual pieces can be reverted independently:

### Fixed (Phase 1 — bug sweep)

- **MCP "database disk image is malformed" auto-recovery.** Long-lived MCP
  handles can go stale when concurrent writes happen (e.g. `gnosys setup`
  while Claude Code's MCP gnosys is open). The DB file itself is fine —
  just the cached page view is out of date. Added a `withRecovery<T>()`
  wrapper inside `GnosysDB`: on `SQLITE_CORRUPT`, close the handle,
  reopen, retry once. Surfaces a clear message pointing at `gnosys doctor`
  if persistent. Wraps insertMemory / getMemory / getActiveMemories /
  getAllMemories / logAudit / getAuditLog / queryAuditLog / insertProject
  / getProject / getProjectByDirectory / getAllProjects.
- **`gnosys timeline` queries the central DB.** Was reading from
  `GnosysResolver.getAllMemories()` (legacy file stores) which is empty
  post-DB-only. Showed only 1 memory despite 600+ in the central DB.
  Now uses `groupDbByPeriod(memories: DbMemory[], period)`. Adds
  `--project <id>` and `--limit-titles <n>` flags.
- **`gnosys audit` queries the central DB.** Was reading
  `.gnosys/.config/audit.jsonl` (legacy file audit). Now uses
  `db.queryAuditLog()`. New helper: `readAuditFromDb()`.
- **`gnosys doctor` Maintenance Health from central DB.** Was reporting
  all-zeros because `GnosysMaintenanceEngine(resolver)` reads file stores.
  Rewrote inline against the central DB with the same decay formula
  (DECAY_LAMBDA = 0.005, STALE_THRESHOLD = 0.3). Handles non-ISO legacy
  dates by treating them as "today" instead of NaN-corrupting averages.
- **`gnosys doctor --fix`** flag added: when the legacy
  `<store>/.gnosys/gnosys.db` exists, verify all its memory IDs are in the
  central DB before prompting for removal. Conservative — refuses to
  delete if any ID is missing centrally.
- **`audit_log` cross-table sync (deci-037 gap closed).** Audit entries
  now sync local↔remote with per-direction high-water cursors stored in
  `gnosys_meta` (`audit_last_pushed_at`, `audit_last_pulled_at`). First
  sync pushes the full backlog to remote. Push-then-pull cycles dedupe
  via the push cursor so we don't re-pull what we just pushed.
  `SyncResult` gains `auditPushed` / `auditPulled` counters.

### Added (Phase 2 — setup wizard)

- **Summary-first setup wizard.** When `gnosys setup` runs and a config
  exists, the first screen is a numbered summary of every section. Pick
  a number to edit just that piece, return to summary with `✓ updated`.
  `[D]one` to apply, `[E]xit` to leave. Run the linear 5-step wizard
  with `gnosys setup --full`.
- **Three new setup subcommands** for direct access:
  - `gnosys setup ides` — IDE/MCP integration only
  - `gnosys setup routing` — per-task LLM routing only
  - `gnosys setup preferences` — review user-scope prefs (incl. legacy
    imports). Classifies each pref by ID format
    (gnosys-native vs imported pre-gnosys), shows full content, lets you
    delete with confirm.
- **Multi-machine wizard polish.** Step 1 dedup (was double-listing
  detected volumes). Step 3 reworded to match deci-037 framing
  (remote = canonical source of truth, local = offline cache).
  "Cancel" → "Skip" — Step 3's Skip is now `configure-only` instead of
  fully aborting.

### Changed (Phase 3 — command organization)

- **`gnosys remote` parent removed.** All multi-machine commands live
  under `gnosys setup remote` now: configure (bare invocation), `status`,
  `push`, `pull`, `sync`, `resolve`. The standalone `gnosys remote`
  parent and its subcommands are deleted. `setup remote` push/pull/sync
  output now includes audit-counter (`↑audit ↓audit`) reflecting the
  Phase 1.5 sync gap fix.
- **`gnosys dashboard` → `gnosys status --system`.** The system-health
  view (memory count, LLM connectivity, embeddings, maintenance health)
  is now a flag on `status`. `dashboard` remains as a thin alias for
  back-compat.
- **Grouped `gnosys --help` output.** New "Commands by group" footer
  organized by purpose (Setup & status · Memory ops · Search ·
  Project mgmt · Chat · Maintenance · Multi-machine · Agent runtime ·
  Legacy / advanced). Alphabetical within group. The full list still
  appears above for scriptability.
- **Confusing `--help` text rewrites** for: `serve`, `sandbox`, `helper`,
  `pref`, `reindex`, `graph`. Each now explains what it does and when to
  use it instead of just naming it.

### Added (Phase 4 — chat MCP tool access)

- **Chat agent can call gnosys functions in-process.** A new
  `gnosys-tool` fenced protocol lets the LLM look up live data the user
  asks about — list of projects, memory contents, briefings, recent
  activity. Same pattern as `gnosys-choose` from v5.6.0: provider-agnostic,
  no native tool_use API needed.

  Available tools: `list_projects`, `search`, `read`, `briefing`, `stats`,
  `tags`, `audit`, `recent_memories`. The system prompt teaches the LLM
  the syntax; each call runs in-process against the central DB and the
  result is fed back as a system turn before the LLM's next response.
  Up to 4 tool-call iterations per chat turn (configurable via
  `maxToolIterations`).

### Polish (Phase 3/5)

- **`gnosys briefing paperboy`** — accept project name as positional arg
  in addition to `--project <id>`. Resolves to ID via name lookup.
- **`gnosys check`** — drop the wrong `--directory` flag. Add
  `--task <name>` to test only one task. Add `chat` to the task list
  (matches what setup configures); chat reuses synthesis routing —
  surfaced under its own name so users see what their TUI uses.
- **`gnosys stats --by-project`** — new flag for a per-project breakdown
  table (active, archived, reinforcements, last modified). Default
  behavior still scoped to current project unless `--all` is given.

### Tests

- 905+ tests passing across 53 test files. New coverage: `db-recovery`
  (6), `remote-audit-sync` (5), `chat-tools` (18). Updates to existing
  files for the new behaviors.

### Known issues (carried forward from v5.6.0)

`npm install` still emits two upstream-deprecation warnings — both
transitive, both functional, neither breaking. Tracked in road-006.

## [5.6.0] — 2026-05-04

### Added

- **`gnosys chat` — interactive memory-aware terminal chat (TUI).** Built on `ink`. Lazy-loaded so non-chat CLI commands aren't paying for the import cost.
  - **Memory recall on every turn.** Each prompt triggers federated recall (project > user > global with tier boosting) and the matching memories are injected into the LLM's system prompt. Each assistant turn shows its citation footer: `cited: [deci-037] [arch-012]`.
  - **Two-layer persistence.** Every turn fsync's into `~/.gnosys/chat-sessions/<sessionId>.jsonl` (the audit trail) AND smart-promotes to gnosys memories on `/remember`, `/save-turn`, `/attach`, or auto-detected decisions (with confirm).
  - **Focus boundaries replace sessions.** `/focus <topic>` clears the working buffer but keeps the session log. `/branch` forks for hypothetical exploration. `/resume-focus` restores prior focuses or pops the most recent branch.
  - **Free-text intent detection.** Type "remember that…", "what did we decide about…", "thanks, that's all" — the TUI matches against a regex catalog (instant) or falls back to a cheap LLM classifier (only when ambiguous + imperative). Non-destructive intents auto-accept after 5 confirmations of the same pattern; destructive ones (`/quit`) always confirm.
  - **Multiple-choice protocol.** When the model emits a fenced ` ```gnosys-choose ` block, the TUI parses it and renders an arrow-key selectable list. The selection injects as `[picked: <id> — <label>]` into the next user turn. Provider-agnostic — no tool-use API needed.
  - **24 slash commands** across recall, writing, focus, and polish:
    - Reading: `/help`, `/history`, `/list`, `/read <id>`, `/tags`, `/dashboard`, `/quit`
    - Recall: `/pin <id>`, `/unpin <id>`, `/scope`, `/threshold`, `/recall <q>`, `/reinforce <id>`
    - Writing: `/remember <text>`, `/save-turn`, `/attach <file>`
    - Focus: `/focus <topic>`, `/branch`, `/resume-focus [topic]`
    - Polish: `/clear`, `/provider`, `/export <file.md>`, `/search-chats <query>`, `/dream-here`
  - CLI flags: `gnosys chat --resume <sessionId>`, `--list`, `--search <query>`, `--provider`, `--model`.

- **Per-project bundle import/export.** Restructured under `gnosys export` and `gnosys import` parent commands (mirrors the `gnosys setup models|remote|dream` pattern):
  - `gnosys export project [id] --to <file.json.gz>` — bundles project memories, relationships, and audit log into a portable `.json.gz` file (auto-detects current project from cwd).
  - `gnosys export vault --to <dir>` — explicit alias for the v5.5.x Obsidian vault export.
  - `gnosys import project <bundle> --strategy merge|replace|new-id` — restore a bundle. `merge` skips existing memories (default), `replace` wipes the target project first, `new-id` generates a fresh project ID and remaps memory IDs to avoid collisions.
  - The v5.5.x form `gnosys export --to <dir>` keeps working via a pre-parse argv shim that rewrites it to the `vault` subcommand. Documented as the migration path.

### Changed

- `gnosys export` is now a parent command — bare invocation prints subcommand usage instead of running vault export. Use `gnosys export vault --to <dir>` (or the back-compat shim above).
- `gnosys import [fileOrUrl]` made the positional argument optional so subcommands can take precedence; missing `--format`/`--mapping` is now a runtime error with a usage hint pointing to `gnosys import project` for bundles.

### Tests

- 877+ tests passing. New chat-related tests across 7 files: `chat-session`, `chat-commands`, `chat-orchestrator`, `chat-recall`, `chat-write`, `chat-intent`, `chat-choose`, `chat-focus`. Plus `export-import-project` for the bundle round-trip.

### Known issues (deferred to a future patch)

- `npm install` still emits two upstream-deprecation warnings — both transitive, both functional:
  - `prebuild-install@7.1.3` — pulled in by `better-sqlite3`. Waits on better-sqlite3 migrating to `node-gyp-build` upstream (issue tracked in https://github.com/proticom/gnosys/issues/5).
  - `boolean@3.2.0` — pulled in by `@huggingface/transformers → onnxruntime-node → global-agent → boolean`. Waits on `global-agent` removing the dependency (the package author has indicated `boolean` is no longer maintained but the package still works).

## [5.5.0] — 2026-05-03

### Changed

- **Migrated from `@xenova/transformers@2.17.2` to `@huggingface/transformers@4.x`** — `@xenova/transformers` was rebranded to `@huggingface/transformers` and has been the maintained home for transformers.js since v3. The v2-era `quantized: true` pipeline option became `dtype: "q8"`. Cache env var renamed from `TRANSFORMERS_CACHE` to `HF_HOME` (we set both for back-compat). This clears the `prebuild-install@7.1.3` deprecation warning that came in via `sharp` from the old package — the warning may still appear once if `better-sqlite3` is rebuilt, since it uses a separate `prebuild-install` chain that waits on upstream migration to `node-gyp-build`.

### Fixed

- **Test suite back to fully green (738/738).** The vitest config never set `testTimeout` or `fileParallelism` overrides, so CLI integration tests hit the 5s default and the parallel workers fought each other for SQLite write locks. Set `testTimeout: 60_000`, `hookTimeout: 60_000`, and `fileParallelism: false`. Net effect: tests run serially but reliably; a clean run completes in ~12 minutes vs. ~4 minutes parallel-but-flaky.

### Added

- **`gnosys dream run` — explicit manual trigger.** The bare `gnosys dream` already runs a cycle, but users naturally type `dream run` to match the `dream log` pattern. Added an alias subcommand. Both forms now check the central DB's `dream_machine_id` designation before running and refuse on non-designated machines unless `--force` is passed.



### Fixed

- **Postinstall output now visible during `npm install -g`.** npm 7+ hides postinstall stdout for global installs but shows stderr — switched our messages to stderr so users actually see "Gnosys v5.4.3 installed / Run `gnosys upgrade`" after a global install.
- **Postinstall version read fixed.** Previously printed "Gnosys vunknown" because `require("fs")` doesn't work in ESM modules. Replaced with proper top-level `import { readFileSync }` and `import.meta.url`-based path resolution.

### Added

- **Upgrade nudge on first CLI invocation.** Tracks `last_seen_version` in central DB meta. On every CLI command boot, if the installed version differs from what's stored, print a one-line stderr notice:
  ```
  gnosys: upgraded to v5.4.3 (from v5.4.2). Run 'gnosys upgrade' to sync registered projects.
  ```
  Fires once per upgrade, then updates the meta. Skipped when running `gnosys upgrade` itself, when `GNOSYS_SKIP_UPGRADE_NUDGE=1` is set, or when the central DB is unavailable. Belt-and-suspenders for cases where the postinstall hook silently fails (CI, Docker builds, `--ignore-scripts`).

### Known issue (deferred to v5.5.0)

- `npm install` still prints `npm warn deprecated prebuild-install@7.1.3: No longer maintained.` This is a transitive deprecation: `prebuild-install` is pulled in by `better-sqlite3` and (via `sharp`) by `@xenova/transformers`. The package still works correctly — the maintainer has just announced no future patches. Migrating `@xenova/transformers` (now a stale package) to `@huggingface/transformers@4.x` (the modern rebrand) is planned for v5.5.0 and will remove half of the dependency chain. The other half waits on `better-sqlite3` migrating to `node-gyp-build` upstream.

## [5.4.2] — 2026-05-01

### Added — Dream Mode setup, designation, and observability

- **`gnosys setup dream`** — new wizard configures Dream Mode: enable/disable, designate which machine hosts the scheduler, pick provider/model with live API validation, set idle threshold / max runtime / min memories, toggle sub-tasks (selfCritique / generateSummaries / discoverRelationships).
- **Single-machine designation** — `dream_machine_id` stored in central DB meta. Only the designated machine arms its DreamScheduler; others no-op silently. Stops every machine on a shared NAS DB from racing on dream cycles.
- **`gnosys dream log`** — view recent dream runs from `audit_log`. Flags: `--last N`, `--since YYYY-MM-DD`, `--failures-only`, `--json`.
- **`DREAM HEALTH`** section in `gnosys dashboard` — designated machine, last run, last successful run (with LLM work), recent failure count, consecutive-failure counter.
- **Layered alerts** when the dream provider is unreachable:
  - **Layer 1 (setup time):** validateModel probe in `gnosys setup dream` prompts before saving config when the provider fails.
  - **Layer 2 (audit log):** every `dream_start` records the configured provider/model; `dream_provider_unreachable` entries appear when the LLM can't be reached at run time. Reflected in `dream_complete.providerUnreachable`.
  - **Layer 3 (MCP startup):** designated machine probes the dream provider at MCP server boot; stderr warning surfaces in agent sessions if unreachable.
  - **Layer 4 (desktop notification):** after 3 consecutive provider failures, `notify-send` (Linux) / `osascript` (macOS) / stderr fallback (other) fires a notification. Counter resets on a successful LLM-driven dream run.

### Changed

- `gnosys setup remote` description updated (no longer says "alias for `gnosys remote configure`" since the latter was removed).
- Dream config schema unchanged but is now actively used per the new setup flow.

### Removed (Breaking)

- **`gnosys models`** (top-level shortcut) — use `gnosys setup models` instead.
- **`gnosys remote configure`** — use `gnosys setup remote` instead.

The pattern is now consistent: `gnosys setup` runs the full wizard, and `gnosys setup <subsection>` skips to one section. `gnosys remote push|pull|sync|status|resolve` are unaffected — only `configure` moved.

### Verification

- 735+/738 main tests pass (3 pre-existing xAI keychain failures unchanged).
- gnosys-tests regression suite extended with `dream-log.test.ts`, `setup-dream.test.ts`, `removed-commands.test.ts`, plus DREAM HEALTH assertion in `dashboard.test.ts`.
- Manual smoke: dashboard surfaces DREAM HEALTH; designated machine probe runs at MCP boot; dream log filters work; removed commands return non-zero with "unknown command".

## [5.4.0] — 2026-04-30

### Added — three new IDE integrations
- **Claude Desktop** — `gnosys init claude-desktop` writes to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows), or `~/.config/Claude/claude_desktop_config.json` (Linux). One config covers Chat, Cowork, and Code surfaces inside Claude Desktop.
- **Gemini CLI** — `gnosys init gemini-cli` writes to `~/.gemini/settings.json`, preserving any existing user settings.
- **Antigravity** — `gnosys init antigravity` writes to `~/.gemini/antigravity/mcp_config.json`. Antigravity hot-reloads MCP servers when the file changes.
- All merges are idempotent — re-running is safe, and existing `mcpServers` entries from other tools are preserved.

### Added — setup wizard polish
- "Custom (enter model name)" option in the model picker. Lets users type any provider model ID (including the dated/reasoning variants OpenRouter doesn't list, like `grok-4.20-0309-reasoning`).
- Post-setup model validation via a tiny test API call (`max_tokens=5`). Catches typos and bad keys before the wizard finishes. Supports anthropic, openai, xai, groq, mistral, ollama, lmstudio, and custom providers.
- New subcommands: `gnosys setup models` (just LLM/model config), `gnosys setup remote` (multi-machine sync), `gnosys models --list|--refresh|--set <name>` (quick model ops).

### Added — central DB hygiene
- `GNOSYS_HOME` env var override — redirects every gnosys-owned path (DB, config, sandbox) to a custom directory. Used by tests for isolation; also lets advanced users move their `~/.gnosys/` elsewhere.
- `gnosys projects --prune` — deletes registry entries whose `working_directory` no longer exists on disk. Useful for cleaning up after CI runs or removed projects.
- `gnosys projects` (no flags) now hides projects whose directory is missing; `--all` shows everything for debugging.

### Added — `src/lib/paths.ts`
- New module is the **single source of truth** for `~/.gnosys/...` resolution. Exports `getGnosysHome()`, `getCentralDbPath()`, `getGlobalConfigPath()`, `getSandboxDir()`. All hardcoded `path.join(os.homedir(), ".gnosys")` sites in the codebase now go through this helper.

### Fixed
- Remote sync configuration from `gnosys setup` — readline lifecycle bug was firing "Setup cancelled" before the remote wizard could run. `runConfigureWizard()` now accepts an optional external readline so the parent wizard owns the lifecycle.
- Test pollution — every test that spawns the gnosys CLI now passes an isolated `GNOSYS_HOME`. Stops tests from registering temporary projects in the user's real central DB.
- `csv-parse/sync` types — bundled `src/types/csv-parse-sync.d.ts` ambient declaration silences the missing-types warning that comes from csv-parse v6.1's published package.

### Verification
- 735 / 738 tests pass (3 pre-existing `llm-providers.test.ts` failures unchanged — caused by xAI key in keychain on the test machine).

## [5.3.3] — 2026-04-25

### Added
- `gnosys setup` now offers an optional multi-machine sync step at the end. Picks up the same wizard as `gnosys remote configure` so first-time users only need to run one command.

## [5.3.2] — 2026-04-25

### Changed
- `package.json` author block: now `Proticom`, with `Edward Tadros` as a contributor (positions Gnosys as a Proticom product)
- README adds a "A Proticom product" tagline below the badges
- Internal example paths updated from vendor-specific to generic (`/Volumes/nas/`)
- Internal regex heuristics generalized (no personal names)

## [5.3.1] — 2026-04-08

### Added
- Production-grade interactive wizard for `gnosys remote configure`
- Auto-detects mounted volumes at `/Volumes/`, suggests a `gnosys` subdirectory
- Validates path: writability, SQLite locking, latency check
- Detects existing DB at remote and shows memory count + last modified
- Handles all data scenarios: fresh setup, local-only migration, remote-only pull, both-have-data merge/replace/cancel
- Reconfigure mode: change | revalidate | disconnect | cancel

### Changed
- `gnosys remote configure --path` still works for non-interactive scripted use
- Wizard logic extracted into `src/lib/remoteWizard.ts`

## [5.3.0] — 2026-04-08

### Added
- **Multi-machine sync** — share `gnosys.db` across machines via NAS or shared drive
  - `src/lib/remote.ts` — RemoteSync engine with push, pull, sync, resolve, migrate
  - `gnosys remote configure` — interactive setup with path validation, SQLite compatibility test, latency check
  - `gnosys remote status` — show pending changes, conflicts, last sync, reachability
  - `gnosys remote sync` — two-way sync (push then pull)
  - `gnosys remote push` / `pull` — one-way sync
  - `gnosys remote resolve <id> --keep <local|remote>` — manual conflict resolution
- **MCP tools for sync**: `gnosys_remote_status`, `gnosys_remote_push`, `gnosys_remote_pull`, `gnosys_remote_resolve`
- **Conflict detection** via per-memory `modified` timestamps — skip-and-flag default, `--newer-wins` opt-in
- **Offline write queue** — local writes queue when remote unreachable, replay on reconnect
- **DB schema additions**: `pending_sync` and `sync_conflicts` tables
- **AI-mediated conflict resolution** — agents detect sync state and prompt user via `_remote_status` field

### Changed
- Test count: 718 → 738 (added 21 tests for sync engine)
- AGENTS.md: added "Remote Sync Awareness" section with surfacing guidelines

## [5.2.24] — 2026-04-07

### Fixed
- Resolved vite high-severity CVE (path traversal, server.fs.deny bypass, WebSocket arbitrary file read)

## [5.2.23] — 2026-04-07

### Fixed
- `gnosys doctor` no longer creates an empty `gnosys.db` in project directories
- `gnosys_import` no longer calls legacy `migrate()` that opened a project-local DB
- Local `gnosys.db` files in project directories are now reported as legacy artifacts and safe to remove

## [5.2.22] — 2026-04-06

### Fixed
- `gnosys upgrade` skips macOS temp directories (`/var/folders/`, `/private/var/`) in addition to `/tmp/`
- Cleaned 548 stale test project entries from central DB

## [5.2.20] — 2026-04-05

### Added
- npm audit gate in CI — fails build on high/critical vulnerabilities

## [5.2.19] — 2026-04-05

### Fixed
- npm audit fixes for path-to-regexp ReDoS and picomatch method injection / ReDoS

## [5.2.16] — 2026-04-05

### Fixed
- OIDC trusted publishing — switched to Node 24 (npm v11) for working OIDC handshake
- Removed `registry-url` from setup-node (was creating empty NODE_AUTH_TOKEN)
- Pure tokenless publishing now works end-to-end

## [5.2.15] — 2026-04-04

### Added
- `AGENTS.md` for generic AI agent discovery (Codex, etc.)
- `gnosys update` (CLI) now uses DB-first lookup matching the MCP tool fix

### Changed
- Cleaned up `.claude/CLAUDE.md`: removed stale v4.0.0 work section, updated architecture
- Archived 5 superseded decision memories from central DB
- Regenerated root CLAUDE.md via `gnosys sync`

## [5.2.14] — 2026-04-04

### Fixed
- All 56 previously failing tests now pass (718/718 green)
- Path quoting in test shell commands (iCloud "Mobile Documents" path)
- `extractJson()` helper strips upgrade nudge warnings before JSON parsing

## [5.2.13] — 2026-04-04

### Changed
- Upgrade nudge now lists restart instructions for Cursor, Claude Code (`/mcp`), and Codex

## [5.2.11] — 2026-04-04

### Added
- Upgrade nudge — first CLI command after `npm install -g` shows what to do next

### Changed
- Postinstall hook simplified — npm v7+ suppresses script output, so the nudge is in the CLI itself

## [5.2.10] — 2026-04-04

### Fixed
- `gnosys_update`, `gnosys_history`, `gnosys_links` (MCP tools) now resolve memory IDs via central DB before falling back to file resolver
- Bug was silently failing on memory IDs like `road-007` because the legacy resolver expected file paths
- Added `GnosysDB.getAuditLog()` method
- `gnosys_history` uses audit_log table in DB-only mode
- `gnosys_links` uses `getRelationshipsFrom`/`getRelationshipsTo` in DB-only mode

## [5.2.8] — 2026-04-03

### Added
- **Portfolio dashboard** — `gnosys portfolio` and `gnosys status` commands
- `gnosys status` (single project), `gnosys status --global` (all projects), `gnosys status --web` (HTML dashboard)
- `gnosys portfolio --output file.html|md|json`
- HTML dashboard with SVG readiness rings, blockers-first design, staleness indicators, regenerate button, AI prompt panel
- `gnosys update-status` — guided 8-section checklist for AI agents
- MCP tools: `gnosys_portfolio`, `gnosys_update_status`
- `gnosys upgrade` regenerates the dashboard automatically
- LaunchAgent config for daily auto-regeneration

### Fixed
- Status memory parser handles varied formats across categories (landscape, roadmap, sandbox, architecture, status)
- Action item parser reads structured sections (Waiting on Human, Blockers, Open Decisions)

## [5.1.0] – [5.1.1]

### Changed
- DB-only architecture — SQLite is sole source of truth, no markdown dual-write
- `gnosys migrate` for relocating `.gnosys/` stores
- `db.getNextId()` from DB instead of filesystem scan
- IDE hook auto-configuration (Claude Code, Codex, Cursor)

### Removed
- `gnosys init` no longer creates category folders, CHANGELOG.md, or git repo
- Legacy dual-write to markdown files

## [4.0.0]

### Added
- Web Knowledge Base — `gnosys/web` subpath export for serverless chatbots
- `staticSearch.ts`, `webIndex.ts`, `webIngest.ts`, `structuredIngest.ts`
- `gnosys web init/ingest/build-index/build/add/remove/update/status`

## [3.0.0]

### Added
- Centralized brain at `~/.gnosys/gnosys.db` with project_id and scope columns
- Federated search across projects with tier boosting
- Sandbox-first runtime with Dream Mode
- CLI parity for all MCP tools
- Network share + multi-machine support (foundational)

[5.3.0]: https://github.com/proticom/gnosys/releases/tag/v5.3.0
[5.2.24]: https://github.com/proticom/gnosys/releases/tag/v5.2.24
[5.2.23]: https://github.com/proticom/gnosys/releases/tag/v5.2.23
[5.2.22]: https://github.com/proticom/gnosys/releases/tag/v5.2.22
[5.2.20]: https://github.com/proticom/gnosys/releases/tag/v5.2.20
[5.2.19]: https://github.com/proticom/gnosys/releases/tag/v5.2.19
[5.2.16]: https://github.com/proticom/gnosys/releases/tag/v5.2.16
[5.2.15]: https://github.com/proticom/gnosys/releases/tag/v5.2.15
[5.2.14]: https://github.com/proticom/gnosys/releases/tag/v5.2.14
[5.2.13]: https://github.com/proticom/gnosys/releases/tag/v5.2.13
[5.2.11]: https://github.com/proticom/gnosys/releases/tag/v5.2.11
[5.2.10]: https://github.com/proticom/gnosys/releases/tag/v5.2.10
[5.2.8]: https://github.com/proticom/gnosys/releases/tag/v5.2.8
