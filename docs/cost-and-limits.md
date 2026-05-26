# Cost & Limits

Gnosys uses **your** LLM credentials (or local models). It does not meter, track, or cap cumulative spend.

## Caps that exist

- **Per-call output tokens:** Every `generate()` call passes `maxTokens` to the provider (default **4096** when not overridden). Connectivity probes use a small cap (`max_tokens: 10`).
- **Per-call timeouts:** LLM HTTP requests abort after 60 seconds; probe calls after 10 seconds (see `src/lib/llm.ts`).

## Caps that do NOT exist (by design)

- **No per-call input cap** — prompts are sent as-is. Very large inputs hit the provider's context window and return a 400-style error; Gnosys does not truncate or count input tokens client-side.
- **No daily or monthly cost cap** — there is no spend accumulator or automatic shutoff.
- **No cumulative spend tracking** — Gnosys never records dollars or token totals across calls.

The **budget / balanced / premium** labels in `gnosys setup` refer to **model quality tiers**, not a billing budget.

## You are responsible for spend

All API usage bills to **your provider account** (Anthropic, OpenAI, Groq, xAI, Mistral, etc.). Gnosys holds your keys locally and calls providers on your behalf.

Set hard spend limits in each provider's **billing dashboard** if you want an external guardrail. Gnosys will not stop calls when a budget is reached.

## Bounding cost in practice

| Approach | Effect |
|----------|--------|
| **Local providers** (Ollama, LM Studio) | $0 per token — runs on your machine |
| **Dream Mode default** | Background consolidation defaults to local Ollama (`config.dream.provider` falls back to `"ollama"`), so autonomous runs cost nothing unless you point Dream at a paid provider |
| **Budget-tier models** | Pick a smaller/cheaper model in `gnosys setup` |
| **Lower `maxTokens`** | Shorter outputs = fewer billed output tokens per call |
| **Provider billing limits** | Set caps in Anthropic/OpenAI/etc. console — the only enforced daily/monthly limit |

## Related docs

- [Search modes](search-modes.md) — keyword vs semantic vs hybrid (semantic/hybrid need embeddings + optional LLM for `ask`)
- [LLM provider contract](llm-provider-contract.md) — `maxTokens`, streaming, errors
