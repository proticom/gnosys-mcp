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

> **Migrating from `gnosys-mcp`?** The package has been renamed to `gnosys`. Install with `npm install -g gnosys`. All previous versions under `gnosys-mcp` are deprecated.

### Gnosys — One Brain. Zero Context Bloat.

**Gnosys** gives AI agents persistent memory that survives across sessions, projects, and machines.

Gnosys is **sandbox-first**: a persistent background process holds the database connection while agents import a tiny helper library and call memory operations like normal code — no MCP schemas, no round-trips, near-zero context cost. The central brain at `~/.gnosys/gnosys.db` unifies all projects, user preferences, and global knowledge. Federated search ranks results across scopes with tier boosting and recency awareness. In v4.0, the **Web Knowledge Base** turns any website into a searchable knowledge base for serverless chatbots — pre-computed JSON index, zero runtime dependencies. Process tracing builds call chains from source code. Dream Mode consolidates knowledge during idle time. One-command export regenerates a full Obsidian vault.

It also runs as a CLI and a complete MCP server that drops straight into Cursor, Claude Desktop, Claude Code, Cowork, Codex, or any MCP client.

**Beyond agents**: Gnosys turns any structured dataset into a connected, versioned knowledge graph.
• NVD/CVE Database: 200k+ vulnerabilities auto-linked to packages, exploits, patches, and supersession history. Ask "which of our dependencies have active unpatched criticals?"
• USDA FoodData Central: ~8k foods atomized with wikilinks to nutrients and substitutions. Ask "high-protein, low-sodium, high-potassium alternatives to X?"

No vector DBs. No black boxes. No external services. Just SQLite, Markdown, and Obsidian — the way knowledge should be.

---

## Why Gnosys?

Most "memory for LLMs" solutions use vector databases, embeddings, or proprietary services. They're opaque — you can't see what the model remembers, can't edit it, can't version it, can't share it.

Gnosys takes a different approach: the central brain is a single SQLite database (`~/.gnosys/gnosys.db`) with sub-10ms reads, while every memory is also dual-written as a plain Markdown file with YAML frontmatter. The Markdown layer is a human-readable safety net and Obsidian export path — you can read it, edit it, grep it, and back it up with the tools you already use.

**What makes it different:**

- **Sandbox-first** — persistent background process + helper library. Agents call `gnosys.add()` / `gnosys.recall()` like regular code. No MCP overhead, near-zero context cost.
- **Centralized brain** — single `~/.gnosys/gnosys.db` unifies all projects with `project_id` + `scope` columns. No more per-project silos.
- **Federated search** — tier-boosted search across project (1.5x) → user (1.0x) → global (0.7x) scopes with recency and reinforcement boosts.
- **Preferences as memories** — user preferences stored as scoped memories, driving automatic agent rules generation via `gnosys sync`.
- **Project briefings** — instant project status: categories, recent activity, top tags, summary. Dream Mode pre-computes these.
- **Ambiguity detection** — when a query hits multiple projects, Gnosys lists all candidates instead of guessing wrong.
- **Agent-first SQLite** — sub-10ms reads/writes. Markdown files kept as a dual-write safety net.
- **Dream Mode** — idle-time consolidation: confidence decay, self-critique, summary generation, relationship discovery. Never deletes — only suggests reviews.
- **Transparent** — every memory has a human-readable `.md` file alongside the database. Export to Obsidian vault with one command.
- **Multi-project** — MCP roots + per-tool `projectRoot` routing + central project registry. Multiple Cursor windows, zero conflicts.
- **Freeform Ask** — natural-language questions, synthesized answers with Obsidian wikilink citations.
- **Hybrid Search** — FTS5 keyword + semantic embeddings via Reciprocal Rank Fusion (RRF).
- **Dual-write** — every memory writes to both SQLite and a human-readable `.md` file. The Markdown layer is a safety net and export path, not the primary store.
- **Obsidian-native** — `gnosys export` generates a full vault with YAML frontmatter, `[[wikilinks]]`, summaries, and graph data.
- **MCP-compatible** — also runs as a full MCP server that drops into Cursor, Claude Desktop, Claude Code, Cowork, Codex, or any MCP client with one config line.
- **Bulk import** — CSV, JSON, JSONL. Import entire datasets (USDA, NVD, your internal docs) in seconds.
- **Backup & restore** — `gnosys backup` + `gnosys restore` for the central DB. Point-in-time recovery.
- **Reflection API** — `gnosys.reflect(outcome)` updates confidence, adds relationships, and consolidates memories based on real-world outcomes.
- **Process tracing** — `gnosys trace <dir>` builds call chains from source code and stores them as procedural "how" memories with `leads_to`, `follows_from`, and `requires` relationships.
- **Relationship traversal** — `gnosys.traverse(id)` walks relationship chains via BFS with depth limiting and type filtering.
- **Web Knowledge Base (v4.0)** — `gnosys web build` turns any website into a searchable knowledge base for serverless chatbots. Pre-computed JSON index, zero-dependency runtime via `gnosys/web`, works on Vercel/Netlify/Cloudflare Pages without SQLite.
- **Zero infrastructure** — no external databases, no Docker (unless you want it), no cloud services. Just `npm install`.

---

## Real-World Use Cases

### USDA FoodData Central — 100 foods imported in 0.6s

![USDA import: 100 Foundation Foods with nutrient data, wikilinks to food categories](docs/screenshots/usda-import-result.png)

```bash
gnosys import usda-foods.json \
  --format json \
  --mapping '{"title":"title","category":"category","content":"content","tags":"tags","relevance":"relevance"}' \
  --mode structured --skip-existing
```

Each food lands in the central `~/.gnosys/gnosys.db` as an atomic memory with nutrient data and `[[wikilinks]]` to food categories. A dual-write `.md` copy is kept for safety and Obsidian export:

