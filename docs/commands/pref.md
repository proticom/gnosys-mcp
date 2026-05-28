# gnosys pref

Manage user-scoped preferences stored as memories and surfaced into agent context.

## Usage

```bash
gnosys pref set code-style "Prefer small, focused changes"
gnosys pref set code-style "Prefer small changes" --title "Code Style" --tags coding,workflow
gnosys pref get
gnosys pref get code-style
gnosys pref get --json
gnosys pref delete code-style
```

## Subcommands

### `pref set <key> <value>`

Set a user preference. Keys should be kebab-case.

| Option | Description |
|--------|-------------|
| `-t, --title <title>` | Human-readable title |
| `--tags <tags>` | Comma-separated tags |

Validates against known preference keys and suggests corrections via `suggestPreferenceKey` when a close match exists.

After setting, run `gnosys sync` to update agent rules files.

### `pref get [key]`

Get one preference by key, or list all preferences when no key is given.

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

### `pref delete <key>`

Delete a user preference by key. Run `gnosys sync` afterward to refresh agent rules files.

## Behavior

- Opens the central DB via `GnosysDB.openCentral()`.
- Uses `setPreference`, `getPreference`, `getAllPreferences`, and `deletePreference` from `src/lib/preferences.js`.
- Preferences are user-scoped memories, not project-scoped.
- Review and clean up preferences with `gnosys setup preferences`.

## Output

**Set success:**

```text
Preference set: Code Style
  Key:   code-style
  Value: Prefer small changes

Run 'gnosys sync' to update agent rules files.
```

**Get JSON** (`--json`): single preference object or `{ count, preferences }` for list mode.

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
npm run cli -- pref --help
npx vitest run src/test/pref-command-handler.test.ts
```

## Related commands

- `gnosys sync` — regenerate agent rules from preferences.
- `gnosys setup preferences` — review and clean up user preferences.
