# gnosys list

List active memories visible from the current project context.

## Usage

```bash
gnosys list
gnosys list --category decisions
gnosys list --tag auth --store project
gnosys list --id-format long --json
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --category <category>` | Filter by category |
| `-t, --tag <tag>` | Filter by tag |
| `-s, --store <store>` | Filter by store layer (`project`, `user`, `global`) |
| `--json` | Output machine-readable JSON |
| `--id-format <format>` | Display IDs as `short`, `long`, or `raw` (default `short`) |

## Behavior

1. Opens central DB (`~/.gnosys/gnosys.db`); exits if unavailable:

   ```text
   Central DB not available. Run 'gnosys init' first.
   ```

2. Detects current project via `findProjectIdentity(process.cwd())`.
3. Loads active memories with `getActiveMemories()`.
4. When a project is detected, scopes results to that project's memories plus `user` and `global` scope memories.
5. Applies optional `--store`, `--category`, and `--tag` filters.
6. Formats IDs with `formatMemoryIdHyperlink`, `buildProjectNameLookup`, and `parseIdFormat`.
7. Closes central DB in `finally`.

## Human output

Lists each memory with scope, status, title, formatted ID, category, and confidence.

## JSON output

With `--json`:

```json
{
  "count": 2,
  "memories": [
    {
      "id": "...",
      "title": "...",
      "category": "...",
      "status": "...",
      "scope": "project",
      "confidence": 0.9,
      "project": "my-project"
    }
  ]
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- list --help
```

## Related commands

- `gnosys discover` — keyword discovery across memories.
- `gnosys read` — read a specific memory from the list.
