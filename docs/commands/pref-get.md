# gnosys pref get

Get one user preference by key, or list all preferences.

## Usage

```bash
gnosys pref get
gnosys pref get code-style
gnosys pref get --json
gnosys pref get code-style --json
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

## Behavior

1. Opens the central DB via `GnosysDB.openCentral()`.
2. With a key: reads one preference via `getPreference(centralDb, key)`.
3. Without a key: lists all preferences via `getAllPreferences(centralDb)`.

## Output modes

**Single preference (human):**

```text
Code Style (code-style)

Prefer small, focused changes

Confidence: high
Modified: 2026-05-28T...
```

**List (human):**

```text
3 user preference(s):

  Code Style (code-style)
    Prefer small, focused changes

  ...
```

**Single preference (JSON):** preference object.

**List (JSON):** `{ "count": N, "preferences": [...] }`

**Empty list (JSON):** `{ "preferences": [] }`

**Missing key:**

```text
No preference found for key "unknown-key".
```

**Empty registry (human):**

```text
No preferences set. Use 'gnosys pref set <key> <value>' to add some.
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

Failure paths set `process.exitCode = 1` and return through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- pref get --help
node scripts/audit-commands.mjs --write
```

## Related commands

- [gnosys pref](pref.md) — parent command overview
- [gnosys pref set](pref-set.md) — set a preference
- [gnosys pref delete](pref-delete.md) — remove a preference
