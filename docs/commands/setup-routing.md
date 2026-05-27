# gnosys setup routing

Configure per-task LLM routing for Gnosys tasks.

## Usage

```bash
gnosys setup routing
```

## Behavior

- Opens the interactive task-routing wizard.
- Shows effective routing for structuring, synthesis, chat, vision, transcription, and dream.
- Lets you keep current routing, customize individual tasks, or reset task overrides to the default provider/model.
- Updates Dream Mode routing when dream routing is enabled or changed.

## Writes and side effects

- Updates `taskModels` in the active Gnosys config.
- Updates the `dream` config block when Dream Mode routing is changed.
- Writes the resulting config under the active store, normally `.gnosys/gnosys.json` in the project or `~/.gnosys/gnosys.json` globally.

## Platform notes

### macOS

- **Active store:** Project `.gnosys/gnosys.json` when present; otherwise `~/.gnosys/gnosys.json`.
- **API keys:** Provider keys may be read from macOS Keychain, environment variables, or `~/.config/gnosys/.env` when validating model choices.

### Linux

- **Active store:** Same project-first rule — `.gnosys/gnosys.json` in the current directory when the project is initialized.
- **API keys:** GNOME Keyring (when available), environment variables, or `~/.config/gnosys/.env`.

### Windows

- **Active store:** Project `.gnosys/gnosys.json` when initialized; otherwise the global config under the user profile.
- **API keys:** Environment variables or `~/.config/gnosys/.env`; set provider keys in PowerShell or System Environment Variables.

## Validation

```bash
cd gnosys-public
npm run cli -- setup routing --help
```
