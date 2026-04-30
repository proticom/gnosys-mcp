/**
 * Model validation via test API call.
 *
 * Sends a tiny chat completion request (max_tokens=5) to confirm that
 * the chosen provider/model/key combo actually works. Catches typos in
 * model names, expired keys, and reachability problems before the user
 * finishes setup.
 */

export interface ValidationResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Build a provider-specific minimal chat request.
 * Returns null for providers we can't validate (e.g. "custom" without baseUrl).
 */
function buildRequest(
  provider: string,
  model: string,
  apiKey: string,
  customBaseUrl?: string,
): ProviderRequest | null {
  // OpenAI-compatible body works for most providers
  const openaiBody = {
    model,
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 5,
  };

  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model,
          max_tokens: 5,
          messages: [{ role: "user", content: "Hi" }],
        },
      };

    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: openaiBody,
      };

    case "xai":
      return {
        url: "https://api.x.ai/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: openaiBody,
      };

    case "groq":
      return {
        url: "https://api.groq.com/openai/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: openaiBody,
      };

    case "mistral":
      return {
        url: "https://api.mistral.ai/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: openaiBody,
      };

    case "ollama":
      return {
        url: "http://localhost:11434/api/chat",
        headers: { "Content-Type": "application/json" },
        body: {
          model,
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
          options: { num_predict: 5 },
        },
      };

    case "lmstudio":
      return {
        url: "http://localhost:1234/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
        body: openaiBody,
      };

    case "custom":
      if (!customBaseUrl) return null;
      return {
        url: `${customBaseUrl.replace(/\/$/, "")}/chat/completions`,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
        },
        body: openaiBody,
      };

    default:
      return null;
  }
}

/**
 * Validate a provider/model/key combo by sending a tiny test request.
 * Times out after 15 seconds.
 */
export async function validateModel(
  provider: string,
  model: string,
  apiKey: string,
  opts?: { customBaseUrl?: string; timeoutMs?: number },
): Promise<ValidationResult> {
  const request = buildRequest(provider, model, apiKey, opts?.customBaseUrl);
  if (!request) {
    return { ok: false, error: `Validation not supported for provider "${provider}"` };
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 15000);

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      // Try to extract a readable error message
      let errorBody = "";
      try {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text);
          errorBody = parsed.error?.message ?? parsed.error ?? parsed.message ?? text.slice(0, 200);
        } catch {
          errorBody = text.slice(0, 200);
        }
      } catch {
        errorBody = "";
      }
      return {
        ok: false,
        error: `HTTP ${response.status}${errorBody ? `: ${errorBody}` : ""}`,
        latencyMs,
      };
    }

    return { ok: true, latencyMs };
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted")) {
      return { ok: false, error: "Request timed out" };
    }
    return { ok: false, error: msg };
  }
}
