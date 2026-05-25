import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL_HINT = /npm install @huggingface\/transformers/i;

describe("embeddings optional dep (@huggingface/transformers)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gnosys-emb-opt-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock("@huggingface/transformers");
  });

  it("throws a one-line install hint when transformers is missing", async () => {
    vi.doMock("@huggingface/transformers", () => {
      throw new Error("Cannot find package '@huggingface/transformers'");
    });

    const { GnosysEmbeddings } = await import("../lib/embeddings.js");
    const embeddings = new GnosysEmbeddings(tmpDir);

    await expect(embeddings.embed("hello")).rejects.toThrow(INSTALL_HINT);
    await expect(embeddings.embed("hello")).rejects.not.toThrow(/ERR_MODULE_NOT_FOUND/);
  });

  it("returns a 384-dim vector when transformers is available", async () => {
    const mockPipelineFn = vi.fn().mockResolvedValue({
      tolist: () => [Array.from({ length: 384 }, (_, i) => i / 384)],
    });
    vi.doMock("@huggingface/transformers", () => ({
      pipeline: vi.fn().mockResolvedValue(mockPipelineFn),
    }));

    const { GnosysEmbeddings } = await import("../lib/embeddings.js");
    const embeddings = new GnosysEmbeddings(tmpDir);

    const vector = await embeddings.embed("hello");
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(384);
  });
});
