# gnosys setup preferences

Review and manage user-scope preferences used by Gnosys agents.

## Usage

```bash
gnosys setup preferences
```

## Behavior

- Opens the interactive preferences review screen.
- Lists active user-scope memories, including native preferences and imported/unknown user memories.
- Lets you create a new preference.
- Lets you view, edit, keep, or delete existing preferences.
- Returns to setup after you back out.

## Writes and side effects

- Reads active user-scope memories from the central Gnosys DB.
- Creates or updates `pref-<key>` preference memories through `setPreference`.
- Deletes preference memories through `deletePreference`, with direct delete fallback for legacy IDs.
- Preference values are later injected into agent rules/system prompt context.

## Platform notes

### macOS

- **Storage:** User-scope preferences live in the central Gnosys DB (`~/.gnosys/gnosys.db` by default).
- **Access:** Same DB path whether invoked from Terminal, iTerm, or IDE-integrated terminals.

### Linux

- **Storage:** Same central DB under `~/.gnosys/gnosys.db` (or the configured remote store when sync is enabled).
- **Access:** Works from any shell session with read/write access to the Gnosys home directory.

### Windows

- **Storage:** Central DB under the user profile (`~/.gnosys/gnosys.db`).
- **Access:** Run from PowerShell or cmd; ensure the Gnosys home directory is writable.

## Validation

```bash
cd gnosys-public
npm run cli -- setup preferences --help
```
