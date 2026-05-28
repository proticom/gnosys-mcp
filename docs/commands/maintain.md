# gnosys maintain

Run vault maintenance: detect duplicates, apply confidence decay, and consolidate similar memories.

## Usage

```bash
gnosys maintain
gnosys maintain --dry-run
gnosys maintain --auto-apply
```

## Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Show what would change without modifying anything |
| `--auto-apply` | Automatically apply all changes (no prompts) |

## Behavior

1. Resolves configured stores via the project resolver.
2. Loads config from the primary store path.
3. Runs `GnosysMaintenanceEngine.maintain` with dry-run/auto-apply options.
4. Prints log messages and progress updates during maintenance.
5. Prints a blank line, then `formatMaintenanceReport(report)`.

## Log levels

- **warn** — printed to stderr with a warning prefix
- **action** — printed with an action prefix
- **info** — printed as plain log lines

## Progress output

```text
[3/5] scanning duplicates...
```

## Errors

No stores configured:

```text
No Gnosys stores found. Run gnosys init first.
```

Exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- maintain --help
npx vitest run src/test/maintain-command-handler.test.ts
```

## Related commands

- `gnosys stale` — find memories not touched recently.
- `gnosys prune` — remove archived or stale data.
- `gnosys doctor` — diagnose store and config health.
