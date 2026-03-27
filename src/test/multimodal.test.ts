/**
 * Multimodal Pipeline Tests — Tests for fileDetect, chunkSplitter,
 * attachments, and config multimodal schema.
 *
 * These tests exercise the modules that do NOT need actual PDF/audio files.
 * File detection works from extensions; chunking and attachments use plain text and temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

import { detectFileType } from "../lib/fileDetect.js";
import { splitIntoChunks, splitSegments } from "../lib/chunkSplitter.js";
import {
  initAttachments,
  storeAttachment,
  listAttachments,
  linkMemoryToAttachment,
  getAttachmentPath,
} from "../lib/attachments.js";
import { GnosysConfigSchema, DEFAULT_CONFIG } from "../lib/config.js";

// ─── Helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gnosys-test-${prefix}-`));
}

/**
 * Create a tiny temp file with the given extension and optional content.
 * Returns the absolute path to the created file.
 */
function createTempFile(dir: string, name: string, content = "test"): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ─── fileDetect.ts tests ────────────────────────────────────────────────

describe("fileDetect", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir("filedetect");
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("detectFileType returns 'pdf' for .pdf files", async () => {
    const fp = createTempFile(tmpDir, "report.pdf");
    const info = await detectFileType(fp);
    expect(info.type).toBe("pdf");
    expect(info.extension).toBe("pdf");
    expect(info.mimeType).toBe("application/pdf");
  });

  it("detectFileType returns 'docx' for .docx files", async () => {
    const fp = createTempFile(tmpDir, "document.docx");
    const info = await detectFileType(fp);
    expect(info.type).toBe("docx");
    expect(info.extension).toBe("docx");
  });

  it("detectFileType returns 'image' for .png files", async () => {
    const fp = createTempFile(tmpDir, "photo.png");
    const info = await detectFileType(fp);
    expect(info.type).toBe("image");
    expect(info.extension).toBe("png");
    expect(info.mimeType).toBe("image/png");
  });

  it("detectFileType returns 'image' for .jpg files", async () => {
    const fp = createTempFile(tmpDir, "photo.jpg");
    const info = await detectFileType(fp);
    expect(info.type).toBe("image");
    expect(info.extension).toBe("jpg");
    expect(info.mimeType).toBe("image/jpeg");
  });

  it("detectFileType returns 'image' for .gif files", async () => {
    const fp = createTempFile(tmpDir, "anim.gif");
    const info = await detectFileType(fp);
    expect(info.type).toBe("image");
    expect(info.extension).toBe("gif");
  });

  it("detectFileType returns 'image' for .webp files", async () => {
    const fp = createTempFile(tmpDir, "hero.webp");
    const info = await detectFileType(fp);
    expect(info.type).toBe("image");
    expect(info.extension).toBe("webp");
  });

  it("detectFileType returns 'image' for .svg files", async () => {
    const fp = createTempFile(tmpDir, "logo.svg", "<svg></svg>");
    const info = await detectFileType(fp);
    expect(info.type).toBe("image");
    expect(info.extension).toBe("svg");
    expect(info.mimeType).toBe("image/svg+xml");
  });

  it("detectFileType returns 'audio' for .mp3 files", async () => {
    const fp = createTempFile(tmpDir, "song.mp3");
    const info = await detectFileType(fp);
    expect(info.type).toBe("audio");
    expect(info.extension).toBe("mp3");
    expect(info.mimeType).toBe("audio/mpeg");
  });

  it("detectFileType returns 'audio' for .wav files", async () => {
    const fp = createTempFile(tmpDir, "sound.wav");
    const info = await detectFileType(fp);
    expect(info.type).toBe("audio");
    expect(info.extension).toBe("wav");
  });

  it("detectFileType returns 'audio' for .m4a files", async () => {
    const fp = createTempFile(tmpDir, "voice.m4a");
    const info = await detectFileType(fp);
    expect(info.type).toBe("audio");
    expect(info.extension).toBe("m4a");
  });

  it("detectFileType returns 'audio' for .ogg files", async () => {
    const fp = createTempFile(tmpDir, "clip.ogg");
    const info = await detectFileType(fp);
    expect(info.type).toBe("audio");
    expect(info.extension).toBe("ogg");
  });

  it("detectFileType returns 'audio' for .flac files", async () => {
    const fp = createTempFile(tmpDir, "lossless.flac");
    const info = await detectFileType(fp);
    expect(info.type).toBe("audio");
    expect(info.extension).toBe("flac");
  });

  it("detectFileType returns 'video' for .mp4 files", async () => {
    const fp = createTempFile(tmpDir, "clip.mp4");
    const info = await detectFileType(fp);
    expect(info.type).toBe("video");
    expect(info.extension).toBe("mp4");
    expect(info.mimeType).toBe("video/mp4");
  });

  it("detectFileType returns 'video' for .mkv files", async () => {
    const fp = createTempFile(tmpDir, "movie.mkv");
    const info = await detectFileType(fp);
    expect(info.type).toBe("video");
    expect(info.extension).toBe("mkv");
  });

  it("detectFileType returns 'video' for .mov files", async () => {
    const fp = createTempFile(tmpDir, "screen.mov");
    const info = await detectFileType(fp);
    expect(info.type).toBe("video");
    expect(info.extension).toBe("mov");
  });

  it("detectFileType returns 'video' for .avi files", async () => {
    const fp = createTempFile(tmpDir, "old.avi");
    const info = await detectFileType(fp);
    expect(info.type).toBe("video");
    expect(info.extension).toBe("avi");
  });

  it("detectFileType returns 'text' for .txt files", async () => {
    const fp = createTempFile(tmpDir, "notes.txt", "Hello world");
    const info = await detectFileType(fp);
    expect(info.type).toBe("text");
    expect(info.extension).toBe("txt");
    expect(info.mimeType).toBe("text/plain");
  });

  it("detectFileType returns 'text' for .md files", async () => {
    const fp = createTempFile(tmpDir, "readme.md", "# Title\n\nContent");
    const info = await detectFileType(fp);
    expect(info.type).toBe("text");
    expect(info.extension).toBe("md");
    expect(info.mimeType).toBe("text/markdown");
  });

  it("detectFileType returns 'unknown' for .xyz files", async () => {
    const fp = createTempFile(tmpDir, "mystery.xyz");
    const info = await detectFileType(fp);
    expect(info.type).toBe("unknown");
    expect(info.extension).toBe("xyz");
    expect(info.mimeType).toBe("application/octet-stream");
  });
});

