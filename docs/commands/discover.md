# gnosys discover

Discover relevant memories by keyword.

## Usage

```bash
gnosys discover "auth tokens"
gnosys discover "auth tokens" --federated
gnosys discover "auth tokens" --scope project,user --directory /path/to/project
gnosys discover "auth tokens" --json --id-format raw
```

## Options

| Option | Description |
|--------|-------------|
| `-n, --limit <number>` | Max results (default `20`) |
| `--json` | Output results as JSON |
| `--federated` | Tier-boosted cross-scope discovery (project > user > global) |
| `--scope <scope>` | Filter scopes: `project`, `user`, `global` (comma-separated) |
| `-d, --directory <dir>` | Project directory for context detection |
| `--id-format <format>` | ID display: `short`, `long`, or `raw` (default `short`) |

## Default path (FTS)

When neither `--federated` nor `--scope` is set:

1. Opens the central DB (`~/.gnosys/gnosys.db`).
2. Runs `discoverFts` against the query.
3. Formats results with project name lookup and `formatMemoryIdHyperlink`.

If the central DB is unavailable:

```text
Central DB not available. Run 'gnosys init' first.
```

No results:

```text
No memories found for "<query>". Try gnosys search for full-text.
```

## Federated / scope path

When `--federated` or `--scope` is set:

1. Opens central DB; exits if unavailable (`Central DB not available.`).
2. Detects current project via `--directory` when provided.
3. Parses comma-separated `--scope` values.
4. Calls `federatedDiscover` with limit, project ID, and scope filter.

Human output lists title, category, optional project name, scope, and score. Empty results:

```text
No memories found for "<query>".
```

## JSON output

With `--json`:

- **Federated:** `{ query, projectId, count, results }`
- **Default FTS:** `{ query, count, results }` or `{ query, results: [] }` when empty

## Platform notes

- Default FTS requires a initialized central DB (`gnosys init`).
- Federated discovery uses the same central DB; scope filtering respects project/user/global tiers.

## Validation

```bash
cd gnosys-public
npm run cli -- discover --help
```

## Related commands

- `gnosys search` — full-text search with snippets.
- `gnosys read` — read a specific memory after discovery.
