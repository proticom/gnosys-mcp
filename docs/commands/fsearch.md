# gnosys fsearch

Federated search across project, user, and global scopes with tier boosting.

## Usage

```bash
gnosys fsearch "auth tokens"
gnosys fsearch "auth tokens" --scope project,user
gnosys fsearch "auth tokens" --no-global --json
gnosys fsearch "auth tokens" --directory /path/to/project --limit 10
```

## Options

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Max results (default `20`) |
| `-d, --directory <dir>` | Project directory for context detection |
| `--no-global` | Exclude global-scope memories |
| `--scope <scope>` | Filter scopes: `project`, `user`, `global` (comma-separated) |
| `--json` | Output results as JSON |

## Behavior

1. Opens central DB; exits if unavailable (`Central DB not available.`).
2. Detects current project via `--directory` when provided.
3. Parses comma-separated `--scope` values.
4. Calls `federatedSearch` with `includeGlobal` derived from Commander's `--no-global` negation (`opts.global`).
5. Closes central DB in `finally`.

## Human output

Prints project context line, then ranked results with scope, score, boosts, and snippet preview.

No results:

```text
No results for "<query>".
```

Context lines:

```text
Context: project <projectId>
```

or

```text
No project detected
```

## JSON output

```json
{
  "query": "...",
  "projectId": "...",
  "count": 3,
  "results": [ ... ]
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- fsearch --help
```

## Related commands

- `gnosys search` — local FTS search without federated tier boosting.
- `gnosys discover` — keyword discovery.
