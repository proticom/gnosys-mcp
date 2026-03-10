/**
 * Gnosys LLM Abstraction Layer — Provider-agnostic interface for LLM operations.
 * Supports Anthropic (cloud) and Ollama (local). Clean factory pattern enables
 * future providers (Groq, OpenAI, LM Studio) with zero changes to call sites.
 */

import {
  GnosysConfig,
  DEFAULT_CONFIG,
  LLMProviderName,
  resolveTaskModel,
  getAnthropicApiKey,
  getOllamaBaseUrl,
  getGroqApiKey,
  getOpenAIApiKey,
  getOpenAIBaseUrl,
  getLMStudioBaseUrl,
  getProviderModel,
} from "./config.js";
import { withRetry, isTransientError } from "./retry.js";

// ─── Interfaces ──────────────────────────────────────────────────────────

export interface LLMGenerateOptions {
  system?: string;
  maxTokens?: number;
  stream?: boolean;
}

export interface LLMStreamCallbacks {
  onToken: (token: string) => void;
}

/**
 * Core LLM provider interface. All providers must implement this.
 */
export interface LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;

  /**
   * Generate a response from a prompt.
   * Returns the full response text (non-streaming) or streams via callbacks.
   */
  generate(
    prompt: string,
    options?: LLMGenerateOptions,
    streamCallbacks?: LLMStreamCallbacks
  ): Promise<string>;

  /**
   * Test connectivity to the provider.
   * Returns true if reachable, throws with descriptive error if not.
   */
  testConnection(): Promise<boolean>;
}

// ─── Anthropic Provider ──────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  readonly name: LLMProviderName = "anthropic";
  readonly model: string;
  private client: any; // Anthropic SDK client
  private config: GnosysConfig;

  constructor(model: string, apiKey: string, config?: GnosysConfig) {
    this.model = model;
    this.config = config || DEFAULT_CONFIG;

    // Dynamic import is handled in factory; here we just create the client
    const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
    this.client = new Anthropic({ apiKey });
  }

  async generate(
    prompt: string,
    options?: LLMGenerateOptions,
    streamCallbacks?: LLMStreamCallbacks
  ): Promise<string> {
    const maxTokens = options?.maxTokens || 4096;

    if (options?.stream && streamCallbacks?.onToken) {
      return this.streamGenerate(prompt, options, streamCallbacks);
    }

    const response = await withRetry(
      () =>
        this.client.messages.create({
          model: this.model,
          max_tokens: maxTokens,
          ...(options?.system ? { system: options.system } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      {
        maxAttempts: this.config.llmRetryAttempts,
        baseDelayMs: this.config.llmRetryBaseDelayMs,
        isRetryable: isTransientError,
      }
    ) as { content: Array<{ type: string; text?: string }> };

    return response.content[0].type === "text" ? response.content[0].text || "" : "";
  }

  private async streamGenerate(
    prompt: string,
    options: LLMGenerateOptions,
    streamCallbacks: LLMStreamCallbacks
  ): Promise<string> {
    const maxTokens = options?.maxTokens || 4096;

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      ...(options?.system ? { system: options.system } : {}),
      messages: [{ role: "user", content: prompt }],
    });

    let fullText = "";

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const token = event.delta.text;
        fullText += token;
        streamCallbacks.onToken(token);
      }
    }

    return fullText;
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: "user", content: "Say hi" }],
      });
      return response.content.length > 0;
    } catch (err) {
      throw new Error(
        `Anthropic connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// ─── Ollama Provider ─────────────────────────────────────────────────────

export class OllamaProvider implements LLMProvider {
  readonly name: LLMProviderName = "ollama";
  readonly model: string;
  private baseUrl: string;
  private config: GnosysConfig;

  constructor(model: string, baseUrl: string, config?: GnosysConfig) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Strip trailing slash
    this.config = config || DEFAULT_CONFIG;
  }

  async generate(
    prompt: string,
    options?: LLMGenerateOptions,
    streamCallbacks?: LLMStreamCallbacks
  ): Promise<string> {
    const shouldStream = options?.stream && streamCallbacks?.onToken;

    const body: Record<string, unknown> = {
      model: this.model,
      stream: !!shouldStream,
    };

    // Use /api/chat for system prompt support, /api/generate otherwise
    if (options?.system) {
      body.messages = [
        { role: "system", content: options.system },
        { role: "user", content: prompt },
      ];
    } else {
      body.messages = [{ role: "user", content: prompt }];
    }

    const url = `${this.baseUrl}/api/chat`;

    const response = await withRetry(
      () =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      {
        maxAttempts: this.config.llmRetryAttempts,
        baseDelayMs: this.config.llmRetryBaseDelayMs,
        isRetryable: isTransientError,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ollama request failed (${response.status}): ${errorText}`
      );
    }

    if (shouldStream && streamCallbacks) {
      return this.readStream(response, streamCallbacks);
    }

    // Non-streaming: Ollama returns one JSON object with the full response
    const data = await response.json() as { message?: { content?: string }; response?: string };
    return data.message?.content || data.response || "";
  }

  private async readStream(
    response: Response,
    callbacks: LLMStreamCallbacks
  ): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body for streaming");

    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // Ollama streams one JSON object per line
      const lines = chunk.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            message?: { content?: string };
            response?: string;
            done?: boolean;
          };
          const token = parsed.message?.content || parsed.response || "";
          if (token) {
            fullText += token;
            callbacks.onToken(token);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    return fullText;
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json() as { models?: unknown[] };
      if (!data.models || !Array.isArray(data.models)) {
        throw new Error("Unexpected response format");
      }

      // Check if the configured model is available
      const modelNames = data.models.map((m: any) => m.name || m.model || "");
      const hasModel = modelNames.some(
        (name: string) =>
          name === this.model ||
          name.startsWith(`${this.model}:`) ||
          name === `${this.model}:latest`
      );

      if (!hasModel) {
        const available = modelNames.slice(0, 10).join(", ");
        throw new Error(
          `Model "${this.model}" not found. Available: ${available || "none"}. Run: ollama pull ${this.model}`
        );
      }

      return true;
    } catch (err) {
      if (err instanceof Error && err.message.includes("Model")) {
        throw err; // Re-throw model-not-found with helpful message
      }
      throw new Error(
        `Ollama connection failed at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}. Is Ollama running?`
      );
    }
  }
}

