# gnosys status

Show project, portfolio, remote sync, or system status. Replaces the removed `gnosys dashboard` and `gnosys portfolio` commands.

## Usage

```bash
gnosys status
gnosys status --project <id>
gnosys status --directory /path/to/project
gnosys status --projects
gnosys status --global
gnosys status --remote
gnosys status --system
gnosys status --web
gnosys status --json
```

## Options

| Option | Description |
|--------|-------------|
| `-d, --directory <dir>` | Project directory (auto-detects if omitted) |
| `-p, --project <id>` | Project ID |
| `-g, --global` | Deprecated alias for `--projects` |
| `--projects` | All-projects portfolio view |
| `-r, --remote` | Remote sync status |
| `-w, --web` | Open HTML dashboard in browser |
| `-s, --system` | System health (memory, LLM, embeddings, archive) |
| `--json` | Output as JSON |

## Mode precedence

Mutually exclusive branches (first match wins):

1. **`--remote`** — remote sync status via `RemoteSync.getStatus()`
2. **`--system`** — dashboard/system health via `collectDashboardData`
3. **Default path** — portfolio report; then:
   - **`--web`** — write/open HTML dashboard
   - **`--projects` / `--global`** — all-projects portfolio summary
   - **Default** — single current project status

`--projects` sets `--global` internally (deprecated alias preserved).

## Output

**Default (single project):** readiness score, memory counts, latest status snapshot, action items, blocking items, completed items.

**`--projects`:** portfolio table with readiness per project and action-item summary.

**`--remote`:** formatted sync status or not-configured message.

**`--system`:** dashboard text or JSON.

**`--web`:** writes `~/gnosys-dashboard.html` and opens it.

**`--json`:** JSON for the active mode.

## Errors

| Condition | Message |
|-----------|---------|
| Central DB unavailable | `Central DB not available.` |
| No stores (system) | `No Gnosys stores found. Run gnosys init first.` |
| No project detected | `No project detected...` |
| Project not found | `Project not found: <id>` |
| No memories / snapshot | `No memories found for project...` |
| Other errors | `Error: <message>` |

Failure paths set `process.exitCode = 1` and return through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- status --help
npx vitest run src/test/status-command-handler.test.ts
```

## Related commands

- `gnosys update-status` — prompt to refresh project status snapshot
- `gnosys briefing` — project memory briefing
- `gnosys setup remote status` — remote sync (alias target for `--remote`)
