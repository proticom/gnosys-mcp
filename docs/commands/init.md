# gnosys init

Initialize or re-sync a Gnosys project store in the target directory.

## Usage

```bash
gnosys init
gnosys init --directory ./path/to/project
gnosys init --name "Project Name"
gnosys init -d ./apps/api -n "Mavenn API"
```

## Options

- `-d, --directory <dir>` — Target directory. Defaults to the current working directory.
- `-n, --name <name>` — Project name. Defaults to the target directory basename.

## Behavior

- Creates `.gnosys/` when it does not exist (first-time init).
- Re-syncs identity and registration when `.gnosys/` already exists.
- Creates project identity and registers the project in the central DB when available.
- Adds `.gnosys/` to the project `.gitignore`.
- Configures supported IDE hooks when `.claude/`, `.cursor/`, or `.codex/` is detected.
- Prints the follow-up `gnosys setup ides` command for MCP wiring.

## Writes and side effects

- Creates `.gnosys/.config/`, tag registry, config template, attachments manifest, and `.gnosys/.gitignore` on first init.
- Writes or updates project identity metadata (`gnosys.json`).
- Registers the project in the file-based project registry and central DB when available.
- May update IDE hook files under the project (Claude Code, Cursor, Codex, etc.).
- May append `.gnosys/` to the project root `.gitignore`.

## Platform notes

### macOS

- **Project store:** `<target-dir>/.gnosys/`
- **Central DB:** `~/.gnosys/gnosys.db` when available
- **IDE hooks:** Detects `~/.../project/.cursor`, `.claude`, or `.codex` and writes hook configs accordingly
- **Paths:** Use forward slashes; `~` expands in shell examples

### Linux

- **Project store:** `<target-dir>/.gnosys/`
- **Central DB:** `~/.gnosys/gnosys.db` when available
- **IDE hooks:** Same detection as macOS under the project directory
- **Paths:** Standard XDG layout; config under `~/.gnosys/` for global settings

### Windows

- **Project store:** `<target-dir>\.gnosys\` (or mixed paths via Node path APIs)
- **Central DB:** Under user profile `~/.gnosys/gnosys.db`
- **IDE hooks:** Detects `.cursor`, `.claude`, or `.codex` in the project folder
- **Paths:** PowerShell accepts both `\` and `/`; prefer quoted paths with spaces

## Validation

```bash
cd gnosys-public
npm run cli -- init --help
```
