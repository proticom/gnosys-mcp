# gnosys centralize

Copy this machine's local brain (`~/.gnosys/gnosys.db`) to seed a central server — a Docker volume or another host.

## Usage

```bash
gnosys centralize --to /path/to/central-gnosys
gnosys centralize --to /path/to/central-gnosys --force
```

## Options

| Option | Description |
|--------|-------------|
| `--to <dir>` | Required target directory that receives `gnosys.db` |
| `--from-local` | Source is this machine's local brain (default; local is the only current source) |
| `--force` | Overwrite an existing `gnosys.db` at the target |

## Behavior

1. Calls `centralizeDb({ to: opts.to, force: opts.force })`.
2. Uses SQLite's online backup API for a consistent copy (WAL-safe while the source is in use).
3. Creates the target directory if needed.
4. Prints source path, target path, size in MB, and `GNOSYS_HOME` / container volume guidance on success.

## Success output

```text
✓ Seeded central brain:
  from: /Users/you/.gnosys/gnosys.db
  to:   /path/to/central-gnosys/gnosys.db (12.3 MB)

Run the server against it with GNOSYS_HOME=/path/to/central-gnosys, or mount this dir as the container's /data volume.
```

## Errors

No local brain:

```text
centralize failed: No local brain found at /Users/you/.gnosys/gnosys.db
```

Target exists without `--force`:

```text
centralize failed: Target already exists: /path/to/central-gnosys/gnosys.db (use --force to overwrite)
```

Failures set `process.exitCode = 1`.

## Platform notes

After centralizing, point the central server at the target directory with `GNOSYS_HOME=<target>`, or mount the directory as the container's `/data` volume.

## Validation

```bash
cd gnosys-public
npm run cli -- centralize --help
npx vitest run src/test/centralize-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys connect`](connect.md) — point an IDE at a remote MCP server
- [`gnosys serve`](serve.md) — run a local MCP server
- [`gnosys setup remote`](setup-remote.md) — configure remote sync for the local brain
