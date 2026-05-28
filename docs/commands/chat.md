# gnosys chat

Open the memory-aware terminal chat TUI.

## Usage

```bash
gnosys chat
gnosys chat --resume <sessionId>
gnosys chat --list
gnosys chat --search "decision"
gnosys chat --provider anthropic --model claude-sonnet-4-5
```

## Options

| Option | Description |
|--------|-------------|
| `--resume <sessionId>` | Resume an existing chat session |
| `--list` | List recent chat sessions and exit |
| `--search <query>` | Full-text search across session logs and exit |
| `--provider <name>` | Override LLM provider (anthropic, openai, groq, ollama, …) |
| `--model <name>` | Override LLM model name |
| `--limit <n>` | Limit for `--list` / `--search` (default `20`) |

## Session shortcuts

`--list` and `--search` return immediately without starting the TUI. They load the chat module only to print session list or search results.

## Interactive chat flow

1. Resolves the project store path from the resolver (falls back to cwd).
2. Loads config from the store; on failure uses `DEFAULT_CONFIG`.
3. Resolves the chat task model (`resolveTaskModel`) for provider selection.
4. For non-local providers (not ollama/lmstudio), checks API key via `getApiKeyForProvider` **before** TUI render (fail-fast).
5. Starts the chat TUI via `startChat` with config, resume ID, and optional provider/model overrides.

## API key fail-fast

If the configured chat provider has no API key:

```text
✗ no API key for <provider> (the configured chat provider)
   fix:  gnosys setup           pick a provider with a key, or add one
         export <PROVIDER>_API_KEY=...
```

Process exits with code 1 before Ink/React TUI dependencies load.

Local providers (`ollama`, `lmstudio`) skip the API key check.

## Platform notes

- Requires a terminal with TUI support for interactive mode.
- Configure chat defaults with `gnosys setup chat`.

## Validation

```bash
cd gnosys-public
npm run cli -- chat --help
gnosys chat --list
```

## Related commands

- `gnosys setup chat` — configure chat TUI defaults (provider, recall, tools).
- `gnosys discover` / `gnosys read` — browse memories outside the TUI.
