# CLI Reference

_Generated from `src/cli.ts` by `scripts/gen-cli-docs.mjs`. Do not edit by hand._

## `gnosys read <memoryPath>`

Read a specific memory. Supports layer prefix (e.g., project:decisions/auth.md)

## `gnosys discover <query>`

Discover relevant memories by keyword. Use --federated for tier-boosted cross-scope discovery.

## `gnosys search <query>`

Search memories by keyword. Use --federated for tier-boosted cross-scope search.

## `gnosys list`

List all memories across all stores

## `gnosys add <input>`

Add a new memory (uses LLM to structure raw input)

## `gnosys setup`

Configure Gnosys — LLM provider, models, remote sync, and IDE integration

## `gnosys models`

Update LLM provider and model configuration

## `gnosys remote`

Multi-machine sync — configure, sync, and resolve conflicts

## `gnosys status`

Show remote sync status: pending changes, conflicts, last sync

## `gnosys push`

Push local changes to remote

## `gnosys pull`

Pull remote changes to local

## `gnosys sync`

Two-way sync: push local changes then pull remote changes

## `gnosys resolve <memoryId>`

Resolve a sync conflict by choosing local, remote, or merged content

## `gnosys dream`

Configure Dream Mode — designate this machine, pick provider/model, set schedule

## `gnosys chat`

Configure the chat TUI — provider/model, recall behavior, tools, system-prompt prefix

## `gnosys ides`

Configure IDE integrations (Claude Code/Desktop, Cursor, Codex, Gemini CLI, Antigravity)

## `gnosys routing`

Configure per-task LLM routing (structuring, synthesis, vision, transcription, dream)

## `gnosys preferences`

Review and clean up user-scope preferences (incl. legacy imports)

## `gnosys init [ide]`

Initialize Gnosys in the current directory. Optionally specify IDE: cursor, claude, claude-desktop, codex, gemini-cli, or antigravity to force IDE setup.

## `gnosys migrate`

Interactively migrate a .gnosys/ store to a new directory. Moves files, updates project name/paths, syncs to central DB, and cleans up.

## `gnosys stale`

Find memories not modified within a given number of days

## `gnosys tags`

List all tags in the registry

## `gnosys update <memoryPath>`

Update an existing memory

## `gnosys reinforce <memoryId>`

Signal whether a memory was useful, not relevant, or outdated

## `gnosys add-structured`

Add a memory with structured input (no LLM needed)

## `gnosys chat`

Interactive memory-aware terminal chat (TUI)

## `gnosys ingest <fileOrGlob>`

Ingest a file (PDF, DOCX, TXT, MD) into Gnosys memory. Extracts text, splits into chunks, and creates atomic memories.

## `gnosys tags-add`

Add a new tag to the registry

## `gnosys commit-context <context>`

Pre-compaction sweep: extract atomic memories from a context string, check novelty, commit novel ones

## `gnosys lens`

Filtered view of memories. Combine criteria to focus on what matters.

## `gnosys history <memoryPath>`

Show audit history for a memory

## `gnosys timeline`

Show when memories were created and modified over time

## `gnosys stats`

Show summary statistics for the memory store. Use --by-project for a per-project breakdown across the central DB.

## `gnosys links <memoryPath>`

Show wikilinks for a memory — both outgoing [[links]] and backlinks from other memories

## `gnosys graph`

Show the [[wikilink]] cross-reference graph between memories. Empty until you start using [[Title]] in memory content — then this shows which memories reference each other.

## `gnosys bootstrap <sourceDir>`

Batch-import existing documents into the memory store

## `gnosys import [fileOrUrl]`

