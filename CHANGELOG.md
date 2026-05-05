# Changelog

All notable changes to Gnosys are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