```yaml
---
title: "Almond butter, creamy"
category: usda-foods
tags:
  domain: [food, nutrition, usda]
relevance: "almond butter creamy food nutrition usda fdc nutrient diet dietary protein"
---
# Almond butter, creamy

**Food Category:** [[General]]

## Key Nutrients (per 100g)
- Protein (g): 20.4 G
- Total Fat (g): 55.7 G
- Calcium (mg): 264 MG
- Potassium (mg): 699 MG
```

### NVD/CVE Database — 20 vulnerabilities with CVSS scores and affected products

![NVD import: CVEs with CVSS scores, severity tags, wikilinks to affected products](docs/screenshots/nvd-import-result.png)

```bash
gnosys import nvd-cves.json \
  --format json \
  --mapping '{"title":"title","category":"category","content":"content","tags":"tags","relevance":"relevance"}' \
  --mode structured --skip-existing
```

Each CVE lands in the central DB and links to affected packages via wikilinks:

```yaml
---
title: CVE-1999-0095
tags:
  domain: [cve, vulnerability, security, high]
relevance: "cve-1999-0095 cve vulnerability security nvd patch exploit high eric_allman sendmail"
---
# CVE-1999-0095

The debug command in Sendmail is enabled, allowing attackers to execute commands as root.

**CVSS Score:** 10.0 (HIGH)
**Affected:** [[eric_allman/sendmail]]
```

See [DEMO.md](DEMO.md) for the full step-by-step walkthrough.

---

## Quick Start

```bash
# Install
npm install -g gnosys

# Initialize a project
cd your-project
gnosys init

# Start the sandbox (background process — runs once, stays alive)
gnosys sandbox start

# Add memories via CLI
gnosys add "We chose PostgreSQL over MySQL for its JSON support and mature ecosystem"

# Search memories
gnosys recall "database selection"
gnosys search "PostgreSQL"

# Generate a helper library for agent integration
gnosys helper generate
```

### Agent / Helper Library

```ts
import { gnosys } from "./gnosys-helper";   // generated once, reused forever

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

### GEO Integration

The `/knowledge/` directory of markdown files can be served to AI crawlers. YAML frontmatter provides structured metadata that LLMs can extract. Add an `llms.txt` entry pointing to your knowledge directory for AI discoverability.

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

## Installation

### npm (recommended)

```bash
npm install -g gnosys
```

### Docker

```bash
# Build the image
docker build -t gnosys .

# Initialize a store
docker run -v $(pwd):/data gnosys init

# Import data
docker run -v $(pwd):/data gnosys import data.json --format json \
  --mapping '{"name":"title","type":"category","notes":"content"}' \
  --mode structured

# Start the MCP server
docker run -v $(pwd):/data gnosys serve
```

Or with Docker Compose:

```bash
# Start the MCP server (mounts current directory)
docker compose up

# Run any CLI command
docker compose run gnosys search "my query"
docker compose run gnosys import data.json --format json --mapping '...'
```

---

## MCP Server Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gnosys": {
      "command": "gnosys",
      "args": ["serve"],
      "env": { "ANTHROPIC_API_KEY": "your-key-here" }
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
      "args": ["serve"],
      "env": { "ANTHROPIC_API_KEY": "your-key-here" }
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

[mcp.gnosys.env]
ANTHROPIC_API_KEY = "your-key-here"
```

### MCP Tools

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
| `gnosys_federated_search` | Tier-boosted search across project → user → global scopes |
| `gnosys_detect_ambiguity` | Check if a query matches multiple projects |
| `gnosys_briefing` | Generate project briefing (categories, activity, tags, summary) |
| `gnosys_working_set` | Get recently modified memories for the current project |

---

## How It Works

### Central Brain

Gnosys uses a **central database** at `~/.gnosys/gnosys.db` as the single source of truth across all projects. Each project also has a local `.gnosys/` directory with a `gnosys.json` identity file:

```
~/.gnosys/
  gnosys.db              # ← central brain (all projects, users, globals)

your-project/
  .gnosys/
    gnosys.json          # ← project identity (projectId, name, settings)
    decisions/           # dual-write .md copies (safety net + Obsidian export)
      use-postgresql.md
    architecture/
      three-layer-design.md
    .config/tags.json    # tag registry
    CHANGELOG.md
```

`gnosys init` creates the project identity, registers the project in the central DB, and auto-detects your IDE (Cursor, Claude Code) for rules file generation.

All reads go through SQLite for sub-10ms performance. Writes dual-write to both `.md` files and the database. Run `gnosys migrate --to-central` to migrate existing v2.x project data into the central DB.

Each memory is an atomic Markdown file with YAML frontmatter:

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
status: active
supersedes: null
---
# Use PostgreSQL for Main Database

We chose PostgreSQL over MySQL and SQLite because...
```

Key fields:

- **relevance** — keyword cloud powering `discover`. Think: what would someone search to find this?
- **confidence** — 0–1 score. Observations: 0.6. Firm decisions: 0.9.
- **authority** — who established this? `declared`, `observed`, `imported`, `inferred`.
- **status** — `active`, `archived`, or `superseded`. Superseded memories link to replacements.

---

## LLM Providers & Configuration

Gnosys features a **System of Cognition (SOC)** — five LLM providers behind a single interface. Switch between cloud and local with one command:

```bash
# Switch providers
gnosys config set provider anthropic   # Cloud (default)
gnosys config set provider ollama      # Local via Ollama
gnosys config set provider groq        # Fast cloud inference
gnosys config set provider openai      # OpenAI-compatible
gnosys config set provider lmstudio    # Local via LM Studio

# Route tasks to different providers
gnosys config set task structuring ollama llama3.2
gnosys config set task synthesis anthropic claude-sonnet-4-20250514

# View the full SOC dashboard
gnosys dashboard