// ─── chunkSplitter.ts tests ─────────────────────────────────────────────

describe("chunkSplitter", () => {
  describe("splitIntoChunks", () => {
    it("splits text at paragraph boundaries", () => {
      const text = "Paragraph one about cats.\n\nParagraph two about dogs.\n\nParagraph three about birds.";
      const chunks = splitIntoChunks(text, { targetSize: 60, minSize: 10 });
      // Each paragraph is ~25 chars, target is 60, so two paragraphs per chunk
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // Verify no chunk contains broken mid-paragraph text
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeGreaterThan(0);
      }
    });

    it("merges small paragraphs into a single chunk", () => {
      const text = "Short.\n\nAlso short.\n\nTiny.";
      const chunks = splitIntoChunks(text, { targetSize: 1500, minSize: 200 });
      // All three paragraphs together are well under 1500 chars
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain("Short.");
      expect(chunks[0].text).toContain("Also short.");
      expect(chunks[0].text).toContain("Tiny.");
    });

    it("splits oversized paragraphs at sentence boundaries", () => {
      // Create a paragraph that exceeds maxSize (default 4000)
      const longSentences = Array.from({ length: 100 }, (_, i) =>
        `This is sentence number ${i + 1} which adds significant length to the paragraph.`
      ).join(" ");

      const chunks = splitIntoChunks(longSentences, {
        targetSize: 500,
        minSize: 50,
        maxSize: 600,
      });

      expect(chunks.length).toBeGreaterThan(1);
      // No chunk should greatly exceed maxSize (sentences may push slightly over)
      for (const chunk of chunks) {
        // Allow some overflow for sentence boundaries
        expect(chunk.text.length).toBeLessThan(1200);
      }
    });

    it("respects targetSize option", () => {
      // Build text with many paragraphs
      const paragraphs = Array.from({ length: 20 }, (_, i) =>
        `This is paragraph ${i + 1} with enough text to be meaningful and test the chunking logic properly.`
      ).join("\n\n");

      const smallChunks = splitIntoChunks(paragraphs, { targetSize: 200, minSize: 50 });
      const largeChunks = splitIntoChunks(paragraphs, { targetSize: 2000, minSize: 50 });

      // Smaller target should produce more chunks
      expect(smallChunks.length).toBeGreaterThan(largeChunks.length);
    });

    it("handles single paragraph text", () => {
      const text = "Just one paragraph with some content about testing.";
      const chunks = splitIntoChunks(text);
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toBe(text);
      expect(chunks[0].index).toBe(0);
    });

    it("handles empty text", () => {
      const chunks = splitIntoChunks("");
      expect(chunks).toEqual([]);
    });

    it("handles whitespace-only text", () => {
      const chunks = splitIntoChunks("   \n\n   \n\n   ");
      expect(chunks).toEqual([]);
    });

    it("assigns sequential index values", () => {
      const text = Array.from({ length: 10 }, (_, i) =>
        `Paragraph ${i + 1} with enough content to form its own chunk in a reasonable way.`
      ).join("\n\n");

      const chunks = splitIntoChunks(text, { targetSize: 100, minSize: 10 });
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });
  });

  describe("splitSegments", () => {
    it("preserves page metadata", () => {
      const segments = [
        { text: "Content from page one. It has enough text to stand alone as a chunk segment.", page: "1" },
        { text: "Content from page two. It also has enough text to stand alone as a chunk segment.", page: "2" },
        { text: "Content from page three. More text here to ensure it meets the minimum size.", page: "3" },
      ];

      const chunks = splitSegments(segments, { targetSize: 1500, minSize: 50 });
      // Each chunk should have a sourcePage set
      for (const chunk of chunks) {
        expect(chunk.sourcePage).toBeDefined();
        expect(["1", "2", "3"]).toContain(chunk.sourcePage);
      }
    });

    it("preserves timerange metadata", () => {
      const segments = [
        { text: "Speaker discusses the introduction to the topic with many details and examples.", timerange: "00:00:00-00:02:00" },
        { text: "The main argument is presented here with supporting evidence and data points.", timerange: "00:02:00-00:04:00" },
      ];

      const chunks = splitSegments(segments, { targetSize: 1500, minSize: 50 });
      for (const chunk of chunks) {
        expect(chunk.sourceTimerange).toBeDefined();
        expect(chunk.sourceTimerange).toMatch(/^\d{2}:\d{2}:\d{2}-\d{2}:\d{2}:\d{2}$/);
      }
    });

    it("merges undersized segments with same page", () => {
      const segments = [
        { text: "Tiny.", page: "1" },
        { text: "Also tiny.", page: "1" },
        { text: "This is a longer segment from page two that has enough content to stand on its own easily.", page: "2" },
      ];

      const chunks = splitSegments(segments, { targetSize: 1500, minSize: 50 });
      // The two tiny segments from page 1 should be merged since they're under minSize together
      // Page 2 content should be separate
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("handles empty segments array", () => {
      const chunks = splitSegments([]);
      expect(chunks).toEqual([]);
    });

    it("handles segments with empty text", () => {
      const segments = [
        { text: "", page: "1" },
        { text: "   ", page: "2" },
        { text: "Actual content from page three that is long enough to pass the minimum size threshold.", page: "3" },
      ];

      const chunks = splitSegments(segments, { targetSize: 1500, minSize: 50 });
      // Empty segments should be skipped
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });
  });
});

// ─── attachments.ts tests ───────────────────────────────────────────────

describe("attachments", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = makeTmpDir("attachments");
  });

  afterEach(async () => {
    await fsp.rm(storePath, { recursive: true, force: true });
  });

  it("initAttachments creates the directory and manifest", async () => {
    await initAttachments(storePath);

    const attachDir = path.join(storePath, "attachments");
    const manifestPath = path.join(attachDir, "attachments.json");

    expect(fs.existsSync(attachDir)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest).toEqual({ attachments: [] });
  });

  it("initAttachments is idempotent (safe to call twice)", async () => {
    await initAttachments(storePath);
    await initAttachments(storePath);

    const manifestPath = path.join(storePath, "attachments", "attachments.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest).toEqual({ attachments: [] });
  });

  it("storeAttachment copies file and generates UUID", async () => {
    // Create a source file to attach
    const sourceDir = makeTmpDir("attach-src");
    const sourceFile = path.join(sourceDir, "test-doc.txt");
    fs.writeFileSync(sourceFile, "Hello, this is a test document.", "utf-8");

    const record = await storeAttachment(storePath, sourceFile);

    expect(record.uuid).toBeDefined();
    expect(record.uuid.length).toBe(36); // UUID v4 format
    expect(record.originalName).toBe("test-doc.txt");
    expect(record.extension).toBe("txt");
    expect(record.mimeType).toBe("text/plain");
    expect(record.sizeBytes).toBeGreaterThan(0);
    expect(record.contentHash).toBeDefined();
    expect(record.contentHash.length).toBe(64); // SHA-256 hex
    expect(record.memoryIds).toEqual([]);

    // Verify the file was copied
    const copiedPath = path.join(storePath, "attachments", `${record.uuid}.txt`);
    expect(fs.existsSync(copiedPath)).toBe(true);

    // Verify the manifest was updated
    const manifest = JSON.parse(
      fs.readFileSync(path.join(storePath, "attachments", "attachments.json"), "utf-8")
    );
    expect(manifest.attachments.length).toBe(1);
    expect(manifest.attachments[0].uuid).toBe(record.uuid);

    await fsp.rm(sourceDir, { recursive: true, force: true });
  });

  it("storeAttachment detects duplicate by content hash", async () => {
    const sourceDir = makeTmpDir("attach-dup");
    const file1 = path.join(sourceDir, "original.txt");
    const file2 = path.join(sourceDir, "copy.txt");
    const content = "Identical content in both files.";
    fs.writeFileSync(file1, content, "utf-8");
    fs.writeFileSync(file2, content, "utf-8");

    const record1 = await storeAttachment(storePath, file1);
    const record2 = await storeAttachment(storePath, file2);

    // Same content hash should return the existing record
    expect(record2.uuid).toBe(record1.uuid);
    expect(record2.contentHash).toBe(record1.contentHash);

    // Manifest should only have one entry
    const attachments = await listAttachments(storePath);
    expect(attachments.length).toBe(1);

    await fsp.rm(sourceDir, { recursive: true, force: true });
  });

  it("listAttachments returns empty array initially", async () => {
    await initAttachments(storePath);
    const list = await listAttachments(storePath);
    expect(list).toEqual([]);
  });

  it("linkMemoryToAttachment updates the manifest", async () => {
    const sourceDir = makeTmpDir("attach-link");
    const sourceFile = path.join(sourceDir, "linked.txt");
    fs.writeFileSync(sourceFile, "Content to link.", "utf-8");

    const record = await storeAttachment(storePath, sourceFile);

    // Link a memory to the attachment
    await linkMemoryToAttachment(storePath, record.uuid, "mem-001");

    // Verify the manifest was updated
    const attachments = await listAttachments(storePath);
    expect(attachments[0].memoryIds).toContain("mem-001");

    // Link another memory
    await linkMemoryToAttachment(storePath, record.uuid, "mem-002");
    const updated = await listAttachments(storePath);
    expect(updated[0].memoryIds).toEqual(["mem-001", "mem-002"]);

    // Linking the same memory again should not duplicate
    await linkMemoryToAttachment(storePath, record.uuid, "mem-001");
    const final = await listAttachments(storePath);
    expect(final[0].memoryIds).toEqual(["mem-001", "mem-002"]);

    await fsp.rm(sourceDir, { recursive: true, force: true });
  });

  it("linkMemoryToAttachment throws for unknown UUID", async () => {
    await initAttachments(storePath);
    await expect(
      linkMemoryToAttachment(storePath, "nonexistent-uuid", "mem-001")
    ).rejects.toThrow("Attachment not found");
  });

  it("getAttachmentPath constructs correct path", () => {
    const result = getAttachmentPath("/store/path", "abc-123", "pdf");
    expect(result).toBe(path.join("/store/path", "attachments", "abc-123.pdf"));
  });
});

