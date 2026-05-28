# gnosys recall

Return relevant memories as injectable context for agents and hosts.

## Usage

```bash
gnosys recall "auth tokens"
gnosys recall "auth tokens" --host
gnosys recall "auth tokens" --json
gnosys recall "auth tokens" --federated --scope project,user
gnosys recall "auth tokens" --aggressive --trace-id my-trace-001
```

## Options

| Option | Description |
|--------|-------------|
| `--limit <n>` | Max memories to return (default from config, federated default `10`) |
| `--aggressive` | Force aggressive mode (inject medium-relevance memories) |
| `--no-aggressive` | Force filtered mode (hard cutoff at minRelevance) |
| `--trace-id <id>` | Trace ID for audit correlation (legacy path) |
| `--json` | Output raw JSON |
| `--host` | Host-friendly `<gnosys-recall>` XML-like format |
| `--federated` | Federated search with tier boosting |
| `--scope <scope>` | Filter scopes: `project`, `user`, `global` (comma-separated) |
| `-d, --directory <dir>` | Project directory for federated context |

## Federated path

When `--federated` or `--scope` is set:

1. Opens central DB; exits if unavailable.
2. Calls `federatedSearch` with project detection and scope filter.
3. Outputs recall-like JSON structure, `<gnosys-recall>` host format, or human list.

## Legacy path (default)

When not using federated/scope:

1. Creates `GnosysResolver`, resolves stores; exits if none.
2. Initializes audit via `initAudit(storePath)`.
3. Loads config and merges aggressive override from CLI flags.
4. Builds search index and calls `recall(query, ...)`.
5. Outputs JSON, `formatRecall` (host), or `formatRecallCLI` (human).
6. Closes audit via `closeAudit()`.

## Output formats

- **JSON** — structured recall result (legacy) or federated memory list
- **Host (`--host`)** — `<gnosys-recall>` wrapper for MCP/host injection
- **CLI default** — human-readable formatted recall block

## Validation

```bash
cd gnosys-public
npm run cli -- recall --help
```

## Related commands

- `gnosys discover` / `gnosys search` — browse without recall formatting.
- `gnosys ask` — LLM synthesis over retrieved memories.
