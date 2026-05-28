# gnosys ask

Ask a natural-language question and get a synthesized answer with citations.

## Usage

```bash
gnosys ask "What did we decide about auth?"
gnosys ask "What did we decide about auth?" --mode hybrid --limit 10
gnosys ask "What did we decide about auth?" --federated --scope project,user
gnosys ask "What did we decide about auth?" --no-stream --json
```

## Options

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Max memories to retrieve (default `15`) |
| `-m, --mode <mode>` | Search mode: `keyword`, `semantic`, or `hybrid` (default `hybrid`) |
| `--no-stream` | Disable streaming output |
| `--federated` | Pre-retrieve cross-scope context from central DB |
| `--scope <scope>` | Filter federated scopes: `project`, `user`, `global` (comma-separated) |
| `-d, --directory <dir>` | Project directory for federated context detection |
| `--json` | Output answer and sources as JSON (disables streaming) |

## Behavior

1. Resolves stores; exits if none (`No stores found. Run gnosys init first.`).
2. Loads config from store (falls back to `DEFAULT_CONFIG`).
3. Builds search index, embeddings, hybrid search, and `GnosysAsk` synthesizer.
4. Checks LLM availability before querying; exits with provider-aware error if unavailable.
5. Optionally pre-retrieves federated context from central DB when `--federated` or `--scope` is set.
6. Calls `ask.ask()` with mode, limit, streaming callbacks, and optional federated context.
7. Prints answer (streamed or buffered), sources, and deep-query note when applicable.
8. Best-effort reinforces cited source paths via `GnosysMaintenanceEngine.reinforceBatch`.
9. Closes search and embeddings handles.

## Streaming

By default, tokens stream to stdout via `onToken`. Search completion and deep-query expansion print status lines to stderr/stdout. `--no-stream` or `--json` disables token streaming.

## Federated context

When federated/scope is enabled, matching central DB memories are injected as `additionalContext` before synthesis. If central DB is unavailable, ask falls through to normal local retrieval.

## JSON output

With `--json`:

```json
{
  "question": "...",
  "answer": "...",
  "sources": [{ "title": "...", "relativePath": "..." }],
  "deepQueryUsed": false
}
```

## LLM errors

If no LLM provider is available, exits with code 1 and provider-specific setup guidance (env var, `gnosys setup`, or `gnosys.json` apiKey).

## Validation

```bash
cd gnosys-public
npm run cli -- ask --help
```

## Related commands

- `gnosys hybrid-search` — retrieval without LLM synthesis.
- `gnosys setup` — configure LLM provider and API keys.
