# gnosys export

Export Gnosys memory to an Obsidian-compatible vault or a portable project bundle.

## Usage

```bash
gnosys export
gnosys export vault --to ./vault
gnosys export --to ./vault
gnosys export project --to ./project.gnosys.json.gz
gnosys export project <projectId> --to ./project.gnosys.json.gz
```

Bare `gnosys export` prints usage and exits with code 1.

## Subcommands

| Subcommand | Purpose |
|------------|---------|
| `vault` | Export store to Obsidian-compatible markdown vault |
| `project [projectId]` | Export a single project to `.json.gz` bundle |

## Legacy shim

`gnosys export --to <dir>` is rewritten to `gnosys export vault --to <dir>` before parsing (v5.5.x compatibility).

## `gnosys export vault`

```bash
gnosys export vault --to ./vault
gnosys export vault --to ./vault --all --overwrite --json
```

| Option | Description |
|--------|-------------|
| `--to <dir>` | Target directory (required) |
| `--all` | Export active + archived memories |
| `--overwrite` | Overwrite existing files |
| `--no-summaries` | Skip category summaries |
| `--no-reviews` | Skip review suggestions |
| `--no-graph` | Skip relationship graph |
| `--json` | Output raw JSON report |

Requires a migrated project store (`gnosys.db` v2.0).

## `gnosys export project`

```bash
gnosys export project --to ./bundle.gnosys.json.gz
gnosys export project my-project --to ./bundle.gnosys.json.gz --include-archived --no-audit --json
```

| Option | Description |
|--------|-------------|
| `--to <file>` | Output bundle path (required) |
| `--include-archived` | Include archived/superseded memories |
| `--no-audit` | Skip audit log in bundle |
| `--json` | Output result as JSON |

When `projectId` is omitted, auto-detects from the current working directory registry entry.

## Errors

No stores (vault):

```text
No Gnosys stores found. Run 'gnosys init' first.
```

Unmigrated DB (vault):

```text
Export requires gnosys.db (v2.0). Run 'gnosys migrate' first.
```

Central DB unavailable (project):

```text
Central DB unavailable.
```

Unregistered cwd (project, no id):

```text
No project ID given and current directory is not a registered project.
```

## Validation

```bash
cd gnosys-public
npm run cli -- export --help
npx vitest run src/test/export-command-handler.test.ts
```

## Related commands

- `gnosys import project` — restore a project bundle.
- `gnosys dream log` — view dream run audit entries.
