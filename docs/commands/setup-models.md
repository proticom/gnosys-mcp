# gnosys setup models

Update the default LLM provider and model, optionally validate provider connectivity with a test API call.

## Usage

```bash
gnosys setup models
gnosys setup models --provider xai --model grok-4.20
gnosys setup models --provider ollama --model llama3.2 --no-validate
gnosys setup models -p anthropic -m claude-sonnet-4-20250514
```

## Options

- `-p, --provider <name>` — Set provider directly: `anthropic`, `openai`, `xai`, `groq`, `mistral`, `ollama`, `lmstudio`, or `custom`.
- `-m, --model <name>` — Set model name for the chosen provider.
- `--no-validate` — Skip the test API call after configuration.

## Behavior

- Runs the interactive models setup flow when no flags are passed.
- With `--provider` and/or `--model`, applies configuration non-interactively.
- By default, validates the provider with a test API call unless `--no-validate` is set.
- Writes provider and model settings to the active Gnosys config (`~/.gnosys/gnosys.json`).

## Writes and side effects

- Updates LLM provider and model in config.
- May store or read provider API keys from the platform secure store or `~/.config/gnosys/.env`.
- May print shell-profile or env-file hints when keys are missing.

## Platform notes

### macOS

- **API keys:** macOS Keychain (recommended), environment variables, or `~/.config/gnosys/.env`
- **Shell profile:** `~/.zshrc` or `~/.bash_profile` for manual `export ANTHROPIC_API_KEY=...` (provider-specific)

### Linux

- **API keys:** GNOME Keyring when `secret-tool` is available, environment variables, or `~/.config/gnosys/.env`
- **Shell profile:** `~/.bashrc` or `~/.zshrc` for manual env vars

### Windows

- **API keys:** Environment variables or `~/.config/gnosys/.env`
- **Shell profile:** PowerShell profile (`$PROFILE`) or System Properties → Environment Variables

## Validation

```bash
cd gnosys-public
npm run cli -- setup models --help
```