Import data into Gnosys (bulk CSV/JSON/JSONL — see also:

## `gnosys project <bundlePath>`

Import a project bundle (.json.gz) created by

## `gnosys reindex`

Rebuild semantic embeddings for every memory in the central DB. Run after bulk imports, schema changes, or if hybrid search starts returning poor matches. Downloads the all-MiniLM-L6-v2 model (~80 MB) on first run.

## `gnosys hybrid-search <query>`

Search using hybrid keyword + semantic fusion (RRF). Use --federated for cross-scope.

## `gnosys semantic-search <query>`

Search using semantic similarity only (requires embeddings)

## `gnosys ask <question>`

Ask a natural-language question and get a synthesized answer with citations. Use --federated for cross-scope.

## `gnosys stores`

Show all active stores, their layers, paths, and permissions

## `gnosys config`

View and manage LLM provider configuration

## `gnosys show`

Show current LLM configuration

## `gnosys set <key> <value> [extra...]`

Set a config value. Keys: provider, model, ollama-url, groq-model, openai-model, lmstudio-url, task <task> <provider> <model>

## `gnosys init`

Generate a blank gnosys.json template (deprecated — prefer `gnosys setup`)

## `gnosys reindex-graph`

Build or rebuild the wikilink graph (.gnosys/graph.json)

## `gnosys maintain`

Run vault maintenance: detect duplicates, apply confidence decay, consolidate similar memories

## `gnosys dearchive <query>`

Force-dearchive memories matching a query from archive.db back to active

## `gnosys sync-projects`

Re-initialize all registered projects after upgrading gnosys: refresh agent rules, project registry, central DB stamp, and portfolio dashboard.

## `gnosys cleanup`

Remove dead and temp-dir entries from the project registry

## `gnosys upgrade`

Upgrade gnosys itself and signal running MCP servers to restart. After upgrading, suggests running

## `gnosys doctor`

Check system health: stores, LLM connectivity, embeddings, archive

## `gnosys check`

Test LLM connectivity for each configured task (structuring, synthesis, chat, vision, transcription, dream)

## `gnosys dream`

Dream Mode — idle-time consolidation (run a cycle, view log)

## `gnosys run`

Force a dream cycle now (manual trigger)

## `gnosys log`

Show recent dream runs from the audit log (default: last 20)

## `gnosys export`

Export memory to a vault (markdown) or a project bundle (.json.gz)

## `gnosys vault`

Export gnosys.db to an Obsidian-compatible vault (one-way)

## `gnosys project [projectId]`

Export a single project to a portable .json.gz bundle (round-trips with

## `gnosys serve`

Start the MCP server (stdio mode). Used by IDE integrations — Claude Code/Desktop, Cursor, Codex, etc. spawn this command in the background to talk to gnosys via the Model Context Protocol. You don

## `gnosys recall <query>`

Always-on memory recall — injects most relevant memories as context. Use --federated for cross-scope.

## `gnosys audit`

View the structured audit trail of memory operations from the central DB

## `gnosys backup`

Create a backup of the central Gnosys database and config

## `gnosys restore <backupFile>`

Restore the central Gnosys database from a backup

## `gnosys migrate-db`

Legacy data migration. Use --to-central to move per-project stores into the central DB.

## `gnosys connect`

Point an IDE at a remote gnosys server (central-server topology) instead of spawning a local one

## `gnosys centralize`

Copy this machine

## `gnosys machine`

Manage this machine

## `gnosys show`

Show this machine

## `gnosys migrate`

Move machine-local config (machineId, remote) out of the synced DB into machine.json, set roots, and scan

## `gnosys scan`

Discover projects under this machine

## `gnosys projects`

List registered projects from the central DB

## `gnosys pref`

User preferences — small key-value memories scoped to you (not a project), surfaced into every agent

## `gnosys set <key> <value>`

Set a user preference. Key should be kebab-case (e.g.

## `gnosys get [key]`

Get a preference by key, or list all preferences if no key given.

## `gnosys delete <key>`

Delete a user preference.

## `gnosys sync`

Regenerate agent rules files from user preferences and project conventions. Injects GNOSYS:START/GNOSYS:END block.

## `gnosys fsearch <query>`

Federated search across all scopes with tier boosting (project > user > global)

## `gnosys ambiguity <query>`

Check if a query matches memories in multiple projects

## `gnosys briefing [projectNameOrId]`

Generate project briefing — memory state summary, categories, recent activity, top tags

## `gnosys status`

Show status. Sections: --projects (all projects) · --remote (sync) · --system (memory/LLM health) · default: current project. Output: --web · --json. Note:

## `gnosys update-status`

Show the prompt to give an AI agent to update this project

## `gnosys working-set`

Show the implicit working set — recently modified memories for the current project

## `gnosys sandbox`

Manage the Gnosys sandbox — a long-lived background process that holds the SQLite handle so agents can call gnosys.add()/recall() through a tiny helper library instead of paying the MCP roundtrip on every call. Lower latency, lower context cost. Most users don

## `gnosys start`

Start the Gnosys sandbox background process

## `gnosys stop`

Stop the Gnosys sandbox background process

## `gnosys status`

Check if the Gnosys sandbox is running

## `gnosys helper`

Generate a tiny TypeScript helper library that agents import to talk to the gnosys sandbox directly. Pairs with `gnosys sandbox start` — agents call gnosys.add()/recall() like normal code instead of issuing MCP tool calls. Run `gnosys helper generate` in your agent

## `gnosys generate`

Generate a gnosys-helper.ts file in the current directory (or specified directory)

## `gnosys trace <directory>`

Trace a codebase and store procedural

## `gnosys reflect <outcome>`

Reflect on an outcome to update memory confidence and create relationships

## `gnosys traverse <memoryId>`

Traverse relationship chains starting from a memory (BFS, depth-limited)

## `gnosys web`

Web Knowledge Base — generate searchable knowledge from websites

## `gnosys init`

Interactive setup for web knowledge base

## `gnosys ingest`

Crawl the configured source and generate knowledge markdown files

## `gnosys build-index`

Generate search index JSON from the knowledge directory

## `gnosys build`

Run ingest + build-index in one shot

## `gnosys add <url>`

Ingest a single URL into the knowledge base

## `gnosys remove <filepath>`

Remove a knowledge file and rebuild the index

## `gnosys update <urlOrPath>`

Re-ingest a URL or refresh a knowledge file, then rebuild the index

## `gnosys status`

Show the current state of the web knowledge base
