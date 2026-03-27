<p align="center">
  <img src="docs/logo.svg" alt="Gnosys" width="200">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/gnosys"><img src="https://img.shields.io/npm/v/gnosys.svg" alt="npm version"></a>
  <a href="https://github.com/proticom/gnosys/actions"><img src="https://github.com/proticom/gnosys/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-558%20passing-brightgreen" alt="tests">
  <img src="https://img.shields.io/badge/coverage-lib%2040%25%20|%20sandbox%2045%25-yellow" alt="coverage">
  <a href="https://gnosys.ai"><img src="https://img.shields.io/badge/docs-gnosys.ai-C04C4C" alt="docs"></a>
  <a href="https://gnosys.ai/guide.html"><img src="https://img.shields.io/badge/user%20guide-gnosys.ai%2Fguide-555560" alt="user guide"></a>
  <a href="https://github.com/proticom/gnosys/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/gnosys.svg" alt="license"></a>
</p>

---

### Gnosys — One Brain. Zero Context Bloat.

**Gnosys** gives AI agents persistent memory that survives across sessions, projects, and machines.

Gnosys is **sandbox-first**: a persistent background process holds the database connection while agents import a tiny helper library and call memory operations like normal code — no MCP schemas, no round-trips, near-zero context cost. The central brain at `~/.gnosys/gnosys.db` unifies all projects, user preferences, and global knowledge. Federated search ranks results across scopes with tier boosting and recency awareness. In v4.0, the **Web Knowledge Base** turns any website into a searchable knowledge base for serverless chatbots — pre-computed JSON index, zero runtime dependencies. Process tracing builds call chains from source code. Dream Mode consolidates knowledge during idle time. One-command export regenerates a full Obsidian vault.

It also runs as a CLI and a complete MCP server that drops straight into Cursor, Claude Desktop, Claude Code, Cowork, Codex, or any MCP client.

No vector DBs. No black boxes. No external services. Just SQLite, Markdown, and Obsidian — the way knowledge should be.

---

## Why Gnosys?

Most "memory for LLMs" solutions use vector databases, embeddings, or proprietary services. They're opaque — you can't see what the model remembers, can't edit it, can't version it, can't share it.

Gnosys takes a different approach: the central brain is a single SQLite database (`~/.gnosys/gnosys.db`) with sub-10ms reads, while every memory is also dual-written as a plain Markdown file with YAML frontmatter. The Markdown layer is a human-readable safety net and Obsidian export path — you can read it, edit it, grep it, and back it up with the tools you already use.

**What makes it different:**

