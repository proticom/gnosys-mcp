/**
 * CC.1 — coverage for GnosysIngestion.ingest() (LLM structuring path).
 * NEW file only; does not modify existing ingest*.test.ts files.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { GnosysStore } from "../lib/store.js";
import { GnosysTagRegistry } from "../lib/tags.js";
import { GnosysIngestion } from "../lib/ingest.js";
import { DEFAULT_CONFIG, type GnosysConfig } from "../lib/config.js";
import { getLLMProvider } from "../lib/llm.js";

const mockGenerate = vi.fn();

const fakeProvider = {
  name: "anthropic" as const,
  model: "stub-model",
  generate: mockGenerate,
  testConnection: async () => true,
};

vi.mock("../lib/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/llm.js")>();
  return {
    ...actual,
    getLLMProvider: vi.fn(() => fakeProvider),
  };
});

let tmpDir: string;
let store: GnosysStore;
let tagRegistry: GnosysTagRegistry;

function configWithProvider(name: GnosysConfig["llm"]["defaultProvider"]): GnosysConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.llm.defaultProvider = name;
  return cfg;
}

async function seedTags(dir: string) {
  const defaultTags = {
    domain: ["architecture", "auth", "testing"],
    type: ["decision", "concept"],
    concern: ["dx", "scalability"],
  };
  await fs.mkdir(path.join(dir, ".config"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".config", "tags.json"),
    JSON.stringify(defaultTags, null, 2),
    "utf-8",
  );
}

beforeEach(async () => {
  mockGenerate.mockReset();
  vi.mocked(getLLMProvider).mockImplementation(() => fakeProvider);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-cc1-"));
  store = new GnosysStore(tmpDir);
  await store.init();
  await seedTags(tmpDir);
  tagRegistry = new GnosysTagRegistry(tmpDir);
  await tagRegistry.load();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GnosysIngestion.ingest (LLM path)", () => {
  describe("provider availability getters", () => {
    it("reports unavailable when getLLMProvider throws at construction", () => {
      vi.mocked(getLLMProvider).mockImplementation(() => {
        throw new Error("no key");
      });
      const ingestion = new GnosysIngestion(store, tagRegistry);
      expect(ingestion.isLLMAvailable).toBe(false);
      expect(ingestion.providerName).toBe("none");
    });

    it("reports available when a provider is resolved", () => {
      const ingestion = new GnosysIngestion(store, tagRegistry);
      expect(ingestion.isLLMAvailable).toBe(true);
      expect(ingestion.providerName).toBe("anthropic");
    });
  });

  describe("provider-missing error paths", () => {
    beforeEach(() => {
      vi.mocked(getLLMProvider).mockImplementation(() => {
        throw new Error("no key");
      });
    });

    async function expectMissingProvider(
      providerName: GnosysConfig["llm"]["defaultProvider"] | string,
      snippet: string,
    ) {
      const cfg = configWithProvider("anthropic");
      (cfg.llm as { defaultProvider: string }).defaultProvider = providerName;
      const ingestion = new GnosysIngestion(store, tagRegistry, cfg);
      await expect(ingestion.ingest("raw input")).rejects.toThrow(snippet);
    }

    it("anthropic — mentions ANTHROPIC_API_KEY", async () => {
      await expectMissingProvider("anthropic", "ANTHROPIC_API_KEY");
    });

    it("openai — mentions OPENAI_API_KEY", async () => {
      await expectMissingProvider("openai", "OPENAI_API_KEY");
    });

    it("groq — mentions GROQ_API_KEY", async () => {
      await expectMissingProvider("groq", "GROQ_API_KEY");
    });

    it("xai — mentions XAI_API_KEY", async () => {
      await expectMissingProvider("xai", "XAI_API_KEY");
    });

    it("mistral — mentions MISTRAL_API_KEY", async () => {
      await expectMissingProvider("mistral", "MISTRAL_API_KEY");
    });

    it("custom — mentions GNOSYS_CUSTOM_KEY", async () => {
      await expectMissingProvider("custom", "GNOSYS_CUSTOM_KEY");
    });

    it("ollama — mentions running locally", async () => {
      await expectMissingProvider("ollama", "running locally");
    });

    it("lmstudio — mentions running locally", async () => {
      await expectMissingProvider("lmstudio", "running locally");
    });

    it("unknown provider — suggests switching default provider", async () => {
      await expectMissingProvider("not-a-real-provider", "Switch to a different default provider");
    });
  });

  describe("JSON parsing variants", () => {
    it("parses bare JSON from the LLM response", async () => {
      mockGenerate.mockResolvedValueOnce(
        JSON.stringify({
          title: "Bare JSON",
          category: "decisions",
          tags: { domain: ["auth"] },
          relevance: "auth login",
          content: "Body text",
          confidence: 0.9,
          filename: "bare-json",
        }),
      );
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const result = await ingestion.ingest("some raw note");
      expect(result.title).toBe("Bare JSON");
      expect(result.tags.domain).toEqual(["auth"]);
    });

    it("parses markdown-fenced JSON", async () => {
      mockGenerate.mockResolvedValueOnce(
        "```json\n" +
          JSON.stringify({
            title: "Fenced JSON",
            category: "concepts",
            tags: { type: ["concept"] },
            content: "Fenced body",
          }) +
          "\n```",
      );
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const result = await ingestion.ingest("raw");
      expect(result.title).toBe("Fenced JSON");
    });

    it("parses plain-fenced JSON without json language tag", async () => {
      mockGenerate.mockResolvedValueOnce(
        "```\n" +
          JSON.stringify({
            title: "Plain Fence",
            category: "concepts",
            tags: {},
            content: "Plain body",
          }) +
          "\n```",
      );
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const result = await ingestion.ingest("raw");
      expect(result.title).toBe("Plain Fence");
    });

    it("parses JSON embedded in prose", async () => {
      mockGenerate.mockResolvedValueOnce(
        "Here is the structured memory:\n```json\n" +
          JSON.stringify({
            title: "Mixed Prose",
            category: "decisions",
            tags: { domain: ["testing"] },
            content: "Mixed body",
          }) +
          "\n```\nDone.",
      );
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const result = await ingestion.ingest("raw");
      expect(result.title).toBe("Mixed Prose");
    });
  });

  describe("prototype-pollution sanitization", () => {
    it("strips __proto__, constructor, and prototype keys from LLM JSON", async () => {
      mockGenerate.mockResolvedValueOnce(
        JSON.stringify({
          title: "Safe Title",
          category: "concepts",
          tags: {},
          content: "Safe content",
          __proto__: { polluted: true },
          constructor: { evil: true },
          prototype: { bad: true },
        }),
      );
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const result = await ingestion.ingest("raw");
      expect(result.title).toBe("Safe Title");
      expect(Object.prototype.hasOwnProperty.call(result as object, "__proto__")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result as object, "constructor")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result as object, "prototype")).toBe(false);
    });
  });

  describe("tag validation and proposed new tags", () => {
    it("keeps registry tags and proposes unknown tags", async () => {
      mockGenerate.mockResolvedValueOnce(
        JSON.stringify({
          title: "Tag Mix",
          category: "decisions",
          tags: {
            domain: ["auth", "brand-new-domain-tag"],
            type: ["decision", "unknown-type-tag"],
          },
          content: "Tag body",
        }),
      );
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const result = await ingestion.ingest("raw");
      expect(result.tags.domain).toEqual(["auth"]);
      expect(result.tags.type).toEqual(["decision"]);
      expect(result.proposedNewTags).toEqual(
        expect.arrayContaining([
          { category: "domain", tag: "brand-new-domain-tag" },
          { category: "type", tag: "unknown-type-tag" },
        ]),
      );
    });

    it("includes explicit proposed_new_tags from the LLM response", async () => {
      mockGenerate.mockResolvedValueOnce(
        JSON.stringify({
          title: "Explicit Proposals",
          category: "concepts",
          tags: {},
          content: "Body",
          proposed_new_tags: [{ category: "concern", tag: "latency" }],
        }),
      );
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const result = await ingestion.ingest("raw");
      expect(result.proposedNewTags).toEqual([{ category: "concern", tag: "latency" }]);
    });
  });

  describe("field defaults", () => {
    it("applies defaults when the LLM returns minimal JSON", async () => {
      mockGenerate.mockResolvedValueOnce(JSON.stringify({ title: "Minimal Title" }));
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const result = await ingestion.ingest("fallback raw content");
      expect(result.category).toBe("uncategorized");
      expect(result.tags).toEqual({});
      expect(result.relevance).toBe("");
      expect(result.content).toBe("fallback raw content");
      expect(result.confidence).toBe(0.7);
      expect(result.filename).toBe("minimal-title");
    });
  });

  describe("configOverride", () => {
    it("resolves a fresh provider from configOverride", async () => {
      const overrideProvider = {
        name: "openai" as const,
        model: "override-model",
        generate: mockGenerate,
        testConnection: async () => true,
      };
      vi.mocked(getLLMProvider).mockImplementation((_cfg, _task) => {
        if (_cfg !== DEFAULT_CONFIG && _cfg.llm.defaultProvider === "openai") {
          return overrideProvider;
        }
        return fakeProvider;
      });
      mockGenerate.mockResolvedValueOnce(
        JSON.stringify({
          title: "Override Path",
          category: "concepts",
          tags: {},
          content: "Override body",
        }),
      );
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const override = configWithProvider("openai");
      const result = await ingestion.ingest("raw", override);
      expect(result.title).toBe("Override Path");
      expect(getLLMProvider).toHaveBeenCalledWith(override, "structuring");
    });

    it("throws provider-missing when configOverride has no available provider", async () => {
      vi.mocked(getLLMProvider).mockImplementation((cfg) => {
        if (cfg.llm.defaultProvider === "groq") {
          throw new Error("no groq key");
        }
        return fakeProvider;
      });
      const ingestion = new GnosysIngestion(store, tagRegistry);
      const override = configWithProvider("groq");
      await expect(ingestion.ingest("raw", override)).rejects.toThrow("GROQ_API_KEY");
    });
  });
});
