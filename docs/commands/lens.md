# gnosys lens

Filtered view of memories. Combine criteria to focus on what matters.

## Usage

```bash
gnosys lens --category decisions
gnosys lens --tag auth security --match all
gnosys lens --status active archived --min-confidence 0.75 --json
gnosys lens --category decisions --author ai --or
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --category <category>` | Filter by category |
| `-t, --tag <tags...>` | Filter by tag(s) |
| `--match <mode>` | Tag match mode: `any` (default) or `all` |
| `--status <statuses...>` | Filter by status (`active`, `archived`, `superseded`) |
| `--author <authors...>` | Filter by author (`human`, `ai`, `human+ai`) |
| `--authority <authorities...>` | Filter by authority (`declared`, `observed`, `imported`, `inferred`) |
| `--min-confidence <n>` | Minimum confidence (0–1) |
| `--max-confidence <n>` | Maximum confidence (0–1) |
| `--created-after <date>` | Created after ISO date |
| `--created-before <date>` | Created before ISO date |
| `--modified-after <date>` | Modified after ISO date |
| `--modified-before <date>` | Modified before ISO date |
| `--or` | Combine filters with OR instead of AND (default: AND) |
| `--json` | Output as JSON |

## Behavior

1. Loads all memories via `getResolver().getAllMemories()`.
2. Builds a `LensFilter` from CLI options.
3. With `--or`, sets `operator: "OR"` so a memory matches if **any** active criterion matches; otherwise all active criteria must match (AND).
4. Applies `applyLens` and outputs human-readable results or JSON.

## Human output

Empty result:

```text
No memories match the lens filter.
```

Matches:

```text
2 memories match:

  [active] Auth Decision (0.9)
    project:decisions/d1.md
```

## JSON output

```json
{
  "count": 2,
  "items": [
    {
      "title": "Auth Decision",
      "status": "active",
      "confidence": 0.9,
      "sourceLabel": "project",
      "relativePath": "decisions/d1.md"
    }
  ]
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- lens --help
```

## Related commands

- `gnosys list` — list memories without compound lens filters.
- `gnosys discover` — keyword discovery across memories.
