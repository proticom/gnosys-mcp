# gnosys scan

Discover Gnosys projects under this machine's configured roots (`machine.json`) and record their machine-portable locations in the central DB.

## Usage

```bash
gnosys scan
gnosys scan --json
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output scan results as JSON |

## Behavior

1. Ensures `machine.json` exists via `ensureMachineConfig()`.
2. Requires at least one root in `machine.roots`; otherwise prints setup guidance and exits 1.
3. Opens the central DB via `GnosysDB.openCentral()`.
4. Calls `scanProjects(db, machine)` for each configured root.
5. Closes the DB and prints human summary or JSON via `outputResult`.

When `ensureMachineConfig()` regenerates `machineId` due to hostname mismatch, a warning line is printed before the scan summary.

## Human output

```text
Scanned 1 root(s); registered 3 project(s):
  my-app  [registered]  /Users/you/projects/my-app
  other   [registered]  /Users/you/projects/other
```

With hostname regeneration:

```text
⚠ machine.json hostname mismatch — regenerated machineId for this machine.

Scanned 1 root(s); registered 3 project(s):
  ...
```

## JSON output

With `--json`, emits:

```json
{
  "machineId": "abc123...",
  "roots": ["dev"],
  "count": 3,
  "entries": [
    {
      "projectId": "...",
      "name": "my-app",
      "absPath": "/Users/you/projects/my-app",
      "mode": "registered"
    }
  ]
}
```

## Errors

No roots configured:

```text
No project roots configured for this machine.
Add roots to /Users/you/.gnosys/machine.json, e.g.
  { "roots": { "dev": "/Users/edward/MSDev/projects" } }
```

Central DB unavailable:

```text
Central DB not available (better-sqlite3 missing).
```

Both exit with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- scan --help
npx vitest run src/test/scan-command-handler.test.ts
npx vitest run src/test/v511-projectScan.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys machine show`](machine-show.md) — display current `machine.json`
- [`gnosys machine migrate`](machine-migrate.md) — create `machine.json` and optionally scan
- `gnosys projects` — list registered projects
