# gnosys migrate-db

Legacy data migration command. Supports per-store v1→v2 migration and optional central DB consolidation.

## Usage

```bash
gnosys migrate-db
gnosys migrate-db -v
gnosys migrate-db --to-central
gnosys migrate-db --to-central --verbose
```

## Options

| Option | Description |
|--------|-------------|
| `--to-central` | Migrate all discovered per-project stores into `~/.gnosys/gnosys.db` |
| `-v, --verbose` | Verbose output |

## Legacy mode (default)

When `--to-central` is absent:

1. Resolves the writable store via `getResolver()`.
2. Runs `migrate(storePath, { verbose })` from `src/lib/migrate.js`.
3. Prints `formatMigrationReport(stats)`.

**No writable store:**

```text
No writable store found. Run 'gnosys init' first.
```

Exits with code 1 via `process.exitCode`.

## Central mode (`--to-central`)

1. Opens the central DB via `GnosysDB.openCentral()`.
2. Discovers all registered project stores with `resolver.detectAllStores()`.
3. For each project with `.gnosys`:
   - Creates project identity via `createProjectIdentity`.
   - Opens the per-project DB, imports memories into central DB in a transaction.
   - Skips projects without a migrated `gnosys.db`.
4. Prints a central migration summary.
5. Per-project `gnosys.db` files are left untouched.

**Central DB unavailable:**

```text
Central DB not available (better-sqlite3 missing).
```

**Central DB open failure:**

```text
Cannot open central DB: <message>
```

**No stores found:**

```text
No per-project stores found to migrate.
```

Per-project errors are logged as `✗ <dir>: <message>` without stopping the whole run.

## DB cleanup

Central and per-project DB handles close through `finally` blocks. Expected failures use `process.exitCode = 1; return;`.

## Validation

```bash
cd gnosys-public
npm run cli -- migrate-db --help
npx vitest run src/test/migrate-db-command-handler.test.ts
```

## Related commands

- `gnosys migrate` — interactive project directory migration.
- `gnosys init` — initialize a project store before legacy migration.
