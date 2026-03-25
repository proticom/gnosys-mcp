/**
 * Tests for LLM provider system — verifies named shortcuts (xAI, Mistral),
 * custom provider support, backward compatibility, and config schema.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ALL_PROVIDERS,
  getProviderModel,
  getXAIApiKey,
  getMistralApiKey,
  getCustomApiKey,
  DEFAULT_CONFIG,
  GnosysConfigSchema,
  LLMProviderName,
} from "../lib/config.js";
import {
  createProvider,
  isProviderAvailable,
} from "../lib/llm.js";

describe("LLM Provider System", () => {
  describe("Provider Registry", () => {
    it("ALL_PROVIDERS includes all 8 providers", () => {
      expect(ALL_PROVIDERS).toHaveLength(8);
      expect(ALL_PROVIDERS).toContain("anthropic");
      expect(ALL_PROVIDERS).toContain("ollama");
      expect(ALL_PROVIDERS).toContain("groq");
      expect(ALL_PROVIDERS).toContain("openai");
      expect(ALL_PROVIDERS).toContain("lmstudio");
      expect(ALL_PROVIDERS).toContain("xai");
      expect(ALL_PROVIDERS).toContain("mistral");
      expect(ALL_PROVIDERS).toContain("custom");
    });
  });

  describe("Config Schema", () => {
    it("parses old configs without xai/mistral/custom sections (backward compat)", () => {
      const oldConfig = {
        llm: {
          defaultProvider: "anthropic",
          anthropic: { model: "claude-sonnet-4-20250514" },
          ollama: { model: "llama3.2", baseUrl: "http://localhost:11434" },
        },
      };
      const parsed = GnosysConfigSchema.parse(oldConfig);
      expect(parsed.llm.defaultProvider).toBe("anthropic");
      // xai and mistral should get defaults
      expect(parsed.llm.xai.model).toBe("grok-2");
      expect(parsed.llm.mistral.model).toBe("mistral-large-latest");
      // custom should be undefined
      expect(parsed.llm.custom).toBeUndefined();
    });

    it("accepts xai as defaultProvider", () => {
      const config = { llm: { defaultProvider: "xai" } };
      const parsed = GnosysConfigSchema.parse(config);
      expect(parsed.llm.defaultProvider).toBe("xai");
    });

    it("accepts mistral as defaultProvider", () => {
      const config = { llm: { defaultProvider: "mistral" } };
      const parsed = GnosysConfigSchema.parse(config);
      expect(parsed.llm.defaultProvider).toBe("mistral");
    });

    it("accepts custom as defaultProvider with full config", () => {
      const config = {
        llm: {
          defaultProvider: "custom",
          custom: {
            model: "meta-llama/Llama-3-70b",
            baseUrl: "https://api.together.xyz/v1",
            apiKey: "tok-test",
          },
        },
      };
      const parsed = GnosysConfigSchema.parse(config);
      expect(parsed.llm.defaultProvider).toBe("custom");
      expect(parsed.llm.custom?.model).toBe("meta-llama/Llama-3-70b");
      expect(parsed.llm.custom?.baseUrl).toBe("https://api.together.xyz/v1");
    });

    it("rejects invalid provider names", () => {
      const config = { llm: { defaultProvider: "invalid-provider" } };
      expect(() => GnosysConfigSchema.parse(config)).toThrow();
    });
  });

  describe("getProviderModel", () => {
    it("returns xai model from config", () => {
      const config = GnosysConfigSchema.parse({
        llm: { xai: { model: "grok-3" } },
      });
      expect(getProviderModel(config, "xai")).toBe("grok-3");
    });

    it("returns mistral model from config", () => {
      const config = GnosysConfigSchema.parse({
        llm: { mistral: { model: "mistral-small-latest" } },
      });
      expect(getProviderModel(config, "mistral")).toBe("mistral-small-latest");
    });

    it("returns custom model from config", () => {
      const config = GnosysConfigSchema.parse({
        llm: {
          custom: { model: "my-model", baseUrl: "http://localhost:8080/v1" },
        },
      });
      expect(getProviderModel(config, "custom")).toBe("my-model");
    });

    it("returns empty string for custom when not configured", () => {
      const config = GnosysConfigSchema.parse({});
      expect(getProviderModel(config, "custom")).toBe("");
    });
  });

  describe("API Key Helpers", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      delete process.env.XAI_API_KEY;
      delete process.env.MISTRAL_API_KEY;
      delete process.env.GNOSYS_LLM_API_KEY;
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("getXAIApiKey reads from config first", () => {
      const config = GnosysConfigSchema.parse({
        llm: { xai: { model: "grok-2", apiKey: "xai-from-config" } },
      });
      expect(getXAIApiKey(config)).toBe("xai-from-config");
    });

    it("getXAIApiKey falls back to env var", () => {
      process.env.XAI_API_KEY = "xai-from-env";
      const config = GnosysConfigSchema.parse({});
      expect(getXAIApiKey(config)).toBe("xai-from-env");
    });

    it("getMistralApiKey reads from config first", () => {
      const config = GnosysConfigSchema.parse({
        llm: { mistral: { model: "mistral-large-latest", apiKey: "mis-from-config" } },
      });
      expect(getMistralApiKey(config)).toBe("mis-from-config");
    });

    it("getMistralApiKey falls back to env var", () => {
      process.env.MISTRAL_API_KEY = "mis-from-env";
      const config = GnosysConfigSchema.parse({});
      expect(getMistralApiKey(config)).toBe("mis-from-env");
    });

    it("getCustomApiKey reads from config", () => {
      const config = GnosysConfigSchema.parse({
        llm: { custom: { model: "m", baseUrl: "http://x", apiKey: "custom-key" } },
      });
      expect(getCustomApiKey(config)).toBe("custom-key");
    });

    it("getCustomApiKey falls back to GNOSYS_LLM_API_KEY", () => {
      process.env.GNOSYS_LLM_API_KEY = "generic-key";
      const config = GnosysConfigSchema.parse({});
      expect(getCustomApiKey(config)).toBe("generic-key");
    });
  });

  describe("createProvider", () => {
    it("creates xAI provider with correct baseUrl", () => {
      const config = GnosysConfigSchema.parse({
        llm: { xai: { model: "grok-2", apiKey: "test-key" } },
      });
      const provider = createProvider("xai", "grok-2", config);
      expect(provider.name).toBe("xai");
      expect(provider.model).toBe("grok-2");
    });

    it("creates Mistral provider with correct baseUrl", () => {
      const config = GnosysConfigSchema.parse({
        llm: { mistral: { model: "mistral-large-latest", apiKey: "test-key" } },
      });
      const provider = createProvider("mistral", "mistral-large-latest", config);
      expect(provider.name).toBe("mistral");
      expect(provider.model).toBe("mistral-large-latest");
    });

    it("creates custom provider with user-provided baseUrl", () => {
      const config = GnosysConfigSchema.parse({
        llm: {
          custom: {
            model: "meta-llama/Llama-3-70b",
            baseUrl: "https://api.together.xyz/v1",
            apiKey: "tok-test",
          },
        },
      });
      const provider = createProvider("custom", "meta-llama/Llama-3-70b", config);
      expect(provider.name).toBe("custom");
      expect(provider.model).toBe("meta-llama/Llama-3-70b");
    });

    it("throws when xAI has no API key", () => {
      delete process.env.XAI_API_KEY;
      const config = GnosysConfigSchema.parse({});
      expect(() => createProvider("xai", "grok-2", config)).toThrow(/xAI API key/i);
    });

    it("throws when Mistral has no API key", () => {
      delete process.env.MISTRAL_API_KEY;
      const config = GnosysConfigSchema.parse({});
      expect(() => createProvider("mistral", "mistral-large-latest", config)).toThrow(/Mistral API key/i);
    });

    it("throws when custom provider has no config", () => {
      const config = GnosysConfigSchema.parse({});
      expect(() => createProvider("custom", "model", config)).toThrow(/Custom provider not configured/i);
    });

    it("custom provider works without API key (local endpoints)", () => {
      const config = GnosysConfigSchema.parse({
        llm: {
          custom: {
            model: "local-model",
            baseUrl: "http://localhost:8080/v1",
          },
        },
      });
      const provider = createProvider("custom", "local-model", config);
      expect(provider.name).toBe("custom");
    });
  });

  describe("isProviderAvailable", () => {
    it("xai is unavailable without API key", () => {
      delete process.env.XAI_API_KEY;
      const config = GnosysConfigSchema.parse({});
      const result = isProviderAvailable(config, "xai");
      expect(result.available).toBe(false);
    });

    it("mistral is unavailable without API key", () => {
      delete process.env.MISTRAL_API_KEY;
      const config = GnosysConfigSchema.parse({});
      const result = isProviderAvailable(config, "mistral");
      expect(result.available).toBe(false);
    });

    it("custom is unavailable when not configured", () => {
      const config = GnosysConfigSchema.parse({});
      const result = isProviderAvailable(config, "custom");
      expect(result.available).toBe(false);
    });

    it("custom is available when baseUrl and model are set", () => {
      const config = GnosysConfigSchema.parse({
        llm: {
          custom: { model: "m", baseUrl: "http://localhost:8080/v1" },
        },
      });
      const result = isProviderAvailable(config, "custom");
      expect(result.available).toBe(true);
    });
  });
});
