# gnosys doctor

Check Gnosys system health: stores, central DB, archive, recall/SOC config, LLM connectivity, embeddings, and maintenance health.

## Usage

```bash
gnosys doctor
gnosys doctor --fix
```

## Behavior

- Prints a read-only health report by default (no files modified).
- **Central DB:** migration status, schema version, memory counts.
- **Stores:** lists active stores and memory counts per store.
- **Archive:** two-tier memory stats when available.
- **Recall:** aggressive vs filtered mode, max memories, min relevance.
- **SOC:** default provider and task routing (structuring/synthesis).
- **LLM connectivity:** tests each configured provider.
- **Embeddings:** index size or empty/not-initialized state.
- **Maintenance health:** stale-memory and reinforcement stats from central DB.
- **Legacy local `gnosys.db`:** warns if a pre-v2.0 per-store DB file exists.
- **`--fix`:** when a legacy local `gnosys.db` is found, verifies it is safe to remove (empty or all IDs present in central DB), then prompts interactively before deletion.

## Output example

```text
Gnosys Doctor
=============

Central DB (~/.gnosys/gnosys.db):
  Status: ✓ migrated (schema v...)
  Active: 42 | Archived: 3 | Total: 45

Stores:
  project: 12 memories (/path/to/.gnosys)
...
```

## Platform notes

### macOS

- Central DB path shown as `~/.gnosys/gnosys.db`.
- Legacy per-store DB cleanup with `--fix` uses an interactive `[y/N]` prompt in the terminal.

### Linux

- Same checks as macOS. Requires `better-sqlite3` for central DB and archive sections.

### Windows

- Paths may display with backslashes; behavior is equivalent.
- Interactive `--fix` prompt works in PowerShell and cmd.

## Validation

```bash
cd gnosys-public
npm run cli -- doctor --help
npm run cli -- doctor
```

## Related commands

- `gnosys check` — test LLM connectivity per task type.
- `gnosys upgrade` — migrate central DB when doctor reports not migrated.