// ─── OpenAI-Compatible Provider (Groq, OpenAI, LM Studio) ──────────────

/**
 * Generic OpenAI-compatible provider. Works with any service that implements
 * the OpenAI /v1/chat/completions API: OpenAI, Groq, LM Studio, etc.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;
  private config: GnosysConfig;

  constructor(
    name: LLMProviderName,
    model: string,
    baseUrl: string,
    apiKey: string,
    config?: GnosysConfig
  ) {
    this.name = name;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.config = config || DEFAULT_CONFIG;
  }

  async generate(
    prompt: string,
    options?: LLMGenerateOptions,
    streamCallbacks?: LLMStreamCallbacks
  ): Promise<string> {
    const shouldStream = options?.stream && streamCallbacks?.onToken;
    const maxTokens = options?.maxTokens || 4096;

    const messages: Array<{ role: string; content: string }> = [];
    if (options?.system) {
      messages.push({ role: "system", content: options.system });
    }
    messages.push({ role: "user", content: prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      stream: !!shouldStream,
    };

    const response = await withRetry(
      () =>
        fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      {
        maxAttempts: this.config.llmRetryAttempts,
        baseDelayMs: this.config.llmRetryBaseDelayMs,
        isRetryable: isTransientError,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `${this.name} request failed (${response.status}): ${errorText}`
      );
    }

    if (shouldStream && streamCallbacks) {
      return this.readSSEStream(response, streamCallbacks);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || "";
  }

  private async readSSEStream(
    response: Response,
    callbacks: LLMStreamCallbacks
  ): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body for streaming");

    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = parsed.choices?.[0]?.delta?.content || "";
          if (token) {
            fullText += token;
            callbacks.onToken(token);
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    return fullText;
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return true;
    } catch (err) {
      throw new Error(
        `${this.name} connection failed at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────

/**
 * Create an LLM provider for a specific task.
 * Resolves provider + model from config's taskModels or defaultProvider.
 */