- **Sandbox-first** — persistent background process + helper library. Agents call `gnosys.add()` / `gnosys.recall()` like regular code. No MCP overhead, near-zero context cost.
- **Centralized brain** — single `~/.gnosys/gnosys.db` unifies all projects with `project_id` + `scope` columns. No more per-project silos.
- **Federated search** — tier-boosted search across project (1.5x) > user (1.0x) > global (0.7x) scopes with recency and reinforcement boosts.
- **Web Knowledge Base** — `gnosys web build` turns any website into a searchable knowledge base for serverless chatbots. Powers [Sir Chats-A-Lot](https://sir-chats-a-lot.com).
- **Dream Mode** — idle-time consolidation: confidence decay, self-critique, summary generation, relationship discovery. Never deletes — only suggests reviews.
- **Transparent** — every memory has a human-readable `.md` file alongside the database. Export to Obsidian vault with one command.
- **Hybrid Search** — FTS5 keyword + semantic embeddings via Reciprocal Rank Fusion (RRF).
- **Multi-project** — MCP roots + per-tool `projectRoot` routing + central project registry. Multiple Cursor windows, zero conflicts.
- **Process tracing** — `gnosys trace <dir>` builds call chains from source code with `leads_to`, `follows_from`, and `requires` relationships.
- **Reflection API** — `gnosys.reflect(outcome)` updates confidence and consolidates memories based on real-world outcomes.
- **Bulk import** — CSV, JSON, JSONL. Import entire datasets in seconds.
- **Obsidian-native** — `gnosys export` generates a full vault with YAML frontmatter, `[[wikilinks]]`, summaries, and graph data.
- **MCP-compatible** — also runs as a full MCP server that drops into Cursor, Claude Desktop, Claude Code, Cowork, Codex, or any MCP client.
- **Zero infrastructure** — no external databases, no Docker (unless you want it), no cloud services. Just `npm install`.

> For the complete CLI reference and detailed guides, see the **[User Guide](https://gnosys.ai/guide.html)**.

---

## Quick Start

```bash
# 1. Install globally
npm install -g gnosys

# 2. Run the setup wizard (configures provider, API key, and IDE)
gnosys setup

# 3. Initialize a project
cd your-project
gnosys init

# 4. Start adding memories
gnosys add "We chose PostgreSQL over MySQL for its JSON support"
gnosys recall "database selection"
```

> **Postinstall hook:** After `npm install -g gnosys`, a postinstall script automatically runs `gnosys setup` if no configuration is detected, so first-time users are guided through provider and IDE setup immediately.

> **Multi-machine?** Set `GNOSYS_GLOBAL` to a cloud-synced folder (iCloud Drive, Dropbox, OneDrive) and both machines share the same brain. After updating, run `gnosys upgrade` — it re-syncs all projects, regenerates agent rules, and warns other machines to upgrade too. See the [User Guide — Installation & Setup](https://gnosys.ai/guide.html#guide-installation) for the full walkthrough, memory scopes, and multi-machine setup.

### Agent / Helper Library

```ts
import { gnosys } from "./gnosys-helper";   // generated once via: gnosys helper generate

await gnosys.add("We use conventional commits");
const ctx = await gnosys.recall("auth decisions");
await gnosys.reinforce("payment logic");
```

The helper auto-starts the sandbox if it's not running. No MCP required.

---

## Web Knowledge Base

Turn any website into a searchable knowledge base for AI chatbots. No database required. Works on Vercel, Netlify, Cloudflare Pages, or any platform that can serve files.

### Quick Start

```bash
cd your-nextjs-site
npm install -g gnosys
gnosys init
gnosys web init
# Edit gnosys.json to set your sitemapUrl
gnosys web build
# Add to package.json: "postbuild": "gnosys web build"
```

### How It Works

```
DEVELOPMENT TIME (local machine)
─────────────────────────────────
gnosys web init          → scaffolds /knowledge/ dir, adds config to gnosys.json
gnosys web ingest        → crawls site → converts to markdown → writes /knowledge/*.md
gnosys web build-index   → reads /knowledge/*.md → produces /knowledge/gnosys-index.json
gnosys web build         → runs ingest + build-index in one shot

All files committed to git. Deployed with the app.

RUNTIME (serverless / any host)
───────────────────────────────
import { loadIndex, search } from 'gnosys/web'

1. loadIndex('knowledge/gnosys-index.json')     → loads pre-computed index into memory
2. search(index, userMessage, { limit: 6 })     → returns ranked document references
3. Read matched .md files from filesystem         → inject content into LLM prompt
4. Call Claude/GPT/etc with focused context       → respond to user

No SQLite. No database. No network calls for search.
```

### Integration Example (Next.js)

```typescript
// app/api/chat/route.ts
import { loadIndex, search } from 'gnosys/web'
import { readFileSync } from 'fs'
import { join } from 'path'

const index = loadIndex(join(process.cwd(), 'knowledge', 'gnosys-index.json'))

export async function POST(req: Request) {
  const { message } = await req.json()

  const results = search(index, message, { limit: 6 })
  const context = results.map(r =>
    readFileSync(join(process.cwd(), 'knowledge', r.document.path), 'utf8')
  ).join('\n\n---\n\n')

  // Pass context to your LLM of choice
  const response = await callLLM({
    system: `Answer using ONLY the provided context.\n\nContext:\n${context}`,
    message
  })

  return Response.json({ reply: response })
}
```

### Web CLI Commands

| Command | Description |
|---------|-------------|
| `gnosys web init` | Scaffold knowledge directory and config |
| `gnosys web ingest` | Crawl source and generate knowledge markdown |
| `gnosys web build-index` | Generate search index from knowledge files |
| `gnosys web build` | Run ingest + build-index in one shot |
| `gnosys web add <url>` | Ingest a single URL |
| `gnosys web remove <path>` | Remove a knowledge file and rebuild index |
| `gnosys web status` | Show knowledge base status |

### Configuration

Add to `gnosys.json`:

```json
{
  "web": {
    "source": "sitemap",
    "sitemapUrl": "https://yoursite.com/sitemap.xml",
    "outputDir": "./knowledge",
    "exclude": ["/api", "/admin", "/_next"],
    "categories": {
      "/blog/*": "blog",
      "/services/*": "services",
      "/products/*": "products",
      "/about*": "company"
    },
    "llmEnrich": true,
    "prune": false
  }
}
```

### The `/knowledge/` Directory

`gnosys web build` generates a `/knowledge/` directory containing:

- **Markdown files** — one per page, with YAML frontmatter (title, category, tags, relevance keywords, source URL, content hash)
- **`gnosys-index.json`** — pre-computed TF-IDF inverted index for sub-5ms in-memory search
- All files commit to git and deploy with your app — the knowledge base and the site are always in sync

This directory is the bridge between your website content and any AI system. [Sir Chats-A-Lot](https://sir-chats-a-lot.com) uses it to power website chatbots with zero infrastructure.

### Generative Engine Optimization (GEO)

The `/knowledge/` markdown files double as a structured content layer for AI crawlers and LLM-powered search engines. To make your knowledge base discoverable:

1. Add a [`llms.txt`](https://llmstxt.org/) file to your site root pointing to the knowledge directory
2. Reference individual markdown files in your `llms.txt` for fine-grained content exposure
3. YAML frontmatter provides structured metadata (title, category, tags) that LLMs can parse directly

This improves your site's visibility in AI-powered search results and enables LLMs to cite your content accurately.

### SQLite vs Web Mode

| Aspect | SQLite (default) | Web Knowledge Base |
|--------|------------------|--------------------|
| Storage | Central `~/.gnosys/gnosys.db` | Markdown files in repo |
| Search | FTS5 + optional embeddings | Pre-computed inverted index |
| Write support | Full CRUD | Read-only (build-time only) |
| Infrastructure | None (embedded SQLite) | None (files deploy with app) |
| Best for | Local agents, MCP, CLI | Web chatbots, serverless |
| Search latency | <10ms | <5ms (in-memory index) |
| Supports Dream Mode | Yes | No (read-only) |

---

## MCP Server Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gnosys": {
      "command": "gnosys",
      "args": ["serve"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gnosys": {
      "command": "gnosys",
      "args": ["serve"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add gnosys gnosys serve
```

### Codex

Add to `.codex/config.toml`:

```toml
[mcp.gnosys]
type = "local"
command = ["gnosys", "serve"]
```

> **Note:** API keys are configured via `gnosys setup` (macOS Keychain, environment variable, or `~/.config/gnosys/.env`). See [LLM Provider Setup](https://gnosys.ai/guide.html#guide-llm-provider-setup) in the User Guide.

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `gnosys_discover` | Find relevant memories by keyword (start here) |
| `gnosys_read` | Read a specific memory |
| `gnosys_search` | Full-text search across stores |
| `gnosys_hybrid_search` | Hybrid keyword + semantic search (RRF fusion) |
| `gnosys_semantic_search` | Semantic similarity search (embeddings) |
| `gnosys_ask` | Ask a question, get a synthesized answer with citations |
| `gnosys_reindex` | Rebuild semantic embeddings from all memories |
| `gnosys_list` | List memories with optional filters |
| `gnosys_lens` | Filtered views — combine category, tag, status, confidence, date filters |
| `gnosys_add` | Add a memory (LLM-structured) |
| `gnosys_add_structured` | Add with explicit fields (no LLM) |
| `gnosys_update` | Update frontmatter or content |
| `gnosys_reinforce` | Signal usefulness of a memory |
| `gnosys_commit_context` | Extract memories from conversation context |
| `gnosys_bootstrap` | Batch-import existing markdown documents |
| `gnosys_import` | Bulk import from CSV, JSON, or JSONL |
| `gnosys_init` | Initialize a new store |
| `gnosys_stale` | Find memories not modified within N days |
| `gnosys_history` | Git-backed version history for a memory |
| `gnosys_rollback` | Rollback a memory to a previous commit |
| `gnosys_timeline` | Show when memories were created/modified over time |
| `gnosys_stats` | Summary statistics for the memory store |
| `gnosys_links` | Show wikilinks and backlinks for a memory |
| `gnosys_graph` | Full cross-reference graph across all memories |
| `gnosys_maintain` | Run vault maintenance (decay, dedup, consolidation, archiving) |
| `gnosys_dearchive` | Force-dearchive memories from archive back to active |
| `gnosys_dashboard` | System dashboard (memory count, health, archive, graph, LLM status) |
| `gnosys_reindex_graph` | Build/rebuild the wikilink graph |
| `gnosys_dream` | Run a Dream Mode cycle (decay, self-critique, summaries, relationships) |
| `gnosys_export` | Export gnosys.db to an Obsidian-compatible vault |
| `gnosys_recall` | Fast memory injection for agent orchestrators (sub-50ms) |
| `gnosys_audit` | View structured audit trail of all memory operations |
| `gnosys_stores` | Show active stores, MCP roots, and detected project stores |
| `gnosys_tags` | List tag registry |
| `gnosys_tags_add` | Add a new tag to the registry |
| **Centralized Brain** | |
| `gnosys_projects` | List all registered projects in the central DB |
| `gnosys_backup` | Create a point-in-time backup of the central DB |
| `gnosys_restore` | Restore the central DB from a backup |
| `gnosys_migrate_to_central` | Migrate project data into the central DB |
| `gnosys_preference_set` | Set a user preference (stored as scoped memory) |
| `gnosys_preference_get` | Get one or all preferences |
| `gnosys_preference_delete` | Delete a preference |
| `gnosys_sync` | Regenerate agent rules file from preferences + conventions |
| `gnosys_federated_search` | Tier-boosted search across project > user > global scopes |
| `gnosys_detect_ambiguity` | Check if a query matches multiple projects |
| `gnosys_briefing` | Generate project briefing (categories, activity, tags, summary) |
| `gnosys_working_set` | Get recently modified memories for the current project |

---

## Key Features

### Central Brain

All memories live in a single `~/.gnosys/gnosys.db` with `project_id` and `scope` columns. Every write is dual-written to both SQLite and a human-readable `.md` file. Sub-10ms reads, WAL mode for concurrent access. See the [User Guide](https://gnosys.ai/guide.html) for the full schema and memory format.

### LLM Providers

Eight providers behind a single interface — switch between cloud and local with one command:

| Provider | Type | Default Model | API Key Env Var |
|----------|------|---------------|-----------------|
| **Anthropic** | Cloud | claude-sonnet-4-6 | `GNOSYS_ANTHROPIC_KEY` |
| **Ollama** | Local | llama3.2 | — (runs locally) |
| **Groq** | Cloud | llama-3.3-70b-versatile | `GNOSYS_GROQ_KEY` |
| **OpenAI** | Cloud | gpt-5.4-mini | `GNOSYS_OPENAI_KEY` |
| **LM Studio** | Local | default | — (runs locally) |
| **xAI** | Cloud | grok-4.20 | `GNOSYS_XAI_KEY` |
| **Mistral** | Cloud | mistral-small-4 | `GNOSYS_MISTRAL_KEY` |
| **Custom** | Any | (user-defined) | `GNOSYS_CUSTOM_KEY` |

> Model lists and pricing are fetched dynamically from [OpenRouter](https://openrouter.ai) during `gnosys setup` and cached for 24 hours. Bundled defaults are used when offline.

> **API Key Security:** `gnosys setup` offers three storage options: macOS Keychain (recommended — encrypted, no plaintext), environment variable (shell profile), or `~/.config/gnosys/.env` (least secure). Legacy env var names (`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, etc.) are still supported for backward compatibility.

Route tasks to different providers — a cheap model for structuring, a powerful model for synthesis:

```json
{
  "llm": {
    "defaultProvider": "anthropic",
    "anthropic": { "model": "claude-sonnet-4-6" },
    "ollama": { "model": "llama3.2", "baseUrl": "http://localhost:11434" }
  },
  "taskModels": {
    "structuring": { "provider": "ollama", "model": "llama3.2" },
    "synthesis": { "provider": "anthropic", "model": "claude-sonnet-4-6" }
  }
}
```

### Dream Mode

Idle-time consolidation inspired by biological memory: confidence decay, self-critique, summary generation, and relationship discovery. Runs automatically when the sandbox is idle, or manually with `gnosys dream`. Never deletes — only flags for review. See the [User Guide](https://gnosys.ai/guide.html) for configuration and scheduling.

### Federated Search

All search commands support `--federated` to search across project (1.5x boost), user (1.0x), and global (0.7x) scopes in the central DB. Recency adds a 1.3x boost, reinforcement count adds up to 25%. Results include `scope` and `boosts` fields so agents know where each memory came from. See the [User Guide](https://gnosys.ai/guide.html) for details.

### Process Tracing

`gnosys trace ./src` scans TypeScript/JavaScript files, extracts function declarations and call sites, then stores each as a procedural "how" memory with `leads_to`, `follows_from`, and `requires` relationships. `gnosys traverse <id>` walks relationship chains via BFS with depth limiting and type filtering. See the [User Guide](https://gnosys.ai/guide.html) for details.

### Obsidian Export

The primary store is the central `gnosys.db`. Use the Obsidian Export Bridge to generate a full vault:

```bash
gnosys export --to ~/vaults/my-project
gnosys export --to ~/vaults/my-project --overwrite
gnosys export --to ~/vaults/my-project --all   # summaries, reviews, graph data
```

### Bulk Import

Import any structured dataset into atomic memories:

```bash
# JSON with field mapping
gnosys import foods.json --format json \
  --mapping '{"description":"title","foodCategory":"category","notes":"content"}' \
  --mode structured

# CSV
gnosys import data.csv --format csv \
  --mapping '{"name":"title","type":"category","notes":"content"}'

# JSONL (one record per line)
gnosys import events.jsonl --format jsonl \
  --mapping '{"event":"title","type":"category","details":"content"}'
```

---

## Comparison

| Aspect | Plain Markdown | RAG (Vector DB) | Knowledge Graph | **Gnosys** |
|--------|---------------|-----------------|-----------------|-----------|
| **Examples** | CLAUDE.md, .cursorrules | Mem0, LangChain Memory | Graphiti/Zep, Mem0 Graph | — |
| **Storage** | `.md` files | Embeddings in vector DB | Nodes/edges in graph DB | Unified SQLite DB + `.md` dual-write |
| **Transparency** | Perfect | Lossy (embeddings) | High (query nodes) | High (SQLite + dual-write `.md` + Obsidian export) |
| **Version history** | Git native | None built-in | None built-in | Dual-write `.md` files (optional Git) |
| **Keyword search** | Manual / grep | BM25 layer (some) | BM25 layer (some) | FTS5 (built-in) |
| **Semantic search** | None | Vector similarity | Graph + vectors | Vector + FTS5 hybrid (RRF) |
| **Relationship traversal** | None | None | Multi-hop graph queries | Wikilinks (manual encoding) |
| **Scale comfort zone** | ~5K memories | 100K+ | 100K+ | 100K+ (unified SQLite + archive tier) |
| **Setup time** | < 5 min | 30 min - 2 hours | 4 - 8 hours | 15 - 30 min |
| **Infrastructure** | None | Vector DB + embeddings API | Graph DB + LLM | SQLite (embedded) |
| **Human editability** | Excellent | Poor (re-embed) | Moderate | Excellent |
| **MCP integration** | Via skill files | Custom server | Mem0 ships MCP | MCP server (included) |
| **Obsidian compatible** | Partially | No | No | Yes (full vault) |
| **Cost** | Free | $0-500+/mo (cloud DB + embeddings) | $250+/mo (Mem0 Pro) or self-host | Free (MIT) |
| **Offline capable** | Yes | Self-hosted only | Self-hosted only | Yes (Ollama/LM Studio) |

---

## CLI Reference

All commands support `--json` for programmatic output. See the [User Guide](https://gnosys.ai/guide.html) for full details.

**Getting started:** `setup`, `init`, `upgrade`

**Memory operations:** `add`, `add-structured`, `commit-context`, `read`, `update`, `reinforce`, `bootstrap`, `import`

**Search:** `discover`, `search`, `hybrid-search`, `semantic-search`, `ask`, `recall`, `fsearch`

**Views & analysis:** `list`, `lens`, `stale`, `timeline`, `stats`, `links`, `graph`, `tags`, `tags-add`, `audit`

**History:** `history`, `rollback`

**Maintenance:** `maintain`, `dearchive`, `dream`, `reindex`, `reindex-graph`

**Export & config:** `export`, `setup`, `config show`, `config set`, `dashboard`, `doctor`, `stores`

**Centralized brain:** `projects`, `backup`, `restore`, `migrate`, `pref set/get/delete`, `sync`, `ambiguity`, `briefing`, `working-set`

**Sandbox:** `sandbox start/stop/status`, `helper generate`

**Web knowledge base:** `web init`, `web ingest`, `web build-index`, `web build`, `web add`, `web remove`, `web status`

**Server:** `serve`, `serve --with-maintenance`

---

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run test suite (558 tests)
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with v8 coverage report
npm run dev          # Run MCP server in dev mode (tsx)
```

558 tests across 35+ files. CI runs on Node 20 + 22 with multi-project scenario testing, network-share simulation, and TypeScript strict checking.

---

## Architecture

```
src/
  index.ts            # MCP server — 50+ tools + gnosys://recall resource
  cli.ts              # CLI — full command suite with --json output
  lib/
    db.ts             # Central SQLite (6-table schema, project_id + scope)
    dbSearch.ts       # Adapter bridging GnosysDB to search interfaces
    dbWrite.ts        # Dual-write helpers (sync .md <-> gnosys.db)
    migrate.ts        # Migration: v1.x -> v2.0 -> central DB
    dream.ts          # Dream Mode engine + idle scheduler
    export.ts         # Obsidian Export Bridge (gnosys.db -> vault)
    federated.ts      # Federated search, ambiguity detection, briefings
    preferences.ts    # User preferences as scoped memories
    rulesGen.ts       # Agent rules generation (GNOSYS:START/END blocks)
    store.ts          # Core: read/write/update memory files (.md)
    search.ts         # FTS5 search and discovery
    embeddings.ts     # Lazy semantic embeddings (all-MiniLM-L6-v2)
    hybridSearch.ts   # Hybrid search with RRF fusion
    ask.ts            # Freeform Q&A with LLM synthesis + citations
    llm.ts            # LLM abstraction (8 providers + setup wizard)
    maintenance.ts    # Auto-maintenance: decay, dedup, archiving
    archive.ts        # Two-tier memory: active <-> archive
    recall.ts         # Ultra-fast recall for agent orchestrators
    audit.ts          # Structured audit logging
    graph.ts          # Persistent wikilink graph
    trace.ts          # Process tracing + reflection
    config.ts         # gnosys.json loader with Zod validation
    resolver.ts       # Layered multi-store resolution + MCP roots
    import.ts         # Bulk import engine (CSV, JSON, JSONL)
    staticSearch.ts   # Zero-dep web search runtime (gnosys/web)
    webIndex.ts       # Build-time inverted index generator
    webIngest.ts      # Site crawler (sitemap -> markdown)
  sandbox/
    server.ts         # Unix socket server + Dream Mode scheduler
    client.ts         # Client for agent connections
    manager.ts        # Process lifecycle management
```

---

## Benchmarks

Real numbers from a 120-memory test vault:

| Metric | Result |
|--------|--------|
| Import 100 records (structured) | 0.6s |
| Cold start (first load) | 0.3s |
| Keyword search (FTS5) | <10ms |
| Hybrid search (keyword + semantic) | ~50ms |
| Reindex 120 embeddings | ~8s (first run downloads ~80 MB model) |
| Maintenance dry-run (120 memories) | ~2s |
| Graph reindex (120 memories) | <1s |
| Storage per memory | ~1 KB `.md` file |
| Embedding storage (120 memories) | ~0.3 MB |
| Test suite | 558 tests, 0 errors |

All benchmarks on Apple M-series hardware, Node.js 20+. Structured imports bypass LLM entirely.

---

## Community & Next Steps

Gnosys is open source (MIT) and actively developed. Here's how to get involved:

**Get started fast:**
- **Cursor template:** Add Gnosys to any Cursor project with one MCP config line (see [MCP Server Setup](#mcp-server-setup))
- **Docker:** `docker build -t gnosys . && docker compose up` for containerized deployment

**Contribute:**
- [GitHub Discussions](https://github.com/proticom/gnosys/discussions) — share ideas, ask questions, show what you've built
- [Issues](https://github.com/proticom/gnosys/issues) — bug reports and feature requests
- PRs welcome — especially for new import connectors, LLM providers, and Obsidian plugins

**What's next:**
- Real-time multi-machine sync (automatic conflict resolution beyond current iCloud/Dropbox support)
- Temporal memory versioning (valid_from / valid_until)
- Cross-session "deep dream" overnight consolidation
- Graph visualization in the dashboard
- Obsidian community plugin for native vault integration
- Docker Hub published image for one-line deployment
- Multimodal memory ingestion (PDFs, images, audio/video transcription)

---

## License

MIT — [LICENSE](LICENSE)
