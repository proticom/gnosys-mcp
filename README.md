<p align="center">
  <img src="docs/logo.svg" alt="Gnosys" width="200">
</p>

<p align="center"><strong>LLM-native persistent memory for AI agents.</strong></p>

---

Gnosys gives AI agents long-term memory that survives across sessions. Memories are atomic markdown files with structured frontmatter, stored in plain directories, versioned by git, and searchable via FTS5. No database, no vector store, no external services — just files.

Gnosys works as an MCP server (for Cursor, Claude Desktop, or any MCP-compatible agent) and as a standalone CLI.

## Quick Start

```bash
# Install globally from npm
npm install -g gnosys-mcp

# Initialize a store in your project
cd /path/to/your/project
gnosys init

# Add your first memory
gnosys add "We decided to use PostgreSQL for the main database because of its JSON support and mature ecosystem"

# Find memories later
gnosys discover "database selection"
```

## How It Works

A Gnosys store is a `.gnosys/` directory inside your project. It contains markdown files organized by category:

```
your-project/
  .gnosys/
    decisions/
      use-postgresql.md
      jwt-over-sessions.md
    architecture/
      three-layer-design.md
    concepts/
      memory-decay.md
    .gnosys/          # internal config
      tags.json       # tag registry
      reinforcement.log
    CHANGELOG.md
```

Each memory is a markdown file with YAML frontmatter:

```yaml
---
id: deci-001
title: "Use PostgreSQL for Main Database"
category: decisions
tags:
  domain: [database, backend]
  type: [decision]
relevance: "database selection postgres sql json storage persistence"
author: human+ai
authority: declared
confidence: 0.9
created: 2026-03-01
modified: 2026-03-01
status: active
supersedes: null
---

# Use PostgreSQL for Main Database

We chose PostgreSQL over MySQL and SQLite because...
```

Key fields:

- **relevance**: A keyword cloud that powers `discover`. Describe the contexts where this memory would be useful.
- **confidence**: 0–1 score. How certain is this knowledge? Observations might be 0.6; declared decisions are 0.9.
- **authority**: Who established this? `declared` (human decided), `observed` (AI noticed), `imported` (from external source), `inferred` (AI deduced).
- **status**: `active`, `archived`, or `superseded`. Superseded memories link to their replacement via `superseded_by`.

## Using with Obsidian

A Gnosys store is a valid Obsidian vault. Open your `.gnosys/` directory in Obsidian and you get full browsing, graph view, tag filtering, and search — with zero configuration. This is the recommended way for humans to browse and explore the knowledge base.

1. Open Obsidian
2. Click "Open folder as vault"
3. Select your project's `.gnosys/` directory
4. Browse, search, and explore your memories visually

Edits made in Obsidian are picked up automatically by Gnosys (the filesystem is the source of truth).

## CLI Reference

Install globally or run via `npx`:

```bash
# Global install
npm install -g gnosys-mcp

# Or run from the project
npm run build
node dist/cli.js <command>
```

### Core Commands

**`gnosys init [--directory <dir>]`**
Initialize a new `.gnosys` store. Creates the directory structure, default tag registry, and a git repository.

**`gnosys add <input> [--author human|ai|human+ai] [--authority declared|observed] [--store project|personal|global]`**
Add a memory using natural language. An LLM structures your input into an atomic memory with proper frontmatter, category, and tags. Requires `ANTHROPIC_API_KEY`.

**`gnosys add-structured --title <title> --category <category> --content <content> [--tags <json>] [--relevance <keywords>] [--confidence <n>]`**
Add a memory with explicit fields. No LLM needed — you provide the structure directly.

**`gnosys discover <query> [--limit <n>]`**
Find relevant memories by keyword. Searches relevance clouds, titles, and tags. Returns metadata only (no file contents). This is the primary entry point for agents starting a task.

**`gnosys search <query> [--limit <n>]`**
Full-text search across all memories. Returns matching paths with context snippets.

**`gnosys read <path>`**
Read a specific memory. Supports layer-prefixed paths: `project:decisions/auth.md`.

**`gnosys list [--category <cat>] [--tag <tag>] [--store <store>]`**
List all memories, optionally filtered.

**`gnosys update <path> [--title <t>] [--status active|archived|superseded] [--confidence <n>] [--relevance <kw>] [--supersedes <id>] [--superseded-by <id>] [--content <md>]`**
Update a memory's frontmatter or content. Handles supersession cross-linking automatically.

**`gnosys reinforce <memoryId> --signal useful|not_relevant|outdated [--context <why>]`**
Signal whether a memory was helpful. `useful` resets decay; `not_relevant` logs routing feedback; `outdated` flags for review.

**`gnosys stale [--days <n>] [--limit <n>]`**
Find memories not modified within N days (default: 90). Useful for periodic review.

