# AGENTS.md

Instructions for AI agents working in the Gnosys codebase.

## What is Gnosys

Gnosys is an open-source persistent memory system for AI agents. It stores structured memories in a central SQLite database and exposes them via MCP (Model Context Protocol) tools and a CLI. Agents use Gnosys to remember decisions, architecture, project status, and context across sessions.

## Quick Reference

```bash
npm run build          # tsc -> dist/
npm test               # vitest run (738 tests, all should pass)
npx tsc --noEmit       # type check without emitting
```

## Architecture

- **Entry points**: `src/index.ts` (MCP server, 50+ tools), `src/cli.ts` (CLI, 30+ commands)
- **DB-only**: Central SQLite at `~/.gnosys/gnosys.db` is the sole source of truth. No markdown files.
- **Search**: FTS5 keyword -> semantic embeddings -> hybrid RRF -> federated cross-project
- **Web KB**: `gnosys/web` subpath export for serverless chatbots (zero native deps at runtime)
- **Portfolio**: `src/lib/portfolio.ts` + `portfolioHtml.ts` for cross-project status dashboard
- **Multi-machine sync (v5.3.0)**: `src/lib/remote.ts` syncs local cache with remote (NAS) DB

## Key Rules

1. **DB-first lookups**: When resolving a memory by ID (e.g. `road-007`), always check `centralDb.getMemory(id)` before falling back to the legacy file resolver.
2. **No markdown writes**: All memory writes go to SQLite only. Markdown is generated on-demand via `gnosys export`.
3. **TypeScript strict**: `strict: true` in tsconfig. Fix all type errors before committing.
4. **Test before commit**: Run `npm test` — all 738 tests must pass. Tests are in `src/test/`.
5. **Path quoting**: The project may live in a path with spaces (iCloud). Always quote paths in shell commands.
6. **Web subpath isolation**: `src/lib/staticSearch.ts` must not import (only `import type`) from modules that depend on `better-sqlite3` or any native addon.
7. **CLI-first, MCP-second**: New features are CLI commands first; MCP tools are thin wrappers around CLI logic.

## Remote Sync Awareness (v5.3.0+)

When the user has configured multi-machine sync (`gnosys_remote_status` returns `configured: true`), be aware of pending changes and conflicts.

### When to check sync state

- At session start, after the user's first gnosys-related operation
- Before significant operations (write spree, multi-step task)
- When the user mentions another machine or "syncing" or "the NAS"

### How to handle the response

Call `gnosys_remote_status`. The response includes:
- `pendingPush`, `pendingPull` — counts of changes in each direction
- `conflicts` — array of memory IDs with true conflicts (modified on both sides since last sync)
- `queuedWrites` — local writes waiting because NAS was unreachable
- `reachable` — whether the remote can be reached right now
- `message` — a short human-readable summary

### Surfacing to the user

**Don't surface for:**
- `pendingPush > 0` only — auto-syncing in background, mention only if user asks
- `pendingPull > 0` only — agent can call `gnosys_remote_pull` autonomously after notifying user briefly
- `reachable: false` — if user knows they're offline, don't bug them

**Do surface for:**
- `conflicts.length > 0` — true conflicts need user decision. Present each: "Memory deci-007 was edited on both your laptop and the NAS. Want to keep local, remote, or merge?"
- Large pending changes after long offline period (e.g. `pendingPush + pendingPull > 20`)
- First operation after a notable event (returning from travel, new machine)

### Conflict resolution flow

1. List conflicts to the user with `local_modified` vs `remote_modified` timestamps
2. For each conflict, optionally fetch and show both versions (titles + key content differences)
3. Make a recommendation if the difference is clear (e.g. "remote is more recent and more detailed")
4. Call `gnosys_remote_resolve(memoryId, choice)` with the user's decision
5. Confirm completion

## Memory System

This project uses Gnosys for its own memory. When working here:

- Call `gnosys_discover` at task start to find relevant context
- Write decisions to `gnosys_add_structured` with category `decisions`
- After significant work, run `gnosys update-status` to refresh the project status
- Use `gnosys status` to check current readiness and blockers

## Commit Convention

Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`. Include `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` in commit messages.
