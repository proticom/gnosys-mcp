# Release: v3.0.0

**Tag:** `v3.0.0`

**Title:** v3.0.0 — Centralized Brain + Federated Search + Preferences + Rules Generation

**Release Notes:**

## What's New in v3.0

### Phase 8a — Central Brain Architecture
- Centralized `~/.gnosys/gnosys.db` shared across all projects
- `project_id` and `scope` columns on every memory (project / user / global)
- Central project registry with `gnosys_register_project` and `gnosys_list_projects`
- `gnosys init` auto-detects project identity from `.git`, `package.json`, `Cargo.toml`, etc.
- One-shot migration: `gnosys_migrate_to_central` moves per-project data into central DB
- Backup & restore: `gnosys_backup` / `gnosys_restore` with automatic daily snapshots

### Phase 8b — Preferences & Rules Generation
- User-level preferences stored as scope='user' memories (not tied to any project)
- `gnosys_preference_set` / `gnosys_preference_get` / `gnosys_preference_delete` MCP tools
- `gnosys preferences` CLI with `set`, `get`, `delete`, `list` subcommands
- Agent rules generation: `gnosys rules` auto-generates `.cursor/rules/gnosys.mdc` or `CLAUDE.md` with memory workflow instructions
- Rules include project-specific context from briefings when available

### Phase 8c — CLI Parity
- Every v3.0 MCP tool has a matching CLI command
- `gnosys projects` — list registered projects
- `gnosys register` — register a project directory
- `gnosys sync` — migrate per-project data to central DB
- `gnosys backup` / `gnosys restore` — central DB backup management
- `gnosys preferences` — user preference CRUD
- `gnosys rules` — generate agent rules files
- All commands support `--json` output for scripting

### Phase 8d — Federated Search + Ambiguity Detection + Briefings
- `gnosys_federated_search` — cross-scope search with tier boosting (project 1.5x → user 1.0x → global 0.7x)
- Current-project memories get extra 1.2x multiplier (1.8x total)
- Recency boost (1.3x for memories modified in last 24h)
- Reinforcement boost (capped at 0.25 extra)
- `gnosys_detect_ambiguity` — warns when a query matches multiple projects
- `gnosys_briefing` — project status summary with categories, recent activity, top tags
- `gnosys_working_set` — implicit working set of recently modified memories

### New MCP Tools (v3.0)
- `gnosys_register_project`, `gnosys_list_projects`
- `gnosys_backup`, `gnosys_restore`
- `gnosys_migrate_to_central`, `gnosys_sync`
- `gnosys_preference_set`, `gnosys_preference_get`, `gnosys_preference_delete`
- `gnosys_federated_search`, `gnosys_detect_ambiguity`
- `gnosys_briefing`, `gnosys_working_set`
- Total: 47+ MCP tools + `gnosys://recall` resource

### Infrastructure
- 183 tests passing, zero TypeScript errors
- 6-table schema: memories, memories_fts, relationships, summaries, audit_log, projects
- New modules: `federated.ts`, `preferences.ts`, `rulesGen.ts`, `projectIdentity.ts`

---

# Previous Releases

## v2.0.0 — Agent-First SQLite Core + Dream Mode + Multi-Project Support

## What's New in v2.0

### Agent-First SQLite Core
- Unified `gnosys.db` replaces four separate data stores (`.md` files, `archive.db`, `embeddings.db`, `graph.json`)
- 5-table schema: `memories`, `memories_fts` (FTS5), `relationships`, `summaries`, `audit_log`
- All reads go through SQLite for sub-10ms performance
- Dual-write keeps `.md` files in sync as a human-readable safety net
- `gnosys migrate` — one-shot migration from v1.x stores
- WAL mode for safe concurrent access from multiple processes

