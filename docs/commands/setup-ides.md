# gnosys setup ides

Configure IDE MCP integrations so supported IDEs can call the Gnosys MCP server.

## Usage

```bash
gnosys setup ides
gnosys setup ides --all
```

## Options

- `--all` — Configure every supported IDE non-interactively.

## Behavior

- Without flags, opens the interactive IDE integration picker.
- With `--all`, runs the non-interactive setup path for all supported IDEs.
- Supports Claude Code + Desktop, Cursor, Codex, Gemini CLI, Antigravity, and Grok Build.
- Detects which IDEs are already present in the current project directory.
- Prints a configured/error summary when finished.

## Writes and side effects

- Writes MCP server configuration for selected IDEs.
- May create project-level IDE config directories such as `.cursor/`.
- May update user-level IDE configuration files or CLI registries (Claude Desktop, Gemini, Antigravity, Grok Build, Codex MCP registry).
- Does not modify Gnosys memory stores directly; it wires the `gnosys-mcp` stdio server into IDE configs.

## Platform notes

### macOS

- **Claude Desktop:** Updates `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **Claude Code / Codex:** Uses CLI registry commands (`claude mcp add`, `codex mcp add`).
- **Cursor:** Writes project-level `.cursor/mcp.json` in the current directory.
- **Gemini CLI / Antigravity:** Updates user-level JSON under `~/.gemini/`.
- **Grok Build:** Updates `~/.grok/config.toml` with an `[mcp_servers.gnosys]` entry.

### Linux

- **User-level IDEs:** Same config paths as macOS where applicable (`~/.gemini/`, `~/.grok/config.toml`, Claude Desktop config when present).
- **Cursor:** Creates or updates project-level `.cursor/mcp.json`.
- **CLI registries:** Claude Code and Codex use their respective CLI `mcp add` commands.

### Windows

- **User-level configs:** Claude Desktop, Gemini, Antigravity, and Grok Build use the same relative paths under the user profile (`~` expands to `%USERPROFILE%`).
- **Cursor:** Project-level `.cursor/mcp.json` in the current working directory.
- **CLI registries:** Run from PowerShell or cmd; ensure `claude` / `codex` are on `PATH` before using interactive setup.

## Validation

```bash
cd gnosys-public
npm run cli -- setup ides --help
```
