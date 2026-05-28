# gnosys config set

Set a config value in the active writable Gnosys store.

## Usage

```bash
gnosys config set provider openai
gnosys config set model gpt-4.1
gnosys config set ollama-url http://127.0.0.1:11434
gnosys config set openai-model gpt-4.1
gnosys config set openai-url https://api.openai.com/v1
gnosys config set task structuring openai gpt-4.1-mini
gnosys config set task synthesis anthropic claude-sonnet-4-20250514
gnosys config set recall aggressive false
gnosys config set recall maxMemories 8
gnosys config set recall minRelevance 0.35
gnosys config set custom-key sk-...
```

## Supported keys

| Key | Value | Notes |
|-----|-------|-------|
| `provider` | provider name | Sets default LLM provider |
| `model` | model id | Updates model for the current default provider |
| `ollama-url`, `ollama-model` | url / model | Ollama endpoint and model |
| `anthropic-model`, `groq-model`, `openai-model`, `openai-url` | model or url | Provider-specific overrides |
| `lmstudio-url`, `lmstudio-model` | url / model | LM Studio settings |
| `xai-model`, `mistral-model` | model id | xAI and Mistral models |
| `custom-url`, `custom-model`, `custom-key` | url / model / key | Custom OpenAI-compatible provider |
| `task` | `structuring\|synthesis` + provider + model | Three extra args required |
| `recall` | sub-field + value | See recall sub-fields below |

**Recall sub-fields:** `aggressive` (true/false), `maxMemories` (integer), `minRelevance` (0–1 float).

## Behavior

- Validates the top-level key against a known set before writing; unknown keys exit with a `did you mean \`...\`?` hint when close.
- Resolves the active **writable** store; exits with `no writable store found` when none is available.
- Updates `gnosys.json` atomically via `writeConfig`.
- Prints a header, before/after diff (when applicable), and a saved confirmation with store source (project vs global).
- Sensitive values are not echoed in diff output; `custom-key` marks the value as `(set)`.
- Invalid provider, task name, or recall value exits with a specific error message.

## Output example

```text
gnosys config set

  provider   anthropic  →  openai    (project)

✓ saved · /Users/you/project/.gnosys/gnosys.json    (project)
```

## Platform notes

### macOS

- Writes land in project `.gnosys/gnosys.json` when a project store is writable, otherwise personal `~/.gnosys/gnosys.json`.
- API keys can be set via `custom-key` or environment variables.

### Linux

- Same write-target rules as macOS. Quote paths with spaces in any shell scripts wrapping `config set`.

### Windows

- Store paths may use backslashes in saved-path output; writes behave the same.
- Use PowerShell quoting for multi-word values: `gnosys config set openai-url "https://api.openai.com/v1"`.

## Validation

```bash
cd gnosys-public
npm run cli -- config set --help
npm run cli -- config set provider openai
```

## Error cases

- Unknown key → exits before write with typo suggestion when available.
- Invalid provider → lists valid providers.
- `task` with wrong arity or invalid task/provider → specific validation error.
- `recall` with invalid sub-field or out-of-range value → field-specific error.
- No writable store → `no writable store found`.
