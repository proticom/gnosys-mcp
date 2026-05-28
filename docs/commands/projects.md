# gnosys projects

List registered projects from the central DB, with optional pruning of dead entries.

## Usage

```bash
gnosys projects
gnosys projects --json
gnosys projects --all
gnosys projects --prune --dry-run
gnosys projects --prune --yes
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--all` | Include dead projects (deleted directories) and projects not on this machine |
| `--prune` | Delete registry entries whose directory no longer exists |
| `--dry-run` | With `--prune`: list what would be deleted without deleting |
| `--yes` | With `--prune`: skip the confirmation prompt |

## Behavior

1. Opens the central DB via `GnosysDB.openCentral()`.
2. Loads all projects with `centralDb.getAllProjects()`.
3. Resolves each project's path for this machine via `readMachineConfig()` and `effectiveProjectPath()`.
4. **Normal listing** (default): shows live projects on this machine; hides dead or absent paths unless `--all`.
5. **`--prune`**: finds dead projects, shows them, optionally confirms, then calls `centralDb.deleteProject(p.id)`.

## Output modes

**Human listing** shows project name, ID, resolved directory, memory count, and created date.

**JSON listing** includes `count`, `totalRegistered`, `deadCount`, and `projects`.

**Prune JSON** includes `deleted`, `remaining`, and `deletedProjects`.

**Empty registry:**

```text
No projects registered. Run 'gnosys init' in a project directory.
```

**No live projects:**

```text
No live projects (N dead — run 'gnosys projects --all' to see them or 'gnosys projects --prune' to remove them).
```

## Errors

Central DB unavailable:

```text
Central DB not available (better-sqlite3 missing).
```

Other errors:

```text
Error: <message>
```

Failure paths set `process.exitCode = 1` and return through `finally` so the DB handle is closed.

## Validation

```bash
cd gnosys-public
npm run cli -- projects --help
npx vitest run src/test/projects-command-handler.test.ts
```

## Related commands

- `gnosys init` — register a project.
- `gnosys migrate-db --to-central` — import per-project stores into central DB.