# Check all provider connectivity
gnosys doctor
```

### Supported Providers

| Provider | Type | Default Model | API Key Env Var |
|----------|------|---------------|-----------------|
| **Anthropic** | Cloud | claude-sonnet-4-20250514 | `ANTHROPIC_API_KEY` |
| **Ollama** | Local | llama3.2 | — (runs locally) |
| **Groq** | Cloud | llama-3.3-70b-versatile | `GROQ_API_KEY` |
| **OpenAI** | Cloud | gpt-4o-mini | `OPENAI_API_KEY` |
| **LM Studio** | Local | default | — (runs locally) |

All providers implement the same `LLMProvider` interface. Cloud providers use API keys (set via env var or `gnosys.json`). Local providers (Ollama, LM Studio) just need the service running.

### Task-Based Model Routing

Use different models for different tasks — a cheap/fast model for structuring imports and a powerful model for synthesis:

```json
{
  "llm": {
    "defaultProvider": "anthropic",
    "anthropic": { "model": "claude-sonnet-4-20250514" },
    "ollama": { "model": "llama3.2", "baseUrl": "http://localhost:11434" },
    "groq": { "model": "llama-3.3-70b-versatile" },
    "openai": { "model": "gpt-4o-mini", "baseUrl": "https://api.openai.com/v1" },
    "lmstudio": { "model": "default", "baseUrl": "http://localhost:1234/v1" }
  },
  "taskModels": {
    "structuring": { "provider": "ollama", "model": "llama3.2" },
    "synthesis": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" }
  }
}
```

A default `gnosys.json` is created during `gnosys init`. Validation is handled by Zod — invalid configs produce clear error messages. Legacy `defaultLLMProvider` and `defaultModel` fields are auto-migrated to the new `llm` structure.

---

## Using with Obsidian

The primary store is the central `~/.gnosys/gnosys.db`. Use the **Obsidian Export Bridge** to generate a full Obsidian vault from the database:

```bash
# Export to an Obsidian-compatible vault
gnosys export --to ~/vaults/my-project

# Overwrite an existing export
gnosys export --to ~/vaults/my-project --overwrite

# Export everything including summaries, reviews, and graph data
gnosys export --to ~/vaults/my-project --all
```

The export creates: category folders with YAML frontmatter `.md` files, `[[wikilinks]]` from the relationships table, `_summaries/` for Dream Mode category summaries, `_review/` for flagged memories, and `_graph/` for relationship data.

You can also browse the dual-write `.md` files directly in the `.gnosys/` directory — they're kept in sync with every write. Open the exported vault in Obsidian for graph view, wikilinks, backlinks, tag search, and visual editing.

---

## Bulk Import

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

# With LLM enrichment (generates keyword clouds, better structure)
gnosys import data.json --mode llm --concurrency 3

# Preview without writing
gnosys import data.json --dry-run

# Resume interrupted imports
gnosys import data.json --skip-existing

# Slice a large dataset
gnosys import large.json --limit 500 --offset 1000
```

---

## Freeform Asking

Ask natural-language questions and get synthesized answers with citations from the entire vault. Gnosys retrieves relevant memories via hybrid search, then uses your LLM to synthesize a cited response.

```bash
# First, build the semantic index (downloads ~80 MB model on first run)
gnosys reindex

# Ask a question about your USDA data
gnosys ask "What are the best high-protein low-sodium food alternatives?"

# Ask about CVEs
gnosys ask "Which vulnerabilities allow remote code execution?"

# Use keyword-only mode (no embeddings needed)
gnosys ask "What do we know about cheddar cheese?" --mode keyword
```

Answers include Obsidian wikilink citations like `[[almond-butter-creamy.md]]` so you can click through to the source memories. If the initial search doesn't find enough context, a "deep query" follow-up search automatically expands the context.

### Hybrid Search

Three search modes available:

```bash
# Hybrid (default): combines keyword + semantic with RRF fusion
gnosys hybrid-search "high protein low sodium"

# Semantic only: finds conceptually related memories
gnosys semantic-search "healthy meal alternatives"

# Keyword only: classic FTS5 full-text search
gnosys hybrid-search "cheddar cheese protein" --mode keyword
```

The embedding model (`all-MiniLM-L6-v2`) is lazy-loaded — it's only downloaded the first time you run `gnosys reindex` or a semantic search. Embeddings are stored as a regeneratable sidecar in SQLite, never the source of truth.

---

## Memory Scopes

The central `~/.gnosys/gnosys.db` holds all memories with `project_id` and `scope` columns:

| Scope | Description | Boost |
|-------|-------------|-------|
| **project** | Tied to a specific project (via `project_id`) | 1.5x (1.8x for current) |
| **user** | Cross-project user preferences and knowledge | 1.0x |
| **global** | Org-wide shared knowledge | 0.7x |

Federated search ranks results across all scopes with tier boosting. Legacy env vars (`GNOSYS_STORES`, `GNOSYS_PERSONAL`, `GNOSYS_GLOBAL`) are still supported as read-only fallback stores for backward compatibility.

---

## Reflection API

Reflect on real-world outcomes to update memory confidence and build validation chains:

```bash
# Success — boosts confidence on related memories
gnosys reflect "JWT auth worked perfectly in production" --memory-ids mem-001,mem-002

# Failure — decreases confidence and marks contradictions
gnosys reflect "bcrypt was too slow, switched to argon2" --memory-ids mem-003 --failure

# Auto-discover — searches for related memories when no IDs given
gnosys reflect "Our three-layer architecture handled 10k users"
```

In the helper library:

```typescript
import { gnosys } from "./gnosys-helper";

const result = await gnosys.reflect("Deployment succeeded", {
  memory_ids: ["mem-auth-001", "mem-arch-001"],
  success: true,
  notes: "Zero downtime deploy with 10k concurrent users",
});
// → { reflection_id, memories_updated, relationships_created, confidence_delta }
```

Each reflection creates a dedicated memory (category: `reflections`) and links it to related memories via `validates` or `contradicts` relationships. On success, related memories are also cross-linked with `corroborates`.

---

## Process Tracing

Trace a codebase to build procedural "how" memories with call-chain relationships:

