<p align="center">
  <img src="docs/logo.svg" alt="Gnosys" width="200">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/gnosys"><img src="https://img.shields.io/npm/v/gnosys.svg" alt="npm version"></a>
  <a href="https://github.com/proticom/gnosys/actions"><img src="https://github.com/proticom/gnosys/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://gnosys.ai"><img src="https://img.shields.io/badge/docs-gnosys.ai-C04C4C" alt="docs"></a>
  <a href="https://gnosys.ai/guide.html"><img src="https://img.shields.io/badge/CLI%20reference-gnosys.ai%2Fguide-555560" alt="user guide"></a>
  <a href="https://github.com/proticom/gnosys/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/gnosys.svg" alt="license"></a>
</p>

<p align="center">
  A <a href="https://proticom.com">Proticom</a> product. &nbsp;·&nbsp; <b><a href="https://gnosys.ai">gnosys.ai</a></b> is the source of truth for docs.
</p>

---

# Gnosys — One Brain. Zero Context Bloat.

**Gnosys gives AI agents persistent memory that survives across sessions, projects, and machines.**

The central brain is a single SQLite database at `~/.gnosys/gnosys.db` with sub-10ms reads — no vector DBs, no black boxes, no external services. Federated search ranks results across project, user, and global scopes. It runs as a CLI and as a full MCP server that drops straight into Claude Code, Claude Desktop (Chat / Cowork / Code), Cursor, Codex, Gemini CLI, Antigravity, Grok Build, or any MCP client. When you want a human-readable view, `gnosys export` regenerates a full Obsidian vault on demand.

## Install

```bash
npm install -g gnosys
gnosys setup          # configures provider, API key, and your IDE/agent
```

## Quick start

```bash
cd your-project
gnosys init                                              # register the project
gnosys add "We chose PostgreSQL over MySQL for JSON support"
gnosys recall "database selection"                       # what's relevant right now
gnosys chat                                              # memory-aware terminal chat
```

That's the 60-second tour. **Everything else lives on [gnosys.ai](https://gnosys.ai).**

## What you get

- **Central brain** — one `~/.gnosys/gnosys.db` unifies every project (project / user / global scopes). Sub-10ms reads, SQLite as the sole source of truth.
- **Federated search** — tier-boosted hybrid (FTS5 keyword + semantic) search across scopes, with recency and reinforcement.
- **MCP server** — `gnosys serve` exposes 50+ memory tools to any MCP client. Sandbox-first runtime keeps context cost near zero.
- **Web Knowledge Base** — `gnosys web build` turns any site into a searchable index for serverless chatbots. Zero runtime deps.
- **Dream Mode** — idle-time consolidation: confidence decay, summaries, relationship discovery. Never deletes — only suggests.
- **Multi-machine sync** — share your brain across machines; conflict detection with skip-and-flag resolution.
- **Obsidian export** — `gnosys export` regenerates a full vault with frontmatter, `[[wikilinks]]`, and graph data.

## MCP Tool Reference

All tools are exposed over stdio and HTTP transports. Many tools accept an optional `projectRoot` parameter to target a specific project store.

