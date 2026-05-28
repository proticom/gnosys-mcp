# gnosys pref set

Set a user-scoped preference memory.

## Usage

```bash
gnosys pref set <key> <value>
gnosys pref set code-style "Prefer small, focused changes"
gnosys pref set code-style "Prefer small changes" --title "Code Style"
gnosys pref set code-style "Prefer small changes" --tags coding,workflow
```

## Options

| Option | Description |
|--------|-------------|
| `-t, --title <title>` | Human-readable title for the preference |
| `--tags <tags>` | Comma-separated tags |

## Behavior

1. Opens the central DB via `GnosysDB.openCentral()`.
2. Validates the key against known preference keys; suggests a close match via `suggestPreferenceKey` when applicable.
3. Stores the preference with `setPreference(centralDb, key, value, { title, tags })`.
4. Prints confirmation and reminds you to run `gnosys sync` to update agent rules files.

Preferences are user-scoped memories surfaced into every agent's context, not project-scoped.

## Output

```text
Preference set: Code Style
  Key:   code-style
  Value: Prefer small changes

Run 'gnosys sync' to update agent rules files.
```

## Errors

Central DB unavailable:

```text
Central DB not available (better-sqlite3 missing).
```

Unknown key with suggestion:

```text
Unknown preference key `code-styl` — did you mean `code-style`?
```

Other errors:

```text
Error: <message>
```

Failure paths set `process.exitCode = 1` and return through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- pref set --help
node scripts/audit-commands.mjs --write
```

## Related commands

- [gnosys pref](pref.md) — parent command overview
- [gnosys pref get](pref-get.md) — read preferences
- [gnosys pref delete](pref-delete.md) — remove a preference
- `gnosys sync` — regenerate agent rules from preferences