```bash
# Trace your project
gnosys trace ./src

# With project association
gnosys trace ./src --project-id proj-abc123

# JSON output
gnosys trace ./src --json
```

This scans TypeScript/JavaScript files, extracts function declarations and call sites, then stores each as a procedural memory (category: `how`) with three relationship types:

- **leads_to** — function A calls function B
- **follows_from** — function B is called by function A
- **requires** — function A imports from module B

---

## Relationship Traversal

Walk relationship chains starting from any memory:

```bash
# Traverse from a memory (default depth: 3)
gnosys traverse mem-001

# Limit depth
gnosys traverse mem-001 --depth 5

# Filter by relationship type
gnosys traverse mem-001 --rel-types leads_to,requires
```

In the helper library:

```typescript
const chain = await gnosys.traverse("mem-001", {
  depth: 3,
  rel_types: ["leads_to", "follows_from"],
});
// → { root, depth, nodes: [{ id, title, category, confidence, depth, via_rel, via_from }], total }
```

Traversal uses BFS and follows both outgoing and incoming edges. The depth is capped at 10 for safety.

---

## Auto Memory Maintenance

The vault stays clean and useful forever without manual babysitting. Agents can run for months without the memory turning into a mess.

### How It Works

**Confidence Decay:** Every memory's confidence decays exponentially over time based on how recently it was used. The formula: `decayed = base_confidence × e^(-0.005 × days_since_reinforced)`. At this rate, an unreinforced memory loses ~50% confidence after 139 days.

**Automatic Reinforcement:** Every time a memory appears in search results, ask synthesis, or import — its `reinforcement_count` increments and `last_reinforced` resets. This happens automatically in `gnosys_ask`, `gnosys_hybrid_search`, and all search-based tools.

**Duplicate Detection:** Uses semantic similarity (cosine > 0.85) combined with title word overlap (Jaccard > 0.4) to flag potential duplicates. Both conditions must pass to reduce false positives.

**Auto-Consolidation:** When duplicates are confirmed, the LLM merges both memories into a single comprehensive one. Originals are marked `status: superseded` with a pointer to the merged version.

### Running Maintenance

```bash
# See what would change (safe, no modifications)
gnosys maintain --dry-run

# Apply all changes automatically
gnosys maintain --auto-apply

# Background mode: runs every 6 hours alongside the sandbox
gnosys serve --with-maintenance
```

### Scheduling with cron (Linux/Mac)

```bash
# Run maintenance daily at 3am
0 3 * * * cd /path/to/project && npx gnosys maintain --auto-apply >> /var/log/gnosys-maintain.log 2>&1
```

### Scheduling with Task Scheduler (Windows)

Create a basic task that runs daily:
- Program: `npx`
- Arguments: `gnosys maintain --auto-apply`
- Start in: `C:\path\to\project`

### MCP Tool

The `gnosys_maintain` MCP tool lets agents trigger maintenance programmatically with dry-run and auto-apply options.

### Doctor Health Report

`gnosys doctor` now includes a Maintenance Health section showing stale count, average confidence (raw and decayed), reinforcement stats, and never-reinforced memories.

---

## Agent-First SQLite Core

Gnosys uses an **agent-first SQLite core**. The central `~/.gnosys/gnosys.db` holds all memories across all projects, with `project_id` and `scope` columns for multi-project isolation. The schema has six tables: `memories`, `memories_fts` (FTS5), `relationships`, `summaries`, `audit_log`, and `projects`.

### Migration

Existing v1.x stores upgrade with a single command:

```bash
# Migrate all .md files + archive.db into gnosys.db
gnosys migrate

# Preview what would be migrated (dry run)
gnosys migrate --dry-run
```

Migration is one-shot and safe — your `.md` files remain untouched. After migration, all reads go through SQLite (sub-10ms), and all writes dual-write to both `.md` and `gnosys.db`.

### Schema

| Table | Purpose |
|-------|---------|
| `memories` | All memory data: frontmatter, content, embeddings, project_id, scope |
| `memories_fts` | FTS5 full-text index — auto-synced via INSERT/UPDATE/DELETE triggers |
| `relationships` | Typed edges between memories (wikilinks, Dream Mode discoveries) |
| `summaries` | Category-level summaries generated by Dream Mode |
| `audit_log` | Every operation logged with timestamps and trace IDs |
| `projects` | Project identity registry (id, name, working_directory) |

The database uses WAL mode for concurrent access — multiple agents can read and write safely from parallel processes.

---

## Dream Mode

Dream Mode is Gnosys's idle-time consolidation engine — inspired by how biological memory consolidates during sleep. When your agent goes idle, Dream Mode runs a four-phase cycle:

**Phase 1: Confidence Decay** — Applies exponential decay to unreinforced memories. No LLM needed.

**Phase 2: Self-Critique** — Rule-based + optional LLM scoring flags low-quality, stale, or contradictory memories for review. **Never deletes** — only stores review suggestions.

**Phase 3: Summary Generation** — LLM generates category-level summaries and stores them in the `summaries` table.

**Phase 4: Relationship Discovery** — LLM discovers semantic relationships between memories and stores typed edges in the `relationships` table.

### Usage

```bash
# Run a Dream cycle manually
gnosys dream

# Limit runtime
gnosys dream --max-runtime 15

# Skip specific phases
gnosys dream --no-summaries --no-relationships

# JSON output for automation
gnosys dream --json
```

### Configuration

Dream Mode is **off by default**. Enable it in `gnosys.json`:

```json
{
  "dream": {
    "enabled": true,
    "idleMinutes": 10,
    "maxRuntimeMinutes": 30,
    "provider": "ollama",
    "selfCritique": true,
    "generateSummaries": true,
    "discoverRelationships": true
  }
}
```

When enabled and the MCP server is running, Dream Mode automatically triggers after the configured idle period. Any agent activity immediately aborts the dream cycle and resets the idle timer.

The `gnosys_dream` MCP tool lets agents trigger dream cycles programmatically.

