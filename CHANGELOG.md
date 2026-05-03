# Changelog

All notable changes to Gnosys are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
