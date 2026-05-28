# gnosys update-status

Print the prompt an AI agent should use to create a dashboard-compatible project status memory.

## Usage

```bash
gnosys update-status
gnosys update-status --project <id>
gnosys update-status --directory /path/to/project
```

## Options

| Option | Description |
|--------|-------------|
| `-d, --directory <dir>` | Project directory (auto-detects if omitted) |
| `-p, --project <id>` | Project ID |

## Project resolution

1. `--project <id>` if provided
2. Otherwise auto-detect from `--directory` or current working directory via `detectCurrentProject`

## Output

Prints the status-update prompt from `generateStatusPrompt(projectName, workingDirectory)` to stdout.

## Errors

| Condition | Message |
|-----------|---------|
| Central DB unavailable | `Central DB not available.` |
| No project detected | `No project specified and none detected.` |
| Project not found | `Project not found: <id>` |
| Other errors | `Error: <message>` |

Failure paths set `process.exitCode = 1` and return through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- update-status --help
npx vitest run src/test/update-status-command-handler.test.ts
```

## Related commands

- `gnosys status` — view current project or portfolio status
- `gnosys projects` — list registered projects
