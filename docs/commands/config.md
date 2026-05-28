# gnosys config

View and manage LLM provider configuration for the active Gnosys store.

## Usage

```bash
gnosys config show
gnosys config show --json
gnosys config set provider openai
gnosys config set model gpt-4.1
gnosys config set ollama-url http://127.0.0.1:11434
gnosys config set task structuring openai gpt-4.1-mini
gnosys config set recall maxMemories 8
gnosys config init
gnosys config init --force
```

## Behavior

- `show` reads config from the first active store and prints a human-readable SOC summary (default provider, per-provider models/keys, task routing). With `--json`, dumps the effective config object as JSON for scripts.
- `set <key> <value> [extra...]` validates the key, updates the writable store's `gnosys.json`, prints a diff, and labels whether the write landed in project or global scope. Supported keys include `provider`, `model`, provider-specific URLs/models, `task`, and `recall` sub-fields.
- `init` without `--force` is deprecated: prints a warning and points users to `gnosys setup`. With `--force`, writes a blank `gnosys.json` template to the writable store if one does not already exist.

## Platform notes

### macOS

- Config file lives at `<store-path>/gnosys.json` (project: `./.gnosys/gnosys.json`, personal: `~/.gnosys/gnosys.json`).
- API keys may come from the config file or environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).

### Linux

- Same layout as macOS. Use quoted paths when pointing `GNOSYS_PERSONAL` at a custom store.

### Windows

- Store paths use backslashes in output; Node resolves them correctly.
- Environment variables for API keys work the same as on Unix (`set OPENAI_API_KEY=...` in cmd, `$env:OPENAI_API_KEY="..."` in PowerShell).

## Validation

```bash
cd gnosys-public
npm run cli -- config --help
npm run cli -- config show --help
npm run cli -- config set --help
npm run cli -- config init --help
```