| Tool | Description |
|------|-------------|
| `gnosys_discover` | Discover relevant memories by describing what you're working on. |
| `gnosys_read` | Read a specific memory. |
| `gnosys_search` | Search memories by keyword across all stores. |
| `gnosys_list` | List memories across all stores, optionally filtered by category, tag, or store layer. |
| `gnosys_add` | Add a new memory. |
| `gnosys_add_structured` | Add a memory with structured input (no LLM needed). |
| `gnosys_tags` | List all tags in the registry, grouped by category. |
| `gnosys_tags_add` | Add a new tag to the registry. |
| `gnosys_reinforce` | Signal whether a memory was useful. |
| `gnosys_init` | Initialize Gnosys in a project directory. |
| `gnosys_migrate` | Migrate a Gnosys store (.gnosys/) from one directory to another. |
| `gnosys_update` | Update an existing memory's frontmatter and/or content. |
| `gnosys_stale` | Find memories that haven't been modified or reviewed within a given number of days. |
| `gnosys_commit_context` | Pre-compaction memory sweep. |
| `gnosys_history` | View version history for a memory. |
| `gnosys_rollback` | Rollback a memory to its state at a specific commit. |
| `gnosys_lens` | Filtered view of memories. |
| `gnosys_timeline` | View memory creation and modification activity over time. |
| `gnosys_stats` | Summary statistics across all memories — totals by category, status, author, authority, average confidence, and date ranges. |
| `gnosys_links` | Show wikilinks for a specific memory — outgoing [[links]] and backlinks from other memories. |
| `gnosys_graph` | Show the full cross-reference graph across all memories. |
| `gnosys_bootstrap` | Batch-import existing documents from a directory into the memory store. |
| `gnosys_import` | Bulk import structured data (CSV, JSON, JSONL) into Gnosys memories. |
| `gnosys_hybrid_search` | Search memories using hybrid keyword + semantic search with Reciprocal Rank Fusion. |
| `gnosys_semantic_search` | Search memories using semantic similarity only (no keyword matching). |
| `gnosys_reindex` | Rebuild all semantic embeddings from every memory file. |
| `gnosys_ask` | Ask a natural-language question and get a synthesized answer with citations from the entire vault. |
| `gnosys_maintain` | Run vault maintenance: detect duplicate memories, apply confidence decay, consolidate similar memories. |
| `gnosys_dearchive` | Force-dearchive memories from archive.db back to active. |
| `gnosys_reindex_graph` | Build or rebuild the wikilink graph (.gnosys/graph.json). |
| `gnosys_dream` | Run a Dream Mode cycle — idle-time consolidation that decays confidence, generates category summaries, discovers relationships, and creates review suggestions. |
| `gnosys_export` | Export gnosys.db to Obsidian-compatible vault — atomic Markdown files with YAML frontmatter, [[wikilinks]], category summaries, and relationship graph. |
| `gnosys_dashboard` | Show the Gnosys system dashboard: memory counts, maintenance health, graph stats, LLM provider status. |
| `gnosys_stores` | Debug tool — lists all detected Gnosys stores across registered projects, MCP workspace roots, cwd, and environment variables. |
| `gnosys_recall` | Fast memory recall — inject relevant memories as context. |
| `gnosys_audit` | View the audit trail of all memory operations (reads, writes, reinforcements, dearchives, maintenance). |
| `gnosys_preference_set` | Set a user preference. |
| `gnosys_preference_get` | Get a user preference by key, or list all preferences. |
| `gnosys_preference_delete` | Delete a user preference by key. |
| `gnosys_sync` | Get the current user preferences + project conventions formatted as a GNOSYS:START/GNOSYS:END block. |
| `gnosys_federated_search` | Search across all scopes (project → user → global) with tier boosting. |
| `gnosys_detect_ambiguity` | Check if a query matches memories in multiple projects. |
| `gnosys_briefing` | Generate a project briefing — a summary of memory state, categories, recent activity, and top tags. |
| `gnosys_portfolio` | Portfolio dashboard — shows all registered projects with memory counts, categories, status snapshots, roadmap items, and recent activity. |
| `gnosys_remote_status` | Check the status of remote sync (multi-machine). |
| `gnosys_remote_push` | Push local memory changes to the remote (NAS) database. |
| `gnosys_remote_pull` | Pull remote memory changes to the local database. |
| `gnosys_remote_resolve` | Resolve a sync conflict by choosing which version to keep. |
| `gnosys_update_status` | Get the prompt/template for writing a dashboard-compatible status memory for this project. |
| `gnosys_working_set` | Get the implicit working set — recently modified memories for the current project. |
| `gnosys_ingest_file` | Ingest a file (PDF, DOCX, TXT, MD) into Gnosys memory. |

## Documentation

| | |
|---|---|
| **Full docs & guides** | <https://gnosys.ai> |
| **Complete CLI + MCP reference** | <https://gnosys.ai/guide.html> |
| **Changelog** | [CHANGELOG.md](./CHANGELOG.md) |
| **Contributing** | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| **Security policy** | [SECURITY.md](./SECURITY.md) |
| **Report a bug / request a feature** | [GitHub Issues](https://github.com/proticom/gnosys/issues) |

## License

MIT © [Proticom](https://proticom.com). See [LICENSE](./LICENSE).
