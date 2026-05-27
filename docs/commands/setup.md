# gnosys setup

Configure Gnosys for a project or machine: LLM provider and model, API key storage, task routing, remote sync, Dream Mode, and IDE integrations.

## Usage

```bash
gnosys setup
gnosys setup --full
gnosys setup --non-interactive
```

## Options

- `--full` — Run the full linear setup wizard even when `~/.gnosys/gnosys.json` already exists.
- `--non-interactive` — Skip prompts and use defaults (for CI and scripting).

## Behavior

- On first run (no config), runs the linear setup wizard via `runSetup`.
- When config already exists and neither `--full` nor `--non-interactive` is passed, opens the summary-first menu so you can edit one section without re-running the whole wizard.
- Subcommands such as `gnosys setup models`, `gnosys setup ides`, and `gnosys setup remote` configure individual sections.

## Writes and side effects

- Reads and writes the active Gnosys config (`~/.gnosys/gnosys.json`).
- May store provider API keys in the platform secure store or `~/.config/gnosys/.env`.
- May write IDE MCP entries (Cursor, VS Code, Claude Desktop, and others) through setup subflows.

## Platform notes

### macOS

- **Config:** `~/.gnosys/gnosys.json`
- **API keys:** macOS Keychain (recommended), or environment variables, or `~/.config/gnosys/.env`
- **Shell profile:** `~/.zshrc` or `~/.bash_profile` / `~/.bashrc` for manual env vars
- **Claude Desktop MCP config:** `~/Library/Application Support/Claude/claude_desktop_config.json`

### Linux

- **Config:** `~/.gnosys/gnosys.json`
- **API keys:** GNOME Keyring when `secret-tool` is available, or environment variables, or `~/.config/gnosys/.env`
- **Shell profile:** `~/.bashrc` or `~/.zshrc` for manual env vars
- **Claude Desktop MCP config:** `~/.config/Claude/claude_desktop_config.json`

### Windows

- **Config:** `~/.gnosys/gnosys.json` (under your user profile)
- **API keys:** Environment variables or `~/.config/gnosys/.env` (Credential Manager support varies by provider flow)
- **Shell profile:** PowerShell profile (`$PROFILE`) or System Properties → Environment Variables
- **Claude Desktop MCP config:** `%APPDATA%\Claude\claude_desktop_config.json`

## Validation

```bash
cd gnosys-public
npm run cli -- setup --help
npm run cli -- setup --non-interactive
```
