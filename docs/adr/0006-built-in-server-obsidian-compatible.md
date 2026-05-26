# ADR-0006: Built-in Server + Obsidian-Compatible

- Status: Accepted
- Date: 2026-03-04
- Memory: dec-011

## Context

The wiki/view layer must serve casual users who want zero-setup browsing and power users who already live in Obsidian or other markdown tools. Forcing one UI would leave either audience underserved.

## Decision

Both. `gnosys serve` provides a minimal built-in web UI on the same process as the MCP server. Human-readable views use Obsidian-compatible markdown — YAML frontmatter, wikilinks, standard directories — produced on export rather than as the live write path (see ADR-0005).

## Consequences

- Casual users get browse/search/edit without installing Obsidian.
- Power users open an exported vault in Obsidian with no special Gnosys plugin required.
- Search in the built-in UI reuses the same FTS5 index as CLI/MCP.
- File format constraints apply to export output: Gnosys-specific metadata must stay expressible in standard markdown + YAML.
- Zero extra services for the web UI — it runs wherever Gnosys already runs.
