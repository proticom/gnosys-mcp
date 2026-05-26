# LLMProvider Contract

All LLM backends implement the `LLMProvider` interface defined in `src/lib/llm.ts`. Use the factory `getLLMProvider(config, task?)` to obtain a configured instance for a task (structuring, synthesis, vision, transcription, chat).

## Types

```typescript
interface LLMGenerateOptions {
  system?: string;    // optional system prompt
  maxTokens?: number; // output token limit (provider default if omitted)
  stream?: boolean;   // when true + callbacks provided, stream tokens
}

interface LLMStreamCallbacks {
  onToken: (token: string) => void;
}

type LLMProviderName =
  | "anthropic" | "ollama" | "groq" | "openai" | "lmstudio"
  | "xai" | "mistral" | "custom";
```

## Methods

| Member | Signature | Contract |
|--------|-----------|----------|
| `name` | `readonly LLMProviderName` | Provider identifier |
| `model` | `readonly string` | Resolved model id for this instance |
| `generate` | `(prompt, options?, streamCallbacks?) => Promise<string>` | Returns the full response text. When `options.stream === true` and `streamCallbacks.onToken` is provided, emits tokens via the callback and still resolves with the accumulated full text |
| `generateWithImage?` | `(prompt, imageBase64, mimeType, options?) => Promise<string>` | Optional vision support. Providers without vision omit this method |
| `testConnection` | `() => Promise<boolean>` | Returns `true` if the provider is reachable. Throws a descriptive error (with API keys redacted) if not |

## Input → output

1. **Input:** A user/assistant `prompt` string, optional `LLMGenerateOptions`, and optional `LLMStreamCallbacks`.
2. **Output:** A `Promise<string>` that resolves to the complete generated text.
3. **Streaming:** When streaming is requested, tokens are delivered incrementally through `onToken` while the promise still resolves to the full concatenated response. Failures reject the promise; partial text is never returned silently on error.

## Errors and retries

- **Transient errors** (HTTP 429, network timeouts, connection resets) are retried automatically via `withRetry(..., { isRetryable: isTransientError })` from `src/lib/retry.ts`.
- **Non-transient errors** (401/403 invalid key, malformed response) throw an `Error` immediately with the message surfaced to the caller.
- **Key redaction:** Error messages redact API keys before reaching callers (e.g. `sk-ant-***` instead of the full secret).
- **`generate` rejects on failure** — it never swallows errors or returns partial output without the caller knowing.

## Implementations

| Class | Providers served |
|-------|------------------|
| `AnthropicProvider` | `anthropic` |
| `OllamaProvider` | `ollama` (local, no API key) |
| `OpenAICompatibleProvider` | `groq`, `openai`, `lmstudio`, `xai`, `mistral`, `custom` (OpenAI-compatible HTTP API) |

Create instances via `createProvider(name, model, config)` or the higher-level `getLLMProvider(config, task)`.

## Adding a new provider

1. Implement `LLMProvider` (all required members; add `generateWithImage` only if the backend supports vision).
2. Wire it in `createProvider()` inside `src/lib/llm.ts`.
3. Add configuration keys and env-var resolution in `src/lib/config.ts`.
4. Ensure `testConnection()` throws key-redacted errors and that `generate()` uses `withRetry` for transient failures, matching existing providers.