**`gnosys commit-context <context> [--dry-run] [--store <store>]`**
Extract atomic memories from a conversation context. Checks existing memories for duplicates — only adds what's genuinely new. Use `--dry-run` to preview without writing. Requires `ANTHROPIC_API_KEY`.

**`gnosys tags`**
List all tags in the registry, grouped by category.

**`gnosys tags-add --category <cat> --tag <tag>`**
Add a new tag to the registry.

**`gnosys stores`**
Show all active stores with their layers, paths, and write permissions.

**`gnosys serve`**
Start the MCP server in stdio mode (used by editors and agent runtimes).

### Getting Help

```bash
gnosys --help              # List all commands
gnosys help <command>      # Detailed help for a command
gnosys <command> --help    # Same as above
```

## MCP Server Setup

### Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json` in your project or global config):

```json
{
  "mcpServers": {
    "gnosys": {
      "command": "node",
      "args": ["/path/to/gnosys-mcp/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key-here"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent config on your platform:

```json
{
  "mcpServers": {
    "gnosys": {
      "command": "node",
      "args": ["/path/to/gnosys-mcp/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key-here"
      }
    }
  }
}
```

### MCP Tools

The MCP server exposes the same operations as the CLI:

| Tool | Description |
|------|-------------|
| `gnosys_discover` | Find relevant memories by keyword |
| `gnosys_read` | Read a specific memory |
| `gnosys_search` | Full-text search across stores |
| `gnosys_list` | List memories with optional filters |
| `gnosys_add` | Add a memory (LLM-structured) |
| `gnosys_add_structured` | Add a memory (explicit fields) |
| `gnosys_update` | Update frontmatter or content |
| `gnosys_reinforce` | Signal usefulness of a memory |
| `gnosys_stale` | Find stale memories |
| `gnosys_commit_context` | Extract and commit memories from context |
| `gnosys_tags` | List tag registry |
| `gnosys_tags_add` | Add a tag to the registry |
| `gnosys_init` | Initialize a new store |
| `gnosys_stores` | Show active stores |

## Layered Stores

Gnosys supports multiple stores stacked in precedence order, so project-specific knowledge can override personal defaults, which can override shared organizational knowledge.

| Layer | Source | Writable | Use Case |
|-------|--------|----------|----------|
| **Project** | `.gnosys/` in project root | Yes (default) | Project-specific decisions and architecture |
| **Optional** | `GNOSYS_STORES` env var | Read-only | Shared reference knowledge |
| **Personal** | `GNOSYS_PERSONAL` env var | Yes (fallback) | Cross-project personal knowledge |
| **Global** | `GNOSYS_GLOBAL` env var | Explicit only | Organization-wide shared knowledge |

Writes go to the project store by default. Global writes require `--store global` to prevent accidental changes to shared knowledge.

### Environment Variables

```bash
# Optional: API key for LLM-powered features (add, commit-context)
export ANTHROPIC_API_KEY="sk-ant-..."

# Optional: Personal knowledge store (cross-project)
export GNOSYS_PERSONAL="$HOME/.gnosys-personal"

# Optional: Organization-wide shared knowledge
export GNOSYS_GLOBAL="/shared/team/.gnosys"

# Optional: Additional read-only stores (colon-separated)
export GNOSYS_STORES="/path/to/store1:/path/to/store2"
```

You can also place your API key in `~/.config/gnosys/.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Agent Integration Guide

### Recommended Agent Workflow

1. **Start of session**: Call `gnosys_discover` with keywords about the current task to load relevant context.
2. **During work**: When making decisions or learning something new, call `gnosys_add` to persist it.
3. **When things change**: Use `gnosys_update` with `supersedes` to create clean revision chains.
4. **End of session**: Call `gnosys_commit_context` with a summary of the conversation to extract and persist novel knowledge before context is lost.

### Memory Quality Tips

- Write **atomic memories** — one decision, fact, or insight per file.
- Use **specific relevance keywords** — think about what someone would search for to find this memory.
- Set **confidence scores honestly** — a hunch is 0.5, a firm decision is 0.9.
- Use **supersession** instead of editing — when a decision changes, create a new memory that `supersedes` the old one. This preserves the history of why things changed.

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run test suite (32 tests)
npm run test:watch   # Run tests in watch mode
npm run dev          # Run MCP server in dev mode (tsx)
```

### Architecture

```
src/
  index.ts          # MCP server — exposes all tools
  cli.ts            # CLI — thin wrapper around core modules
  lib/
    store.ts        # Core: read/write/update memory files
    search.ts       # FTS5 search and discovery
    tags.ts         # Tag registry management
    ingest.ts       # LLM-powered structuring of raw input
    resolver.ts     # Layered multi-store resolution
```

## License

MIT