### Sandbox Protocol

The sandbox daemon exposes Dream Mode, preferences, and sync through its IPC protocol. This enables helper libraries and agents to interact with these features without MCP:

| Method | Description |
|---|---|
| `dream_status` | Returns current Dream Mode state (enabled, idle timer, dreams completed, isDreaming) |
| `pref_set` | Set a user preference (stored as `scope: user` memory) |
| `pref_get` | Retrieve a preference by key |
| `pref_list` | List all user preferences |
| `pref_delete` | Remove a preference |
| `pref_search` | Search preferences by query |
| `sync` | Generate and inject agent rules from preferences + project conventions |

Dream Mode integrates with the sandbox: every request resets the idle timer, and the dream scheduler runs automatically when the sandbox is idle. The `sync` method generates a `<!-- GNOSYS:START -->` / `<!-- GNOSYS:END -->` protected block in agent rules files (CLAUDE.md, .cursorrules, etc.) that is safely replaced on each sync without disturbing user-written content.

---

## Federated Search

All major search commands (`search`, `discover`, `hybrid-search`, `recall`, `ask`) support federated search with tier boosting. Use `--federated` to search across all scopes in the central DB with automatic ranking:

```bash
# Federated search with tier boosting (project > user > global)
gnosys search "auth tokens" --federated

# Filter to specific scope(s)
gnosys search "deploy config" --scope user
gnosys search "best practices" --scope project,global

# Dedicated federated search command with JSON output
gnosys fsearch "authentication" --json --scope user,project

# Federated recall for agents
gnosys recall "payment logic" --federated --json

# Ask with cross-scope context
gnosys ask "What auth pattern do we use?" --federated

# Multi-project scenario: specify project directory
gnosys search "API design" --federated --directory /path/to/project-b
```

**Tier boosting** ranks results by scope: project memories get 1.5x boost (1.8x for the current project), user-scoped get 1.0x, and global get 0.7x. Recency (last 24h) adds a 1.3x boost, and reinforcement count adds up to 25%.

Results always include `scope` and `boosts` fields so agents know where each memory came from.

---

## Multi-Project Support

Gnosys supports multiple projects in parallel — critical for developers using multiple Cursor windows or multi-root workspaces. The central DB's `projects` table acts as a registry, and federated search + ambiguity detection make cross-project workflows safe and predictable.

### How It Works

The central `~/.gnosys/gnosys.db` holds all projects, each identified by `project_id`. The sandbox process holds the database connection and routes requests by project. MCP tools accept an optional `projectRoot` parameter for explicit routing, and the CLI auto-detects the current project from `gnosys.json` in the working directory.

```
# Agent in Window 1 (project-a):
gnosys_add(input: "...", projectRoot: "/Users/me/project-a")

# Agent in Window 2 (project-b) — runs simultaneously, routes correctly:
gnosys_add(input: "...", projectRoot: "/Users/me/project-b")
```

### MCP Roots

Gnosys also supports the MCP roots protocol. On connect, the server calls `roots/list` to discover workspace folders and listens for `notifications/roots/list_changed` to track dynamic changes. Store resolution priority: registered stores → MCP roots → `cwd` walkup.

### Debugging

Use `gnosys stores` (CLI) or the `gnosys_stores` MCP tool to see all detected stores, MCP roots, and which store is currently active.

---

## Network Share Support

Gnosys supports pointing the central database at a network share — Dropbox, iCloud Drive, NAS, or any mounted network path. This enables multi-machine access to the same knowledge base.

### Setup

```bash
# Start the sandbox with a network DB path
gnosys sandbox start --db-path /Volumes/NAS/gnosys

# Or Dropbox
gnosys sandbox start --db-path ~/Dropbox/gnosys

# Or iCloud Drive
gnosys sandbox start --db-path ~/Library/Mobile\ Documents/com~apple~CloudDocs/gnosys
```

The sandbox automatically applies network-safe defaults when a custom `--db-path` is provided: 5 connection retries with 1-second delays, and a 10-second SQLite busy timeout for concurrent multi-machine access.

### Multi-Machine Usage

Multiple machines can share the same database. SQLite's WAL mode handles concurrent reads safely, and the busy timeout prevents lock contention failures. For best results:

- Keep each machine's sandbox running (it holds a connection pool)
- Ensure the network path is mounted before starting the sandbox
- If the path becomes unavailable, stop and restart the sandbox after remounting

### Backup & Restore

```bash
# Backup the central DB (includes DB, helper library, rules, and sandbox log)
gnosys backup
gnosys backup --to /backups/gnosys-$(date +%F).db

# Restore from a backup
gnosys restore latest
gnosys restore --from /backups/gnosys-2026-03-12.db

# JSON output for scripting
gnosys backup --json
gnosys restore latest --json
```

Backups include the full SQLite database, helper library, rules files, and sandbox diagnostics log. The `--to` and `--from` flags support both local and network paths.

---

## Comparison

Agent memory is a spectrum — from a single markdown file to full knowledge graphs. Here's an honest look at the trade-offs.

