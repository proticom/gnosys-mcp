# MCP Tools

_Generated from `src/index.ts` by `scripts/gen-mcp-tools.mjs`. Do not edit by hand._

| Tool | Description |
|------|-------------|
| `gnosys_add` | Add a new memory. Accepts raw text — an LLM structures it into an atomic memory. Writes to the project store by default. Use store='personal' for cross-project knowledge, or store='global' to explicitly write to shared org knowledge. |
| `gnosys_add_structured` | Add a memory with structured input (no LLM needed). Writes to the project store by default. Use store='global' to explicitly write to shared org knowledge. |
| `gnosys_ask` | Ask a natural-language question and get a synthesized answer with citations from the entire vault. Uses hybrid search to find relevant memories, then LLM to synthesize a cited response. Citations are Obsidian wikilinks [[filename.md]]. Requires an LLM provider (Anthropic or Ollama) and embeddings (run gnosys_reindex first). |
| `gnosys_audit` | View the audit trail of all memory operations (reads, writes, reinforcements, dearchives, maintenance). Shows a timeline of what happened and when. Useful for debugging 'why did the agent forget X?' |
| `gnosys_bootstrap` | Batch-import existing documents from a directory into the memory store. Scans for markdown files and creates memories. Use dry_run=true to preview. |
| `gnosys_briefing` | Generate a project briefing — a summary of memory state, categories, recent activity, and top tags. Use for dream mode pre-computation or quick project status. |
| `gnosys_commit_context` | Pre-compaction memory sweep. Call this before context is lost (e.g., before a long conversation compacts). Extracts important decisions, facts, and insights from the conversation and commits novel ones to memory. Checks existing memories to avoid duplicates — only adds what's genuinely new or augments what's changed. |
| `gnosys_dashboard` | Show the Gnosys system dashboard: memory counts, maintenance health, graph stats, LLM provider status. Returns structured JSON. |
| `gnosys_dearchive` | Force-dearchive memories from archive.db back to active. Search the archive for memories matching a query, then restore them to the active layer. Used when you need specific archived knowledge that wasn't auto-dearchived by search/ask. |
| `gnosys_detect_ambiguity` | Check if a query matches memories in multiple projects. Use before write operations to confirm the target project when ambiguity exists. |
| `gnosys_discover` | Discover relevant memories by describing what you're working on. Searches relevance keyword clouds across all stores. Returns lightweight metadata (title, path, relevance keywords) — NO file contents. Use gnosys_read to load specific memories you need. Call this FIRST when starting a task to find what Gnosys knows. |
| `gnosys_dream` | Run a Dream Mode cycle — idle-time consolidation that decays confidence, generates category summaries, discovers relationships, and creates review suggestions. NEVER deletes memories. Safe to run anytime. |
| `gnosys_export` | Export gnosys.db to Obsidian-compatible vault — atomic Markdown files with YAML frontmatter, [[wikilinks]], category summaries, and relationship graph. One-way export, never modifies gnosys.db. |
| `gnosys_federated_search` | Search across all scopes (project → user → global) with tier boosting. Results from the current project rank highest. Returns score breakdown showing which boosts were applied. |
| `gnosys_graph` | Show the full cross-reference graph across all memories. Reveals clusters, orphaned links, and the most-connected memories. |
| `gnosys_history` | View audit history for a memory. Shows what changed and when based on the audit log. |
| `gnosys_hybrid_search` | Search memories using hybrid keyword + semantic search with Reciprocal Rank Fusion. Combines FTS5 keyword matching with embedding-based semantic similarity for best results. Run gnosys_reindex first if embeddings don't exist yet. |
| `gnosys_import` | Bulk import structured data (CSV, JSON, JSONL) into Gnosys memories. Map source fields to title/category/content/tags/relevance. Use mode='llm' for smart ingestion with keyword clouds, or 'structured' for fast direct mapping. For large datasets (>100 records with LLM), the CLI is recommended: gnosys import <file> |
| `gnosys_ingest_file` | Ingest a file (PDF, DOCX, TXT, MD) into Gnosys memory. Extracts text, splits into chunks, and creates atomic memories. Supports LLM-powered structuring or fast structured mode. |
| `gnosys_init` | Initialize Gnosys in a project directory. Creates .gnosys/ with project identity (gnosys.json), registers the project in the central DB (~/.gnosys/gnosys.db), and sets up tag registry. You MUST run this before any other Gnosys tool in a new project. Pass the full absolute path to the project root. |
| `gnosys_lens` | Filtered view of memories. Combine criteria to focus on specific subsets — e.g., 'active decisions about auth with confidence > 0.8'. Use AND (default) to require all criteria, or OR to match any. |
| `gnosys_links` | Show wikilinks for a specific memory — outgoing [[links]] and backlinks from other memories. Obsidian-compatible [[Title]] and [[path\|display]] syntax. |
| `gnosys_list` | List memories across all stores, optionally filtered by category, tag, or store layer. |
| `gnosys_maintain` | Run vault maintenance: detect duplicate memories, apply confidence decay, consolidate similar memories. Use --dry-run mode first to see what would change. Requires embeddings (run gnosys_reindex first). |
| `gnosys_migrate` | Migrate a Gnosys store (.gnosys/) from one directory to another. Updates the project name, working directory, and central DB registration. Use this when a project has moved or you want to consolidate stores. |
| `gnosys_portfolio` | Portfolio dashboard — shows all registered projects with memory counts, categories, status snapshots, roadmap items, and recent activity. Use for cross-project status overview. |
| `gnosys_preference_delete` | Delete a user preference by key. |
| `gnosys_preference_get` | Get a user preference by key, or list all preferences. |
| `gnosys_preference_set` | Set a user preference. Preferences are stored in the central DB as user-scoped memories. They persist across all projects and are injected into agent rules files on `gnosys sync`. Use this to record workflow conventions, coding standards, tool preferences, etc. |
| `gnosys_read` | Read a specific memory. Accepts a memory ID (e.g., 'arch-012') or layer-prefixed path (e.g., 'project:decisions/why-not-rag.md'). Without a prefix, searches all stores in precedence order. |
| `gnosys_recall` | Fast memory recall — inject relevant memories as context. Returns <gnosys-recall> block. In aggressive mode (default), always returns top memories even at medium relevance. Prefer the gnosys://recall MCP Resource for automatic injection (no tool call needed). |
| `gnosys_reindex` | Rebuild all semantic embeddings from every memory file. Downloads the embedding model (~80 MB) on first run. Required before hybrid/semantic search can be used. Safe to re-run — fully regenerates the index. |
| `gnosys_reindex_graph` | Build or rebuild the wikilink graph (.gnosys/graph.json). Parses all [[wikilinks]] across memories and generates a persistent JSON graph with nodes, edges, and stats. |
| `gnosys_reinforce` | Signal whether a memory was useful. 'useful' reinforces it (resets decay). 'not_relevant' means routing was wrong, not the memory (memory unchanged). 'outdated' flags for review. |
| `gnosys_remote_pull` | Pull remote memory changes to the local database. Uses skip-and-flag for conflicts by default. Call this when the user wants the latest from the remote. |
| `gnosys_remote_push` | Push local memory changes to the remote (NAS) database. Uses skip-and-flag for conflicts by default. Call this when the user has approved pushing local changes. |
| `gnosys_remote_resolve` | Resolve a sync conflict by choosing which version to keep. Use after gnosys_remote_status reveals conflicts. The agent should present the local and remote versions to the user and call this with their choice. |
| `gnosys_remote_status` | Check the status of remote sync (multi-machine). Returns pending pushes, pulls, conflicts, and reachability. Agents should surface this to the user when there are pending changes or conflicts. |
| `gnosys_search` | Search memories by keyword across all stores. Returns matching file paths with relevance snippets. |
| `gnosys_semantic_search` | Search memories using semantic similarity only (no keyword matching). Finds conceptually related memories even without exact keyword matches. Requires embeddings — run gnosys_reindex first. |
| `gnosys_stale` | Find memories that haven't been modified or reviewed within a given number of days. Useful for identifying knowledge that may be outdated. |
| `gnosys_stats` | Summary statistics across all memories — totals by category, status, author, authority, average confidence, and date ranges. |
| `gnosys_stores` | Debug tool — lists all detected Gnosys stores across registered projects, MCP workspace roots, cwd, and environment variables. Shows which store is active and helps diagnose multi-project routing. |
| `gnosys_sync` | Get the current user preferences + project conventions formatted as a GNOSYS:START/GNOSYS:END block. By default returns the block as text only (no disk write). Pass commit_to_disk=true to write it into the detected agent rules file (CLAUDE.md, .cursor/rules/gnosys.mdc) — only do this if the user has explicitly asked to refresh the rules file. Routine session context is already injected via the SessionStart hook (`gnosys recall`); do NOT call this tool after every preference change. |
| `gnosys_tags` | List all tags in the registry, grouped by category. |
| `gnosys_tags_add` | Add a new tag to the registry. |
| `gnosys_timeline` | View memory creation and modification activity over time. Shows how knowledge evolves by grouping memories into time periods. |
| `gnosys_update` | Update an existing memory's frontmatter and/or content. Specify the memory path and the fields to change. |
| `gnosys_update_status` | Get the prompt/template for writing a dashboard-compatible status memory for this project. Returns instructions for creating a landscape memory with the correct heading format so the portfolio dashboard can parse it. Run this, then follow the instructions to analyze and write the status. |
| `gnosys_working_set` | Get the implicit working set — recently modified memories for the current project. These represent the active context and get boosted in federated search. |
