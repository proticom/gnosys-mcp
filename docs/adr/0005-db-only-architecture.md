# ADR-0005: DB-only Architecture (SQLite as Sole Source of Truth)

- Status: Accepted
- Date: 2026-03-28
- Memory: deci-032

## Context

Early Gnosys dual-wrote memories to markdown files and SQLite — a migration bridge from v1 toward centralized storage. By v5, every query path already went through the database; maintaining parallel markdown writes added complexity and doubled write overhead without user benefit.

## Decision

All normal memory writes go directly to SQLite (`~/.gnosys/gnosys.db`). Markdown is not created during operation; it is generated on demand via `gnosys export` for Obsidian and human-readable views.

## Consequences

- Single source of truth simplifies MCP tools, CLI commands, search indexing, and maintenance code.
- ID generation, FTS5 indexing, and list operations read from the central DB instead of scanning `.md` files.
- `gnosys init` no longer scaffolds category folders, CHANGELOG, or a git repo by default.
- Export remains the escape hatch for Obsidian users and portability — one-way, never mutating the DB.
- Legacy git-backed rollback/history paths for markdown files are superseded for DB-only memories; DB audit/history tooling carries that role forward.