| Aspect | Plain Markdown | RAG (Vector DB) | Knowledge Graph | **Gnosys** |
|--------|---------------|-----------------|-----------------|-----------|
| **Examples** | CLAUDE.md, .cursorrules | Mem0, LangChain Memory | Graphiti/Zep, Mem0 Graph | — |
| **Storage** | `.md` files | Embeddings in vector DB | Nodes/edges in graph DB | Unified SQLite DB + `.md` dual-write |
| **Transparency** | Perfect | Lossy (embeddings) | High (query nodes) | High (SQLite + dual-write `.md` + Obsidian export) |
| **Version history** | Git native | None built-in | None built-in | Dual-write `.md` files (optional Git) |
| **Keyword search** | Manual / grep | BM25 layer (some) | BM25 layer (some) | FTS5 (built-in) |
| **Semantic search** | None | Vector similarity | Graph + vectors | Vector + FTS5 hybrid (RRF) |
| **Relationship traversal** | None | None | Multi-hop graph queries | Wikilinks (manual encoding) |
| **Automatic extraction** | No | Yes (embeddings) | Yes (entities + edges) | No (explicit structuring) |
| **Conflict detection** | No | No | Yes (graph rules) | No |
| **Scale comfort zone** | ~5K memories | 100K+ | 100K+ | 100K+ (unified SQLite + optional archive tier) |
| **Setup time** | < 5 min | 30 min – 2 hours | 4 – 8 hours | 15 – 30 min |
| **Infrastructure** | None | Vector DB + embeddings API | Graph DB + LLM | SQLite (embedded) |
| **Human editability** | Excellent | Poor (re-embed) | Moderate | Excellent |
| **MCP integration** | Via skill files | Custom server | Mem0 ships MCP | MCP server (included) |
| **Obsidian compatible** | Partially | No | No | Yes (full vault) |
| **Cost** | Free | $0–500+/mo (cloud DB + embeddings) | $250+/mo (Mem0 Pro) or self-host | Free (MIT) |
| **Memory lifecycle** | Manual cleanup | Manual / TTL | Manual / TTL | Auto-archive + auto-dearchive on cite |
| **Offline capable** | Yes | Self-hosted only | Self-hosted only | Yes (Ollama/LM Studio) |

### Where others genuinely win

- **Knowledge graphs** (Graphiti, Mem0 Graph) excel at multi-hop reasoning ("Who does Alice report to?") and automatic conflict detection. If your domain has clear entities and relationships — org charts, dependency trees, CRM data — a graph DB is the right tool.
- **RAG/vector search** handles fuzzy semantic matching without requiring explicit keyword clouds. You don't need to think about relevance fields — the embeddings handle conceptual similarity automatically.
- **Automatic extraction** in both RAG and graph approaches means the system learns from conversations without you explicitly structuring each fact.

### Where Gnosys wins

- **Zero infrastructure**: No vector DB to deploy, no graph DB to manage. SQLite is embedded.
- **Full transparency**: Every memory is a readable, editable `.md` file. No opaque embeddings.
- **Dual-write transparency**: Every memory has a human-readable `.md` file alongside the central DB. Optional Git versioning for rollback and diff.
- **Obsidian native**: Browse, edit, graph view, wikilinks — all with your existing Obsidian setup.
- **Hybrid search without a vector DB**: FTS5 keyword search is built-in. Semantic search is optional (local embeddings via Ollama, no API costs).
- **Bulk import**: CSV, JSON, JSONL. Turn a dataset into a searchable knowledge base in seconds.
- **Cost**: Genuinely free. No cloud service, no API costs if using local LLM providers.
- **Two-tier memory**: Active memories stay lightning-fast in SQLite. Old/low-confidence memories are automatically archived — and auto-dearchive when needed by search or ask.

### Two-Tier Memory (Active + Archive)

Gnosys uses a two-tier architecture so your current work stays fast while safely growing to 100k+ memories:

**Active layer** — `~/.gnosys/gnosys.db` central brain. All reads and writes go here. Dual-write `.md` copies are kept as a safety net.

**Archive layer** — low-confidence memories within the same `gnosys.db`, marked with `tier: archive`. Searched as a fallback when active results are insufficient.

The flow is fully automatic and bidirectional:
1. `gnosys maintain --auto-apply` moves stale memories (>90 days unreinforced + confidence below 0.3) from active → archive
2. Every search and ask query checks the archive if active results are insufficient
3. Archived memories that get cited in an answer are automatically restored to active and reinforced

You can also force-dearchive with `gnosys dearchive "query"` or the `gnosys_dearchive` MCP tool.

Configure thresholds in `gnosys.json`:
```json
{
  "archive": {
    "maxActiveDays": 90,
    "minConfidence": 0.3
  }
}
```

### Enterprise Reliability (v1.3.0+)

Built for long-running agent orchestrators that call Gnosys hundreds of times per session.

**Automatic Memory Injection** — The `gnosys://recall` MCP Resource is read by hosts (Cursor, Claude Desktop, Claude Code, Cowork) on every single turn. No tool call needed — the host injects relevant memories into the model context automatically. The `gnosys_recall` tool is kept as a fallback for hosts that don't support MCP Resources.

Sub-50ms, no LLM, no embeddings — pure FTS5 keyword search with relevance scoring. Returns `<gnosys-recall>` blocks with `[[wikilinks]]` or a `<gnosys: no-strong-recall-needed>` heartbeat.

Two modes: **aggressive** (default) always injects the top 3 memories plus any above the relevance floor. **Filtered** (`aggressive: false`) applies a hard cutoff at `minRelevance`.

```bash
# CLI — aggressive mode (default)
gnosys recall "React state management"

# Force filtered mode
gnosys recall "React state management" --no-aggressive --host

# Configure recall
gnosys config set recall aggressive true
gnosys config set recall maxMemories 12
gnosys config set recall minRelevance 0.3
```

Configure in `gnosys.json`:
```json
{
  "recall": {
    "aggressive": true,
    "maxMemories": 8,
    "minRelevance": 0.4
  }
}
```

#### Setup for Automatic Injection

**Cursor** — Add to your MCP config. Cursor reads `gnosys://recall` automatically on every turn when it's listed as a resource with `priority: 1`.

**Claude Desktop** — Same MCP config. The resource appears in the model context on every message.

**Claude Code / Cowork** — Configure via `.mcp.json` or the MCP settings. The `gnosys://recall` resource is injected into every assistant turn.

No per-turn tool calls, no manual invocation — just configure the MCP server once and memories flow into every conversation automatically.

**Concurrency safety** — The central `gnosys.db` uses WAL mode with a 10-second busy timeout for concurrent reads and writes. Write locking with PID tracking prevents corruption when multiple agents write simultaneously. Stale lock detection auto-recovers from crashed processes.

