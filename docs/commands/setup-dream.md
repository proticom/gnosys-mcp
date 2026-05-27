# gnosys setup dream

Configure Dream Mode for idle-time memory consolidation on this machine.

## Usage

```bash
gnosys setup dream
```

## Behavior

- Runs the interactive three-step Dream Mode setup flow.
- Enables or disables Dream Mode.
- Designates this machine as the dream node, or clears or keeps an existing designation.
- Chooses the dream provider and model and validates access when possible.
- Configures idle minutes, max runtime, minimum memories, self-critique, summary generation, and relationship discovery.

## Writes and side effects

- Updates the active Gnosys config `dream` block in `~/.gnosys/gnosys.json`.
- Writes or clears `dream_machine_id` in the local central DB and mirrors it to the remote DB when configured and reachable.
- Resets Dream Mode consecutive failure counters after setup completes.
- May read provider API keys from environment variables or platform secure storage.

## Platform notes

### macOS

- **API keys:** macOS Keychain (recommended), environment variables, or `~/.config/gnosys/.env`
- **Machine designation:** Stored in the local central DB; synced to remote when multi-machine sync is configured
- **Shell profile:** `~/.zshrc` or `~/.bash_profile` if setting provider keys manually

### Linux

- **API keys:** GNOME Keyring when `secret-tool` is available, environment variables, or `~/.config/gnosys/.env`
- **Machine designation:** Same as macOS — local DB with optional remote mirror
- **Shell profile:** `~/.bashrc` or `~/.zshrc` for manual env vars

### Windows

- **API keys:** Environment variables or `~/.config/gnosys/.env`
- **Machine designation:** Same DB behavior; use PowerShell or System Environment Variables for keys
- **Shell profile:** PowerShell profile (`$PROFILE`) for persistent env vars

## Validation

```bash
cd gnosys-public
npm run cli -- setup dream --help
```
