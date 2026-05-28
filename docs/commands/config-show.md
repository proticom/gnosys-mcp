# gnosys config show

Show the current LLM configuration for the first active Gnosys store.

## Usage

```bash
gnosys config show
gnosys config show --json
```

## Behavior

- Reads config from the first active store returned by the resolver.
- Exits with `No stores found. Run gnosys init first.` when no stores are available.
- Default output prints the System of Cognition (SOC) summary: default provider, per-provider models and key sources, and task routing for structuring/synthesis.
- With `--json`, prints the effective config object as formatted JSON (for scripts and automation).
- Read-only: does not modify `gnosys.json`.

## Output example

```text
System of Cognition (SOC) — LLM Configuration:
  Default provider: openai

  Providers:
    Anthropic:  model=claude-sonnet-4-20250514, apiKey=env
    OpenAI:     model=gpt-4.1, apiKey=config, url=https://api.openai.com/v1
    ...

  Task Routing:
    Structuring: openai/gpt-4.1-mini (override)
    Synthesis:   openai/gpt-4.1 (default)
```

With `--json`, output is the parsed config object (pretty-printed).

## Platform notes

### macOS

- Config is read from `<first-store-path>/gnosys.json` (typically project `./.gnosys` or personal `~/.gnosys`).
- API key columns show `config`, `env`, or `—` depending on whether keys are in the file or environment.

### Linux

- Same store resolution as macOS. Ensure `gnosys init` has been run or a `.gnosys` directory exists before calling `config show`.

### Windows

- Store paths may appear with backslashes in resolver output; config loading works the same.
- Environment variables for provider keys (`OPENAI_API_KEY`, etc.) are detected the same way as on Unix.

## Validation

```bash
cd gnosys-public
npm run cli -- config show --help
npm run cli -- config show
npm run cli -- config show --json
```