**Audit trail** — Every memory operation (read, write, recall, ask, maintain, archive, dearchive) is logged to the `audit_log` table in `gnosys.db` with timestamps, durations, and optional traceIds for correlation with your outer orchestrator.

```bash
gnosys audit --days 7 --operation recall --json
```

**Deterministic dearchive** — When an LLM-synthesized answer cites archived memories, a three-stage fallback ensures they're always restored: path match → title match → all archive results from context. No memory is left behind even if the LLM output is unpredictable.

**Performance monitoring** — `gnosys dashboard` now includes enterprise performance benchmarks: recall latency, active search latency, and archive search latency, with warnings if recall exceeds the 50ms target.

---

## CLI Reference

```bash
gnosys --help               # List all commands
gnosys init                  # Initialize a new store
gnosys add "raw input"       # Add memory via LLM
gnosys add-structured ...    # Add memory with explicit fields (--user/--global for scope)
gnosys commit-context "..."  # Extract memories from conversation
gnosys bootstrap <dir>       # Batch-import existing markdown files
gnosys import <file> ...     # Bulk import CSV/JSON/JSONL data
gnosys discover "keywords"   # Find relevant memories (metadata only)
gnosys search "query"        # Full-text search with snippets
gnosys hybrid-search "q"     # Hybrid keyword + semantic search
gnosys semantic-search "q"   # Semantic similarity search
gnosys ask "question"        # Ask a question, get cited answer
# All search commands support: --federated --scope <project|user|global> --json
gnosys read <path>           # Read a specific memory
gnosys list                  # List all memories
gnosys lens                  # Filtered views (category, tag, status, date...)
gnosys update <path> ...     # Update a memory
gnosys reinforce <id> ...    # Signal memory usefulness
gnosys stale                 # Find stale memories
gnosys history <path>        # Git-backed version history
gnosys rollback <path> <hash>  # Rollback to a previous commit
gnosys timeline              # Knowledge evolution over time
gnosys stats                 # Summary statistics
gnosys links <path>          # Wikilinks and backlinks for a memory
gnosys graph                 # Full cross-reference graph
gnosys tags                  # List tag registry
gnosys tags-add              # Add a new tag
gnosys reindex               # Build/rebuild semantic embeddings
gnosys reindex-graph         # Build/rebuild wikilink graph
gnosys maintain              # Run vault maintenance (dry run by default)
gnosys maintain --auto-apply # Apply all maintenance + archiving automatically
gnosys dearchive "query"     # Force-dearchive memories from archive to active
gnosys dashboard             # Pretty system dashboard
gnosys dashboard --json      # Dashboard as JSON
gnosys config show           # Show SOC configuration
gnosys config set provider <name>  # Set default provider
gnosys config set task <task> <provider> <model>  # Route task
gnosys doctor                # Full system health check (all providers)
gnosys stores                # Show active stores
gnosys recall "query"            # Always-on recall (aggressive mode by default)
gnosys recall "q" --no-aggressive  # Force filtered mode (hard cutoff)
gnosys recall "q" --host         # Output in <gnosys-recall> host format
gnosys recall "q" --json         # Recall as JSON for programmatic use
gnosys recall "q" --federated    # Federated recall across all scopes
gnosys audit                 # View audit trail (last 7 days)
gnosys audit --days 30       # View last 30 days of operations
gnosys audit --operation ask # Filter by operation type
gnosys migrate               # Migrate v1.x data to unified gnosys.db
gnosys migrate --dry-run     # Preview migration without changes
gnosys dream                 # Run Dream Mode consolidation cycle
gnosys dream --max-runtime 15  # Limit dream runtime to 15 minutes
gnosys dream --no-summaries  # Skip summary generation phase
gnosys export --to <dir>     # Export gnosys.db to Obsidian vault
gnosys export --to <dir> --all  # Include summaries, reviews, and graph
gnosys export --to <dir> --overwrite  # Overwrite existing export
gnosys serve                 # Start MCP server (stdio)
gnosys serve --with-maintenance  # MCP server + maintenance every 6h

# Sandbox Runtime
gnosys sandbox start         # Start the background sandbox daemon
gnosys sandbox stop          # Stop the sandbox daemon
gnosys sandbox status        # Show sandbox process status
gnosys helper generate       # Generate agent helper library

# Network Share Support
gnosys sandbox start --db-path /path/to/network/share  # Use network DB
gnosys backup --to /backups/gnosys-2026-03-12.db  # Backup to specific path
gnosys restore --from /backups/gnosys-2026-03-12.db  # Restore from specific path

# Centralized Brain
gnosys projects              # List all registered projects
gnosys backup                # Backup the central DB
gnosys restore <file>        # Restore central DB from backup
gnosys migrate --to-central  # Migrate project data to central DB
gnosys pref set <key> <val>  # Set a user preference
gnosys pref get [key]        # Get one or all preferences (--json)
gnosys pref delete <key>     # Delete a preference
gnosys sync                  # Regenerate agent rules from preferences
gnosys fsearch "query"       # Federated search (project > user > global)
gnosys fsearch "q" --scope user  # Filter to specific scope(s)
gnosys ambiguity "query"     # Check for cross-project ambiguity
gnosys briefing              # Project briefing (categories, activity, tags)
gnosys briefing --all        # Briefings for all projects
gnosys working-set           # Show implicit working set (recent memories)
```

