# gnosys stats

Show summary statistics for the memory store.

## Usage

```bash
gnosys stats
gnosys stats --json
gnosys stats --by-project
gnosys stats --all
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output machine-readable JSON |
| `--by-project` | Per-project breakdown table across the central DB |
| `--all` | Include all projects (don't filter to current project) |

## Behavior

1. Opens central DB; exits with `Central DB not available. Run 'gnosys init' first.` if unavailable.
2. **Default path:** Resolves current project via `findProjectIdentity(process.cwd())` unless `--all` is set. Loads active memories, filtering to current project plus user/global scope when a project is detected.
3. **By-project path:** Loads all projects and memories, builds per-project rows plus optional `(user)` and `(global)` rows, sorts by active count, and prints a table or JSON `{ rows }`.
4. Converts DB memories to the shape expected by `computeStats` for default stats.
5. Closes DB in `finally`; errors print `Error: <message>` and exit 1.

## Empty output

Default path with no matching memories:

```text
No memories found.
```

JSON:

```json
{
  "totalCount": 0
}
```

## Default human output

```text
Gnosys Store Statistics:

  Total memories: 42
  Average confidence: 0.85
  Date range: 2025-01-01 → 2026-05-01
  Last modified: 2026-05-01

  By category:
    decisions: 10

  By status:
    active: 40

  By author:
    human: 30
```

## By-project table output

```text
  PROJECT   ID            ACTIVE  ARCHIVED   REINF  LAST MODIFIED
  ----------------------------------------------------------------
  my-app    proj-001          10         2       5  2026-05-01T12:00:00
  TOTAL                        10
```

## JSON output

Default stats returns the `computeStats` object. `--by-project --json` returns `{ "rows": [...] }`.

## Validation

```bash
cd gnosys-public
npm run cli -- stats --help
npx vitest run src/test/stats-command-handler.test.ts
```

## Related commands

- `gnosys timeline` — creation/modification timeline grouped by period.
- `gnosys stores` — inspect store configuration.