export function getLLMProvider(
  config: GnosysConfig,
  task?: "structuring" | "synthesis"
): LLMProvider {
  const resolved = task
    ? resolveTaskModel(config, task)
    : { provider: config.llm.defaultProvider, model: getDefaultModel(config) };

  return createProvider(resolved.provider, resolved.model, config);
}

/**
 * Create a specific LLM provider instance.
 */
export function createProvider(
  provider: LLMProviderName,
  model: string,
  config: GnosysConfig
): LLMProvider {
  switch (provider) {
    case "anthropic": {
      const apiKey = getAnthropicApiKey(config);
      if (!apiKey) {
        throw new Error(
          "No Anthropic API key found. Set ANTHROPIC_API_KEY environment variable or add llm.anthropic.apiKey to gnosys.json."
        );
      }
      return new AnthropicProvider(model, apiKey, config);
    }

    case "ollama": {
      const baseUrl = getOllamaBaseUrl(config);
      return new OllamaProvider(model, baseUrl, config);
    }

    case "groq": {
      const apiKey = getGroqApiKey(config);
      if (!apiKey) {
        throw new Error(
          "No Groq API key found. Set GROQ_API_KEY environment variable or add llm.groq.apiKey to gnosys.json."
        );
      }
      return new OpenAICompatibleProvider("groq", model, "https://api.groq.com/openai/v1", apiKey, config);
    }

    case "openai": {
      const apiKey = getOpenAIApiKey(config);
      if (!apiKey) {
        throw new Error(
          "No OpenAI API key found. Set OPENAI_API_KEY environment variable or add llm.openai.apiKey to gnosys.json."
        );
      }
      const baseUrl = getOpenAIBaseUrl(config);
      return new OpenAICompatibleProvider("openai", model, baseUrl, apiKey, config);
    }

    case "lmstudio": {
      const baseUrl = getLMStudioBaseUrl(config);
      return new OpenAICompatibleProvider("lmstudio", model, baseUrl, "", config);
    }

    default:
      throw new Error(
        `Unsupported LLM provider: "${provider}". Supported: anthropic, ollama, groq, openai, lmstudio.`
      );
  }
}

/**
 * Get the default model for the default provider.
 */
function getDefaultModel(config: GnosysConfig): string {
  return getProviderModel(config, config.llm.defaultProvider);
}

/**
 * Check if an LLM provider is available (has credentials / connectivity).
 * Returns { available: boolean; error?: string }.
 */
export function isProviderAvailable(
  config: GnosysConfig,
  provider?: LLMProviderName
): { available: boolean; error?: string } {
  const target = provider || config.llm.defaultProvider;

  switch (target) {
    case "anthropic": {
      const apiKey = getAnthropicApiKey(config);
      if (!apiKey) {
        return {
          available: false,
          error: "No ANTHROPIC_API_KEY set. Add to environment or gnosys.json.",
        };
      }
      return { available: true };
    }

    case "groq": {
      const apiKey = getGroqApiKey(config);
      if (!apiKey) {
        return {
          available: false,
          error: "No GROQ_API_KEY set. Add to environment or gnosys.json.",
        };
      }
      return { available: true };
    }

    case "openai": {
      const apiKey = getOpenAIApiKey(config);
      if (!apiKey) {
        return {
          available: false,
          error: "No OPENAI_API_KEY set. Add to environment or gnosys.json.",
        };
      }
      return { available: true };
    }

    case "ollama":
    case "lmstudio":
      // Local providers: assume available if configured (network check requires async)
      return { available: true };

    default:
      return { available: false, error: `Unknown provider: ${target}` };
  }
}