---

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm test             # Run test suite (495 tests)
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with v8 coverage report
npm run dev          # Run MCP server in dev mode (tsx)
```

### Test Suite

558 tests across 35 files covering the full feature set:

| Phase | Tests | Coverage |
|-------|-------|----------|
| Core (DB, store, search, FTS5) | 120+ | db.ts 77%, store.ts 94%, search.ts 78% |
| Federation + CLI parity | 100+ | federated.ts 85%, preferences.ts 79% |
| Sandbox (server, client, helper) | 32 | client.ts 71%, server.ts 53% |
| Phase 9d coverage overhaul | 74 | audit.ts 92%, lock.ts 72%, dbWrite.ts 64% |
| Phase 9e network share + polish | 21 | db.ts retry, backup/restore, manager, docs |

CI runs on Node 20 + 22 with multi-project scenario testing, network-share simulation, and TypeScript strict checking. Coverage reports are generated and uploaded as artifacts on every push.

### Architecture

```
src/
  index.ts            # MCP server — 50+ tools + gnosys://recall resource
  cli.ts              # CLI — full command suite with --json output
  lib/
    db.ts             # GnosysDB — central SQLite (6-table schema, project_id + scope)
    dbSearch.ts       # Adapter bridging GnosysDB to search interfaces
    dbWrite.ts        # Dual-write helpers (sync .md → gnosys.db)
    migrate.ts        # Migration: v1.x → v2.0 → central DB
    dream.ts          # Dream Mode engine + idle scheduler
    export.ts         # Obsidian Export Bridge (gnosys.db → vault)
    federated.ts      # Federated search, ambiguity detection, briefings, working set
    preferences.ts    # User preferences as scoped memories
    rulesGen.ts       # Agent rules generation (GNOSYS:START/END blocks)
    projectIdentity.ts # Project identity (gnosys.json) + central registry
    store.ts          # Core: read/write/update memory files (.md)
    search.ts         # FTS5 search and discovery
    embeddings.ts     # Lazy semantic embeddings (all-MiniLM-L6-v2)
    hybridSearch.ts   # Hybrid search with RRF fusion
    ask.ts            # Freeform Q&A with LLM synthesis + citations
    llm.ts            # LLM abstraction — System of Cognition (5 providers)
    maintenance.ts    # Auto-maintenance: decay, dedup, consolidation, archiving
    archive.ts        # Two-tier memory: active ↔ archive (SQLite)
    recall.ts         # Ultra-fast recall hook for agent orchestrators
    audit.ts          # Structured JSONL audit logging
    lock.ts           # File-level write locking + WAL helper
    dashboard.ts      # Aggregated system dashboard + performance monitoring
    graph.ts          # Persistent wikilink graph (graph.json)
    tags.ts           # Tag registry management
    ingest.ts         # LLM-powered structuring (with retry logic)
    import.ts         # Bulk import engine (CSV, JSON, JSONL)
    config.ts         # gnosys.json loader with Zod validation
    retry.ts          # Exponential backoff for LLM calls
    resolver.ts       # Layered multi-store resolution + MCP roots + multi-project
    lensing.ts        # Memory lensing (filtered views)
    history.ts        # Git history and rollback
    timeline.ts       # Knowledge evolution timeline
    wikilinks.ts      # Obsidian wikilink graph
    bootstrap.ts      # Bootstrap from source code
  prompts/
    synthesize.md     # System prompt template for ask engine
```

---

## Benchmarks

Real numbers from our demo vault (120 memories — 100 USDA foods + 20 NVD CVEs):

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
| Test suite | 495 tests, 0 errors |

All benchmarks on Apple M-series hardware, Node.js 20+. Structured imports bypass LLM entirely. LLM-enriched imports depend on provider latency.

---

## Migrating from v2.x to v3.0

v3.0 is a major architectural upgrade. Here's what changed and how to migrate.

### What's New in v3.0

- **Sandbox-first runtime**: persistent background process replaces per-request MCP overhead
- **Central brain**: single `~/.gnosys/gnosys.db` replaces per-project databases
- **Federated search**: tier-boosted search across project → user → global scopes
- **Preferences**: user preferences stored as scoped memories, driving agent rules generation
- **Network share**: point the central DB at Dropbox, iCloud, NAS for multi-machine access
- **Helper library**: generated TypeScript/JavaScript library for direct agent integration

### Migration Steps

```bash
# 1. Install v3.0 (package renamed from gnosys-mcp to gnosys)
npm install -g gnosys

# 2. Start the sandbox
gnosys sandbox start

# 3. Migrate each project's data to the central DB
cd /path/to/project-a
gnosys migrate --to-central

cd /path/to/project-b
gnosys migrate --to-central

# 4. Generate a helper library (optional, for agent integration)
gnosys helper generate

# 5. Verify migration
gnosys projects        # List all registered projects
gnosys briefing --all  # Check project data
```

### Breaking Changes

- **Database location**: The primary database is now `~/.gnosys/gnosys.db`, not `<project>/.gnosys/gnosys.db`. Per-project databases still exist as read fallbacks.
- **MCP server**: Still works identically. No config changes needed.
- **CLI**: All commands work as before. New commands added for sandbox, preferences, federation.
- **Import/export**: Unchanged. Imports go to the central DB by default.

Your `.gnosys/` directories and `.md` files are preserved. v3.0 reads from both the central DB and local stores, so nothing breaks during gradual migration.

---

## Community & Next Steps

Gnosys is open source (MIT) and actively developed. Here's how to get involved:

**Get started fast:**
- **Cursor template:** Add Gnosys to any Cursor project with one MCP config line (see [MCP Server Setup](#mcp-server-setup))
- **Docker:** `docker build -t gnosys . && docker compose up` for containerized deployment
- **Demo vault:** See [DEMO.md](DEMO.md) for a full walkthrough with USDA + NVD data

**Contribute:**
- [GitHub Discussions](https://github.com/proticom/gnosys/discussions) — share ideas, ask questions, show what you've built
- [Issues](https://github.com/proticom/gnosys/issues) — bug reports and feature requests
- PRs welcome — especially for new import connectors, LLM providers, and Obsidian plugins

**What's next:**
- Real-time multi-machine sync (automatic conflict resolution)
- Temporal memory versioning (valid_from / valid_until)
- Cross-session "deep dream" overnight consolidation
- Graph visualization in the dashboard
- Obsidian community plugin for native vault integration
- Docker Hub published image for one-line deployment

---

## License

MIT — [LICENSE](LICENSE)
