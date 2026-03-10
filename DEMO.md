# Gnosys v1.1 — Real-World Demo

This document shows Gnosys importing real data from two production APIs: **USDA FoodData Central** and **NVD (National Vulnerability Database)**.

## What This Proves

- Gnosys handles messy real-world JSON from government APIs
- Bulk import creates atomic Markdown memories with rich YAML frontmatter
- Wikilinks (`[[vendor/product]]`, `[[Food Category]]`) work out of the box
- Git auto-commits the entire batch in one shot
- The resulting `.gnosys/` folder is a fully functional Obsidian vault

---

## 1. USDA FoodData Central Import

**Source:** [FoodData Central API](https://fdc.nal.usda.gov/) — Foundation Foods dataset

### Download the data

```bash
curl -sL "https://api.nal.usda.gov/fdc/v1/foods/list?api_key=DEMO_KEY&dataType=Foundation&pageSize=100&pageNumber=1" \
  -o usda-foundation-100.json
```

### Pre-process into Gnosys-ready format

The raw API returns nested JSON with `foodNutrients` arrays. A small Python script flattens this into records with `title`, `category`, `content` (with wikilinks), `tags`, and `relevance` fields. See `scripts/prep-usda.py`.

### Import into Gnosys

```bash
gnosys import usda-import-ready.json \
  --format json \
  --mapping '{"title":"title","category":"category","content":"content","tags":"tags","relevance":"relevance"}' \
  --mode structured \
  --skip-existing \
  --batch-commit
```

### Result

```
✓ Import complete in 0.6s
  Imported: 100
  Skipped:  0
  Failed:   0
  Total:    100
```

### Sample memory file: `.gnosys/usda-foods/almond-butter-creamy.md`

```yaml
---
id: usda-001
title: "Almond butter, creamy"
category: usda-foods
tags:
  domain: [food, nutrition, usda]
relevance: "almond butter creamy food nutrition usda fdc nutrient diet dietary protein"
author: ai
authority: imported
confidence: 0.8
created: "2026-03-09"
modified: "2026-03-09"
status: active
---
# Almond butter, creamy

**Food Category:** [[General]]
**NDB Number:** 12195
**Data Type:** Foundation
**Published:** 2022-04-28

## Key Nutrients (per 100g)
- Calcium (mg): 264 MG
- Carbohydrate (g): 21.2 G
- Cholesterol (mg): 0 MG
- Energy (kcal): 614 KCAL
- Iron (mg): 3.34 MG
- Magnesium (mg): 279 MG
- Phosphorus (mg): 508 MG
- Potassium (mg): 699 MG
- Protein (g): 20.4 G
- Saturated Fat (g): 5.24 G
- Sodium (mg): 286 MG
- Total Fat (g): 55.7 G
- Vitamin C (mg): 0 MG
- Zinc (mg): 3.29 MG
```

---

## 2. NVD CVE Import

**Source:** [NVD CVE API 2.0](https://services.nvd.nist.gov/rest/json/cves/2.0)

### Download the data

```bash
curl -sL "https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=20" \
  -o nvd-cves-raw.json
```

### Pre-process

A Python script extracts CVE ID, description, CVSS score/severity, affected products (as wikilinks), and references. See `scripts/prep-nvd.py`.

### Import into Gnosys

```bash
gnosys import nvd-import-ready.json \
  --format json \
  --mapping '{"title":"title","category":"category","content":"content","tags":"tags","relevance":"relevance"}' \
  --mode structured \
  --skip-existing \
  --batch-commit
```

### Result

```
✓ Import complete in 0.3s
  Imported: 20
  Skipped:  0
  Failed:   0
  Total:    20
```

### Sample memory file: `.gnosys/nvd-cves/cve-1999-0095.md`

```yaml
---
id: nvd--001
title: CVE-1999-0095
category: nvd-cves
tags:
  domain: [cve, vulnerability, security, high]
relevance: "cve-1999-0095 cve vulnerability security nvd patch exploit high eric_allman sendmail"
author: ai
authority: imported
confidence: 0.8
---
# CVE-1999-0095

The debug command in Sendmail is enabled, allowing attackers to execute commands as root.

**CVSS Score:** 10.0 (HIGH)

**Affected:** [[eric_allman/sendmail]]
```

---

## Vault Structure After Import

```
.gnosys/
├── usda-foods/          # 100 food memories
│   ├── almond-butter-creamy.md
│   ├── apples-fuji-with-skin-raw.md
│   ├── beef-ground-80-lean-meat-20-fat-raw.md
│   ├── broccoli-raw.md
│   ├── cheese-cheddar.md
│   └── ... (100 files)
├── nvd-cves/            # 20 CVE memories
│   ├── cve-1999-0095.md
│   ├── cve-1999-0082.md
│   └── ... (20 files)
├── .config/
│   └── tags.yml
└── .git/                # Auto-versioned
```

## LLM Provider Configuration (v0.6+)

Gnosys supports Anthropic (cloud) and Ollama (local) out of the box.

```bash
# Check current setup
gnosys config show
```

```
LLM Configuration:
  Default provider: anthropic
  Anthropic model:  claude-sonnet-4-20250514
  Anthropic API key: set via env
  Ollama model:     llama3.2
  Ollama URL:       http://localhost:11434

Task Models:
  Structuring: anthropic/claude-sonnet-4-20250514 (default)
  Synthesis:   anthropic/claude-sonnet-4-20250514 (default)
```

Switch to Ollama for fully offline operation:

```bash
gnosys config set provider ollama
gnosys ask "What are the highest protein foods in this vault?"
```

Run `gnosys doctor` to verify connectivity:

```bash
gnosys doctor
```

```
Gnosys Doctor
=============

Stores:
  project: 120 memories

LLM Configuration:
  Default provider: ollama
  Structuring: ollama/llama3.2
  Synthesis:   ollama/llama3.2

LLM Connectivity:
  Anthropic: No ANTHROPIC_API_KEY set.
  Ollama: connected (model llama3.2 available at http://localhost:11434)

Embeddings:
  Index: 120 embeddings (0.0 MB)
```

## Querying the Vault

### Keyword Search (FTS5)

```bash
# Find high-protein foods
gnosys search "protein"

# Find security vulnerabilities affecting sendmail
gnosys search "sendmail"

# Discover nutrition-related memories
gnosys discover "nutrition diet protein"
```

### Hybrid Search (v0.5+)

Hybrid search combines FTS5 keyword search with semantic embeddings via Reciprocal Rank Fusion (RRF). First, build the embedding index:

```bash
gnosys reindex
```

```
✓ Reindex complete
  Indexed: 120 memories in 12.3s
```

Then search across both keyword and semantic signals:

```bash
# Hybrid search (keyword + semantic, default)
gnosys hybrid-search "high protein low sodium foods"

# Semantic-only search (meaning-based)
gnosys semantic-search "foods good for heart health"

# Keyword-only mode
gnosys hybrid-search "cheddar cheese protein" --mode keyword
```

### Freeform Ask (v0.5+)

Ask natural-language questions and get synthesized answers with citations:

```bash
# Ask about nutrition
gnosys ask "Which foods in this vault have the most protein per 100g?"

# Ask about security
gnosys ask "What are the most critical vulnerabilities and what do they affect?"

# Stream the answer in real-time (default)
gnosys ask "Compare the calcium content of dairy vs non-dairy foods"

# Disable streaming
gnosys ask "What sendmail vulnerabilities exist?" --no-stream
```

Example output:

```
Based on the vault data, the highest-protein foods per 100g are:

**Chicken breast** at 31.0g protein [[chicken-breast-without-skin-raw.md]]
is the leader, followed by **beef ground 93% lean** at 26.1g
[[beef-ground-93-lean-meat-7-fat-raw.md]] and **tuna, yellowfin** at
24.4g [[tuna-yellowfin-fresh-raw.md]].

Sources:
  - chicken-breast-without-skin-raw.md
  - beef-ground-93-lean-meat-7-fat-raw.md
  - tuna-yellowfin-fresh-raw.md
```

---

## Scaling Up

The same pipeline works at scale. To import the full USDA Foundation Foods dataset (~8,000 foods):

```bash
# Paginate through the API
for page in $(seq 1 80); do
  curl -sL "https://api.nal.usda.gov/fdc/v1/foods/list?api_key=YOUR_KEY&dataType=Foundation&pageSize=100&pageNumber=$page" \
    -o "usda-page-$page.json"
done

# Process and import each page
python3 scripts/prep-usda.py usda-page-*.json > usda-all.json
gnosys import usda-all.json --format json --mapping '...' --mode structured --skip-existing
```

For NVD, the full database has 200k+ CVEs. Use `--limit` and `--offset` for incremental imports:

```bash
gnosys import nvd-all.json --format json --mapping '...' --mode structured --skip-existing --limit 1000 --offset 0
```

---

## Vault Maintenance (v1.0+)

After importing data and using the vault over time, run maintenance to keep things clean:

### Dry Run (preview changes)

```bash
gnosys maintain --dry-run
```

```
Starting maintenance (dry run)...
Found 120 active memories across 1 store(s)
Step 1/3: Detecting duplicates...
  Found 2 duplicate pair(s)
Step 2/3: Calculating confidence decay...
  3 stale memorie(s) (confidence < 0.3)
  Average confidence: 0.800 → decayed: 0.721
Step 3/3: Applying changes...
→ [DRY RUN] Would consolidate: "Almond Butter, Creamy" + "Almond Butter" (similarity: 0.912)
→ [DRY RUN] Would consolidate: "CVE-1999-0095" + "CVE-1999-0095 Sendmail" (similarity: 0.874)
→ [DRY RUN] Would update decay: "Old unused memory" (0.80 → 0.24, 240 days since reinforced)

Gnosys Maintenance Report
========================================

Total memories scanned: 120
Average confidence: 0.800 (decayed: 0.721)

Duplicates found: 2
Stale memories: 3 (confidence < 0.3)

Actions (5):
  [DRY RUN] Would consolidate: ...
  [DRY RUN] Would update decay: ...
```

### Auto-Apply (apply all changes)

```bash
gnosys maintain --auto-apply
```

All changes are safe Git commits with automatic rollback on failure.

### Doctor with Maintenance Health

```bash
gnosys doctor
```

```
...
Maintenance Health:
  Active memories: 120
  Stale (confidence < 0.3): 3
  Average confidence: 0.800 (decayed: 0.721)
  Never reinforced: 15
  Total reinforcements: 342
```

---

## Wikilink Graph (v1.1+)

Build a persistent JSON graph from all `[[wikilinks]]` in your memories:

```bash
gnosys reindex-graph
```

```
Scanning 120 memories for [[wikilinks]]...
Found 45 edges across 120 nodes
Graph written to .gnosys/graph.json

Wikilink Graph:
  Nodes: 120
  Edges: 45
  Orphan nodes (no links): 68
  Orphan links (unresolved): 12
  Avg edges/node: 0.75
  Most connected: CVE-1999-0095 (8 edges)
```

The `graph.json` is fully regeneratable — delete it anytime, then re-run `gnosys reindex-graph`.

---

## System Dashboard (v1.1+)

Get a complete view of your Gnosys installation:

```bash
gnosys dashboard
```

```
╔══════════════════════════════════════════════════════╗
║          GNOSYS DASHBOARD  v1.1.0                   ║
╠══════════════════════════════════════════════════════╣
║  MEMORY STORES                                      ║
╟──────────────────────────────────────────────────────╢
║  project: 120 memories                              ║
║  Total: 120 memories                                ║
╟──────────────────────────────────────────────────────╢
║  MAINTENANCE HEALTH                                 ║
╟──────────────────────────────────────────────────────╢
║  Confidence: 0.800 raw / 0.721 decayed              ║
║  Stale: 3 | Never reinforced: 15                    ║
║  Total reinforcements: 342                          ║
╟──────────────────────────────────────────────────────╢
║  EMBEDDINGS                                         ║
╟──────────────────────────────────────────────────────╢
║  120 vectors (0.3 MB)                               ║
╟──────────────────────────────────────────────────────╢
║  WIKILINK GRAPH                                     ║
╟──────────────────────────────────────────────────────╢
║  120 nodes, 45 edges, 68 orphans                    ║
║  Most connected: CVE-1999-0095                      ║
╟──────────────────────────────────────────────────────╢
║  SYSTEM OF COGNITION (SOC)                          ║
╟──────────────────────────────────────────────────────╢
║  Default: anthropic                                 ║
║  Structuring → anthropic/claude-sonnet-4-20250514   ║
║  Synthesis   → anthropic/claude-sonnet-4-20250514   ║
║                                                     ║
║  ✓ anthropic: ready                                 ║
║  ✓ ollama: ready                                    ║
║  — groq: No GROQ_API_KEY set                        ║
║  — openai: No OPENAI_API_KEY set                    ║
║  ✓ lmstudio: ready                                  ║
╚══════════════════════════════════════════════════════╝
```

For JSON output (useful for MCP tools and scripts): `gnosys dashboard --json`