### Dream Mode — Idle-Time Consolidation
- 4-phase cycle: confidence decay, self-critique, summary generation, relationship discovery
- Never deletes autonomously — only suggests reviews
- Configurable idle timer with automatic abort on agent activity
- Off by default; enable in `gnosys.json` under `dream`
- `gnosys dream` CLI command + `gnosys_dream` MCP tool

### Obsidian Export Bridge
- One-way export from `gnosys.db` to Obsidian-compatible vault
- Outputs: YAML frontmatter `.md` files, `[[wikilinks]]`, `_summaries/`, `_review/`, `_graph/`
- `gnosys export --to <dir>` CLI command + `gnosys_export` MCP tool

### Multi-Project / Multi-Root Workspace Support
- Every MCP tool accepts optional `projectRoot` for stateless per-call routing
- MCP roots protocol: `roots/list` on connect + `roots/list_changed` notifications
- Zero race conditions when parallel agents write to different projects
- `gnosys_stores` enhanced with MCP roots and detected store debugging info

### New MCP Tools
- `gnosys_dream` — Run a Dream Mode consolidation cycle
- `gnosys_export` — Export to Obsidian vault
- Total: 35 MCP tools + `gnosys://recall` resource

### New CLI Commands
- `gnosys migrate` — Migrate v1.x data to unified `gnosys.db`
- `gnosys dream` — Run Dream Mode with `--max-runtime`, `--no-critique`, `--no-summaries`, `--no-relationships`, `--json`
- `gnosys export` — Export to Obsidian with `--to`, `--all`, `--overwrite`, `--no-summaries`, `--no-reviews`, `--no-graph`, `--json`

### Infrastructure
- Version bumped to 2.0.0
- 143 tests passing, zero TypeScript errors
- `GnosysResolver` extended with `resolveForProject()` factory and `detectAllStores()`
- Dream config added to `gnosys.json` schema with Zod validation

---

# Previous Releases

## v1.4.0 — Aggressive Recall as MCP Resource
- Recall config simplified to single `aggressive: boolean` toggle
- `gnosys://recall` MCP Resource as primary injection mechanism
- Host-friendly format for automatic memory injection

## v1.3.0 — Enterprise Reliability
- Recall hook: sub-50ms memory retrieval for agent orchestrators
- Concurrency safety: file locking with PID tracking, WAL mode
- Structured JSONL audit logging with traceId support
- Deterministic dearchive with three-stage fallback
- Performance monitoring in dashboard

## v1.2.0 — Two-Tier Memory
- Active layer (`.md` files) + Archive layer (`archive.db`)
- Auto-archive stale memories, auto-dearchive on cite
- Bidirectional flow: maintain → archive, search/ask → dearchive

## v1.1.0 — Final Polish & Growth
- System of Cognition: 5 LLM providers (Anthropic, Ollama, Groq, OpenAI, LM Studio)
- `gnosys dashboard` — aggregated system status
- Persistent wikilink graph (`graph.json`)

## v1.0.0 — Auto Memory Maintenance
- Maintenance engine: confidence decay, duplicate detection, LLM consolidation
- Automatic reinforcement in search/ask tools
- `gnosys maintain` with dry-run and auto-apply

## v0.6.0 — Simplified Local LLM Layer
- LLM provider abstraction with factory pattern
- Anthropic + Ollama providers
- Task-based model routing
- `gnosys config` and `gnosys doctor` commands

## v0.5.0 — Hybrid Search + Freeform Ask
- Semantic embeddings (all-MiniLM-L6-v2)
- Hybrid search with RRF fusion
- Freeform Q&A with LLM synthesis and wikilink citations

## v0.4.0 — Real-World Demos + Production Infrastructure
- USDA FoodData Central + NVD CVE imports
- `gnosys.json` config with Zod validation
- Docker support, GitHub Actions CI
- LLM retry with exponential backoff

## v0.2.0 — Multi-client support & npm polish
- Setup instructions for Codex and OpenCode
- Tabbed config selector on landing page
- npm package improvements, SEO, CI/CD