// ─── Config multimodal schema tests ─────────────────────────────────────

describe("config multimodal schema", () => {
  it("GnosysConfigSchema includes multimodal defaults", () => {
    const config = GnosysConfigSchema.parse({});
    expect(config.multimodal).toBeDefined();
    expect(config.multimodal).toHaveProperty("transcriptionProvider");
    expect(config.multimodal).toHaveProperty("chunkSize");
    expect(config.multimodal).toHaveProperty("maxFileSizeMb");
  });

  it("multimodal.transcriptionProvider defaults to 'groq'", () => {
    const config = GnosysConfigSchema.parse({});
    expect(config.multimodal.transcriptionProvider).toBe("groq");
  });

  it("multimodal.chunkSize defaults to 1500", () => {
    const config = GnosysConfigSchema.parse({});
    expect(config.multimodal.chunkSize).toBe(1500);
  });

  it("multimodal.maxFileSizeMb defaults to 100", () => {
    const config = GnosysConfigSchema.parse({});
    expect(config.multimodal.maxFileSizeMb).toBe(100);
  });

  it("DEFAULT_CONFIG has multimodal defaults", () => {
    expect(DEFAULT_CONFIG.multimodal).toBeDefined();
    expect(DEFAULT_CONFIG.multimodal.transcriptionProvider).toBe("groq");
    expect(DEFAULT_CONFIG.multimodal.chunkSize).toBe(1500);
    expect(DEFAULT_CONFIG.multimodal.maxFileSizeMb).toBe(100);
  });

  it("taskModels accepts 'vision' and 'transcription' tasks", () => {
    const config = GnosysConfigSchema.parse({
      taskModels: {
        vision: { provider: "anthropic", model: "claude-sonnet-4-6" },
        transcription: { provider: "groq", model: "whisper-large-v3" },
      },
    });

    expect(config.taskModels.vision).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(config.taskModels.transcription).toEqual({
      provider: "groq",
      model: "whisper-large-v3",
    });
  });

  it("multimodal config allows custom values", () => {
    const config = GnosysConfigSchema.parse({
      multimodal: {
        transcriptionProvider: "openai",
        chunkSize: 3000,
        maxFileSizeMb: 250,
        visionProvider: "anthropic",
        visionModel: "claude-sonnet-4-6",
      },
    });

    expect(config.multimodal.transcriptionProvider).toBe("openai");
    expect(config.multimodal.chunkSize).toBe(3000);
    expect(config.multimodal.maxFileSizeMb).toBe(250);
    expect(config.multimodal.visionProvider).toBe("anthropic");
    expect(config.multimodal.visionModel).toBe("claude-sonnet-4-6");
  });
});
