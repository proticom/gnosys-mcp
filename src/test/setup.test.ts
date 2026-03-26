/**
 * Tests for the setup wizard helpers and model tier data.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  PROVIDER_TIERS,
  getStructuringModel,
  writeApiKey,
  detectIDEs,
  type ModelTier,
} from "../lib/setup.js";
import {
  ALL_PROVIDERS,
  DEFAULT_CONFIG,
  GnosysConfigSchema,
  getProviderModel,
  resolveTaskModel,
} from "../lib/config.js";

describe("Setup Wizard", () => {
  describe("PROVIDER_TIERS", () => {
    it("has entries for all 8 providers", () => {
      const providers = Object.keys(PROVIDER_TIERS);
      expect(providers).toContain("anthropic");
      expect(providers).toContain("openai");
      expect(providers).toContain("groq");
      expect(providers).toContain("xai");
      expect(providers).toContain("mistral");
      expect(providers).toContain("ollama");
      expect(providers).toContain("lmstudio");
      expect(providers).toContain("custom");
      expect(providers).toHaveLength(8);
    });

    it("each provider with tiers has exactly one recommended model", () => {
      for (const [provider, tiers] of Object.entries(PROVIDER_TIERS)) {
        if (tiers.length === 0) continue; // custom has no tiers
        const recommended = tiers.filter((t) => t.recommended);
        expect(
          recommended,
          `${provider} should have exactly 1 recommended tier`
        ).toHaveLength(1);
      }
    });

    it("custom provider has empty tiers array", () => {
      expect(PROVIDER_TIERS.custom).toEqual([]);
    });

    it("all tiers have required fields", () => {
      for (const [provider, tiers] of Object.entries(PROVIDER_TIERS)) {
        for (const tier of tiers) {
          expect(tier.name, `${provider} tier missing name`).toBeTruthy();
          expect(tier.model, `${provider} tier missing model`).toBeTruthy();
          expect(typeof tier.input).toBe("number");
          expect(typeof tier.output).toBe("number");
          expect(typeof tier.recommended).toBe("boolean");
        }
      }
    });

    it("local providers (ollama, lmstudio) have zero pricing", () => {
      for (const tier of PROVIDER_TIERS.ollama) {
        expect(tier.input).toBe(0);
        expect(tier.output).toBe(0);
      }
      for (const tier of PROVIDER_TIERS.lmstudio) {
        expect(tier.input).toBe(0);
        expect(tier.output).toBe(0);
      }
    });
  });

  describe("getStructuringModel", () => {
    it("returns claude-haiku-4-5 for anthropic", () => {
      expect(getStructuringModel("anthropic", "claude-sonnet-4-6")).toBe(
        "claude-haiku-4-5"
      );
    });

    it("returns gpt-5.4-nano for openai", () => {
      expect(getStructuringModel("openai", "gpt-5.4-mini")).toBe(
        "gpt-5.4-nano"
      );
    });

    it("returns same model for groq (already cheap)", () => {
      expect(
        getStructuringModel("groq", "llama-3.3-70b-versatile")
      ).toBe("llama-3.3-70b-versatile");
    });

    it("returns same model for ollama", () => {
      expect(getStructuringModel("ollama", "llama3.2")).toBe("llama3.2");
    });

    it("returns same model for custom", () => {
      expect(getStructuringModel("custom", "my-model")).toBe("my-model");
    });
  });

  describe("writeApiKey", () => {
    let tmpDir: string;
    let origHome: string | undefined;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-setup-test-"));
      origHome = process.env.HOME;
      process.env.HOME = tmpDir;
    });

    afterEach(async () => {
      process.env.HOME = origHome;
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("creates directory and writes key", async () => {
      await writeApiKey("anthropic", "sk-ant-test-key");
      const envPath = path.join(tmpDir, ".config", "gnosys", ".env");
      const content = await fs.readFile(envPath, "utf-8");
      expect(content).toContain("ANTHROPIC_API_KEY=sk-ant-test-key");
    });

    it("maps providers to correct env var names", async () => {
      await writeApiKey("openai", "sk-test");
      const envPath = path.join(tmpDir, ".config", "gnosys", ".env");
      const content = await fs.readFile(envPath, "utf-8");
      expect(content).toContain("OPENAI_API_KEY=sk-test");
    });

    it("does not duplicate keys on second write", async () => {
      await writeApiKey("anthropic", "key1");
      await writeApiKey("anthropic", "key2");
      const envPath = path.join(tmpDir, ".config", "gnosys", ".env");
      const content = await fs.readFile(envPath, "utf-8");
      const matches = content.match(/ANTHROPIC_API_KEY/g);
      expect(matches).toHaveLength(1);
      expect(content).toContain("ANTHROPIC_API_KEY=key2");
    });

    it("preserves existing keys for other providers", async () => {
      await writeApiKey("anthropic", "ant-key");
      await writeApiKey("openai", "oai-key");
      const envPath = path.join(tmpDir, ".config", "gnosys", ".env");
      const content = await fs.readFile(envPath, "utf-8");
      expect(content).toContain("ANTHROPIC_API_KEY=ant-key");
      expect(content).toContain("OPENAI_API_KEY=oai-key");
    });

    it("uses GNOSYS_LLM_API_KEY for custom provider", async () => {
      await writeApiKey("custom", "custom-key");
      const envPath = path.join(tmpDir, ".config", "gnosys", ".env");
      const content = await fs.readFile(envPath, "utf-8");
      expect(content).toContain("GNOSYS_LLM_API_KEY=custom-key");
    });
  });

  describe("detectIDEs", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-ide-test-"));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("detects .cursor/ directory", async () => {
      await fs.mkdir(path.join(tmpDir, ".cursor"), { recursive: true });
      const ides = await detectIDEs(tmpDir);
      expect(ides).toContain("cursor");
    });

    it("detects .codex/ directory", async () => {
      await fs.mkdir(path.join(tmpDir, ".codex"), { recursive: true });
      const ides = await detectIDEs(tmpDir);
      expect(ides).toContain("codex");
    });

    it("returns empty array for bare directory", async () => {
      const ides = await detectIDEs(tmpDir);
      // May include "claude" if the CLI is installed on the test machine
      const withoutClaude = ides.filter((i) => i !== "claude");
      expect(withoutClaude).toHaveLength(0);
    });
  });

  describe("Config defaults match current models", () => {
    it("default Anthropic model is claude-sonnet-4-6", () => {
      expect(getProviderModel(DEFAULT_CONFIG, "anthropic")).toBe(
        "claude-sonnet-4-6"
      );
    });

    it("default OpenAI model is gpt-5.4-mini", () => {
      expect(getProviderModel(DEFAULT_CONFIG, "openai")).toBe("gpt-5.4-mini");
    });

    it("default xAI model is grok-4.20", () => {
      expect(getProviderModel(DEFAULT_CONFIG, "xai")).toBe("grok-4.20");
    });

    it("default Mistral model is mistral-small-4", () => {
      expect(getProviderModel(DEFAULT_CONFIG, "mistral")).toBe(
        "mistral-small-4"
      );
    });

    it("default Groq model is llama-3.3-70b-versatile", () => {
      expect(getProviderModel(DEFAULT_CONFIG, "groq")).toBe(
        "llama-3.3-70b-versatile"
      );
    });
  });

  describe("resolveTaskModel structuring optimization", () => {
    it("anthropic structuring returns claude-haiku-4-5", () => {
      const config = GnosysConfigSchema.parse({
        llm: { defaultProvider: "anthropic" },
      });
      const result = resolveTaskModel(config, "structuring");
      expect(result.model).toBe("claude-haiku-4-5");
    });

    it("openai structuring returns gpt-5.4-nano", () => {
      const config = GnosysConfigSchema.parse({
        llm: { defaultProvider: "openai" },
      });
      const result = resolveTaskModel(config, "structuring");
      expect(result.model).toBe("gpt-5.4-nano");
    });

    it("groq structuring returns the default groq model (no override)", () => {
      const config = GnosysConfigSchema.parse({
        llm: { defaultProvider: "groq" },
      });
      const result = resolveTaskModel(config, "structuring");
      expect(result.model).toBe("llama-3.3-70b-versatile");
    });

    it("explicit task override takes precedence", () => {
      const config = GnosysConfigSchema.parse({
        llm: { defaultProvider: "anthropic" },
        taskModels: {
          structuring: { provider: "ollama", model: "llama3.2" },
        },
      });
      const result = resolveTaskModel(config, "structuring");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("llama3.2");
    });
  });
});
