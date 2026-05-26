import { afterEach, describe, expect, it, vi } from "vitest";
import { validateModel } from "../lib/modelValidation.js";

describe("validateModel request builder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds anthropic requests with the expected URL and headers", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await validateModel("anthropic", "claude-3-5-sonnet", "secret-key");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "secret-key",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });

  it("builds openai and groq requests with bearer auth", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await validateModel("openai", "gpt-4o", "openai-key");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: "Bearer openai-key",
    });

    await validateModel("groq", "llama-3", "groq-key");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer groq-key",
    });
  });

  it("builds custom provider requests from baseUrl and returns unsupported errors", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await validateModel("custom", "my-model", "custom-key", {
      customBaseUrl: "https://proxy.example/v1/",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.example/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer custom-key",
        }),
      }),
    );

    const unsupported = await validateModel("unknown-provider", "model", "key");
    expect(unsupported.ok).toBe(false);
    expect(unsupported.error).toContain('Validation not supported for provider "unknown-provider"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
