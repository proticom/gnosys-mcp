# gnosys ambiguity

Check if a query matches memories in multiple projects.

## Usage

```bash
gnosys ambiguity "deployment"
gnosys ambiguity "deployment" --json
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

## Behavior

1. Opens the central DB via `GnosysDB.openCentral()`.
2. Calls `detectAmbiguity(centralDb, query)` from `src/lib/federated.js`.
3. Reports whether the query is ambiguous across projects.

## Output modes

**No ambiguity (human):**

```text
No ambiguity for "deployment" — matches at most one project.
```

**Ambiguous (human):** message plus candidate projects with directory and matching memory counts.

**JSON** (`--json`):

```json
{
  "query": "deployment",
  "ambiguous": true,
  "message": "...",
  "candidates": [...]
}
```

## Errors

Central DB unavailable:

```text
Central DB not available.
```

Other errors:

```text
Error: <message>
```

Failure paths set `process.exitCode = 1` and return through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- ambiguity --help
npx vitest run src/test/ambiguity-command-handler.test.ts
```

## Related commands

- `gnosys fsearch` — federated search with tier boosting
- `gnosys briefing` — project memory state summary
