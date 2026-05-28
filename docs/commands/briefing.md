# gnosys briefing

Generate a project briefing: memory state summary, categories, recent activity, and top tags.

## Usage

```bash
gnosys briefing
gnosys briefing <projectNameOrId>
gnosys briefing --project <id>
gnosys briefing --directory /path/to/project
gnosys briefing --all
gnosys briefing --json
```

## Options

| Option | Description |
|--------|-------------|
| `-p, --project <id>` | Project ID (auto-detects if omitted) |
| `-a, --all` | Generate briefings for all projects |
| `-d, --directory <dir>` | Project directory for auto-detection |
| `--json` | Output as JSON |

## Project resolution

For a single-project briefing (without `--all`):

1. Positional `projectNameOrId` — matched by ID first, then by registered name
2. `--project <id>`
3. Current working directory auto-detection (optional `--directory`)

## Output modes

**All projects (`--all`, human):** section per project with name and summary.

**All projects (`--all`, JSON):**

```json
{ "count": 2, "briefings": [...] }
```

**Single project (human):** heading, directory, memory counts, categories, recent activity, top tags, summary.

**Single project (`--json`):** full briefing object from `generateBriefing`.

## Errors

| Condition | Message |
|-----------|---------|
| Central DB unavailable | `Central DB not available.` |
| Positional name not found | `Project not found: "<name>". Run 'gnosys projects'...` |
| No project detected | `No project specified and none detected.` |
| Project ID not found | `Project not found: <id>` |
| Other errors | `Error: <message>` |

Failure paths set `process.exitCode = 1` and return through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- briefing --help
npx vitest run src/test/briefing-command-handler.test.ts
```

## Related commands

- `gnosys projects` — list registered projects
- `gnosys status` — broader project/system status views
- `gnosys ambiguity` — cross-project query ambiguity check
