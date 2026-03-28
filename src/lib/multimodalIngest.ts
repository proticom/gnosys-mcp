/**
 * Gnosys Multimodal Ingestion Orchestrator — Ties together file detection,
 * extraction, chunking, attachment management, and memory creation.
 *
 * Supports PDF and DOCX in Phase 2. Image, audio, and video ingestion
 * will be added in Phase 3/4.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { detectFileType, FileType } from "./fileDetect.js";
import { storeAttachment, linkMemoryToAttachment, type AttachmentRecord } from "./attachments.js";
import { extractPdfText } from "./pdfExtract.js";
import { extractDocxText } from "./docxExtract.js";
import { extractImageDescription } from "./imageExtract.js";
import { transcribeAudio, type TranscriptSegment, type TranscriptionOptions } from "./audioExtract.js";
import { transcribeVideo } from "./videoExtract.js";
import { splitSegments, splitIntoChunks, type TextChunk } from "./chunkSplitter.js";
import { GnosysIngestion } from "./ingest.js";
import { GnosysTagRegistry } from "./tags.js";
import { GnosysStore } from "./store.js";
import { createProvider } from "./llm.js";
import { loadConfig, DEFAULT_CONFIG, getProviderModel, type GnosysConfig } from "./config.js";
import { syncMemoryToDb } from "./dbWrite.js";
import { GnosysDB } from "./db.js";
import { findProjectIdentity } from "./projectIdentity.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface MultimodalIngestOptions {
  /** Absolute path to the file to ingest */
  filePath: string;
  /** Path to the .gnosys store directory */
  storePath: string;
  /** Ingestion mode: "llm" uses AI structuring, "structured" uses TF-IDF keywords */
  mode?: "llm" | "structured";
  /** Target store layer */
  store?: "project" | "personal" | "global";
  /** Who created this memory */
  author?: "human" | "ai" | "human+ai";
  /** Trust level */
  authority?: "declared" | "observed" | "imported" | "inferred";
  /** Preview mode — show what would be created without writing */
  dryRun?: boolean;
  /** Project root for config resolution */
  projectRoot?: string;
  /** Progress callback for UI updates */
  onProgress?: (progress: { current: number; total: number; title?: string }) => void;
}

export interface MultimodalIngestResult {
  /** The attachment record (file stored in .gnosys/attachments/) */
  attachment: AttachmentRecord;
  /** Memories created from the file's content */
  memories: Array<{
    id: string;
    title: string;
    path: string;
    page?: string;
    timerange?: string;
  }>;
  /** Errors encountered during chunk processing */
  errors: Array<{ chunk: number; error: string }>;
  /** Total processing time in milliseconds */
  duration: number;
  /** Detected file type */
  fileType: FileType;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Build a simple keyword-based relevance string from a chunk of text.
 * Used in "structured" mode when no LLM is available.
 */
function buildRelevance(text: string, sourceFile: string): string {
  // Extract the most frequent meaningful words (basic TF approach)
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // Count word frequency
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  // Sort by frequency, take top 20
  const topWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);

  // Add the source filename (without extension) for searchability
  const baseName = path.basename(sourceFile, path.extname(sourceFile))
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim();

  return [...new Set([baseName, ...topWords])].join(" ");
}

/**
 * Generate a title from a chunk of text.
 * Takes the first line or first ~60 chars as the title.
 */
function generateTitle(text: string, chunkIndex: number, sourceFile: string, page?: string): string {
  const baseName = path.basename(sourceFile, path.extname(sourceFile));

  // Try to use the first line if it looks like a heading
  const firstLine = text.split("\n")[0].replace(/^#+\s*/, "").trim();
  if (firstLine && firstLine.length > 5 && firstLine.length < 120) {
    return firstLine;
  }

  // Fall back to a descriptive title
  const pageLabel = page ? ` p${page}` : "";
  return `${baseName}${pageLabel} — chunk ${chunkIndex + 1}`;
}

// ─── Audio / Video helpers ───────────────────────────────────────────────

/**
 * Format seconds as "HH:MM:SS" for display in source_timerange.
 */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Build transcription options from the Gnosys config.
 */
function buildTranscriptionOptions(config: GnosysConfig): TranscriptionOptions {
  return {
    provider: config.multimodal?.transcriptionProvider,
    model: config.multimodal?.whisperModel,
  };
}

/**
 * Group transcript segments into ~2-minute time windows and convert
 * them into TextChunks with timerange metadata.
 *
 * Each chunk gets a sourceTimerange like "00:01:23-00:03:15" so the
 * resulting memory can reference back to the original audio/video.
 */
function buildTranscriptChunks(
  segments: TranscriptSegment[],
  targetSize: number,
): TextChunk[] {
  if (segments.length === 0) return [];

  const TARGET_WINDOW_SECONDS = 120; // ~2-minute windows

  // Group segments into time windows
  const windows: Array<{
    texts: string[];
    startTime: number;
    endTime: number;
  }> = [];

  let currentWindow: { texts: string[]; startTime: number; endTime: number } | null = null;

  for (const seg of segments) {
    if (!seg.text.trim()) continue;

    if (
      !currentWindow ||
      seg.startTime - currentWindow.startTime >= TARGET_WINDOW_SECONDS
    ) {
      // Start a new window
      if (currentWindow) windows.push(currentWindow);
      currentWindow = {
        texts: [seg.text.trim()],
        startTime: seg.startTime,
        endTime: seg.endTime,
      };
    } else {
      // Add to the current window
      currentWindow.texts.push(seg.text.trim());
      currentWindow.endTime = seg.endTime;
    }
  }

  if (currentWindow) windows.push(currentWindow);

  // Convert time windows into segments for splitSegments
  const timedSegments = windows.map((w) => ({
    text: w.texts.join(" "),
    timerange: `${formatTime(w.startTime)}-${formatTime(w.endTime)}`,
  }));

  return splitSegments(timedSegments, { targetSize });
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Ingest a file into Gnosys memory.
 *
 * Steps:
 * 1. Detect file type (PDF, DOCX, text, etc.)
 * 2. Validate file size
 * 3. Copy file to .gnosys/attachments/
 * 4. Extract text based on file type
 * 5. Split text into memory-sized chunks
 * 6. Create a memory for each chunk (via LLM or structured mode)
 * 7. Link each memory back to the attachment
 */
export async function ingestFile(options: MultimodalIngestOptions): Promise<MultimodalIngestResult> {
  const startTime = Date.now();
  const {
    filePath,
    storePath,
    mode = "llm",
    author = "human",
    authority = "imported",
    dryRun = false,
    projectRoot,
    onProgress,
  } = options;

  // Step 1: Detect file type
  const fileInfo = await detectFileType(filePath);

  // Reject unsupported types early
  if (fileInfo.type === "unknown") {
    throw new Error(
      `Unsupported file type: ${path.extname(filePath) || "unknown"}. ` +
      `Supported: PDF, DOCX, TXT, MD, PNG, JPG, GIF, WEBP, MP3, WAV, M4A, MP4, MKV, MOV.`
    );
  }

  // Step 2: Validate file size
  let config: GnosysConfig = DEFAULT_CONFIG;
  try {
    config = await loadConfig(storePath);
  } catch {
    // Use defaults
  }

  const stat = await fs.stat(filePath);
  const fileSizeMb = stat.size / (1024 * 1024);
  const maxSizeMb = config.multimodal?.maxFileSizeMb ?? 100;

  if (fileSizeMb > maxSizeMb) {
    throw new Error(
      `File is ${fileSizeMb.toFixed(1)}MB, which exceeds the ${maxSizeMb}MB limit. ` +
      `Adjust multimodal.maxFileSizeMb in gnosys.json to increase.`
    );
  }

  // Step 3: Store as attachment (skip in dry run)
  let attachment: AttachmentRecord;
  if (dryRun) {
    attachment = {
      uuid: "dry-run-uuid",
      originalName: path.basename(filePath),
      extension: fileInfo.extension,
      mimeType: fileInfo.mimeType,
      sizeBytes: stat.size,
      contentHash: "dry-run-hash",
      createdAt: new Date().toISOString(),
      memoryIds: [],
    };
  } else {
    attachment = await storeAttachment(storePath, filePath);
  }

  // Step 4: Extract text based on file type
  let chunks: TextChunk[];
  const chunkSize = config.multimodal?.chunkSize ?? 1500;
  const sourceFileName = path.basename(filePath);

  switch (fileInfo.type) {
    case "pdf": {
      const pdfChunks = await extractPdfText(filePath);
      // Convert PDF sections into segments — pages tracked as metadata
      const segments = pdfChunks.map((pc) => ({
        text: pc.text,
        page: pc.pages,
      }));
      chunks = splitSegments(segments, { targetSize: chunkSize });
      break;
    }

    case "docx": {
      const docxChunks = await extractDocxText(filePath);
      // Each DOCX section becomes a segment (no page numbers for DOCX)
      const segments = docxChunks.map((dc) => ({
        text: dc.text,
        page: dc.sectionHeading,
      }));
      chunks = splitSegments(segments, { targetSize: chunkSize });
      break;
    }

    case "text": {
      // Plain text / markdown — read raw and split into chunks
      const rawText = await fs.readFile(filePath, "utf-8");
      chunks = splitIntoChunks(rawText, { targetSize: chunkSize });
      break;
    }

    case "image": {
      // Image ingestion: use a vision LLM to describe the image,
      // then create a single memory from the description.
      // This is a separate path — images produce one memory, not chunks.
      return await ingestImage(filePath, storePath, config, attachment, {
        author,
        authority,
        dryRun,
        mode,
        onProgress,
        startTime,
        sourceFileName,
      });
    }

    case "audio": {
      // Audio ingestion: transcribe with Whisper, then chunk by time windows
      const audioOptions = buildTranscriptionOptions(config);
      const transcript = await transcribeAudio(filePath, audioOptions);
      chunks = buildTranscriptChunks(transcript.segments, chunkSize);
      break;
    }

    case "video": {
      // Video ingestion: extract audio via ffmpeg, transcribe, then chunk
      const videoOptions = buildTranscriptionOptions(config);
      const videoTranscript = await transcribeVideo(filePath, videoOptions);
      chunks = buildTranscriptChunks(videoTranscript.segments, chunkSize);
      break;
    }

    default:
      throw new Error(`File type "${fileInfo.type}" is not yet supported for text extraction.`);
  }

  if (chunks.length === 0) {
    return {
      attachment,
      memories: [],
      errors: [{ chunk: 0, error: "No text content could be extracted from the file." }],
      duration: Date.now() - startTime,
      fileType: fileInfo.type,
    };
  }

  // Step 5: Initialize the store and ingestion pipeline
  const gnosysStore = new GnosysStore(storePath);
  const tagRegistry = new GnosysTagRegistry(storePath);
  await tagRegistry.load();
  const ingestion = new GnosysIngestion(gnosysStore, tagRegistry, config);

  // Detect project ID for DB writes
  const projectDir = path.dirname(storePath);
  let projectId: string | null = null;
  try {
    const found = await findProjectIdentity(projectDir);
    if (found) projectId = found.identity.projectId;
  } catch {
    // Non-critical — will write without project scope
  }

  const today = new Date().toISOString().split("T")[0];
  const memories: MultimodalIngestResult["memories"] = [];
  const errors: MultimodalIngestResult["errors"] = [];

  // Step 6: Process each chunk into a memory
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: chunks.length,
        title: `Processing chunk ${i + 1}/${chunks.length}`,
      });
    }

    try {
      let title: string;
      let category: string;
      let tags: Record<string, string[]>;
      let relevance: string;
      let content: string;
      let confidence: number;
      let filename: string;

      if (mode === "llm" && ingestion.isLLMAvailable) {
        // LLM-powered structuring
        const result = await ingestion.ingest(chunk.text);
        title = result.title;
        category = result.category;
        tags = result.tags;
        relevance = result.relevance;
        content = result.content;
        confidence = result.confidence;
        filename = result.filename;
      } else {
        // Structured mode — no LLM needed
        title = generateTitle(chunk.text, i, sourceFileName, chunk.sourcePage);
        category = "imported";
        tags = { type: ["imported"], source: ["document"] };
        relevance = buildRelevance(chunk.text, sourceFileName);
        content = chunk.text;
        confidence = 0.7;
        filename = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .substring(0, 60);
      }

      if (dryRun) {
        memories.push({
          id: `dry-run-${i}`,
          title,
          path: `${category}/${filename}.md`,
          page: chunk.sourcePage,
          timerange: chunk.sourceTimerange,
        });
        continue;
      }

      // Generate a unique ID and write to central DB (no markdown files)
      const centralDb = GnosysDB.openCentral();
      const id = centralDb.getNextId(category, projectId || undefined);

      const frontmatter = {
        id,
        title,
        category,
        tags,
        relevance,
        author: author as "human" | "ai" | "human+ai",
        authority: authority as "declared" | "observed" | "imported" | "inferred",
        confidence,
        created: today,
        modified: today,
        last_reviewed: today,
        status: "active" as const,
        supersedes: null,
        // v5.0: Source tracking
        source_file: sourceFileName,
        source_page: chunk.sourcePage || null,
        source_timerange: chunk.sourceTimerange || null,
      };

      const memoryContent = `# ${title}\n\n${content}`;
      syncMemoryToDb(centralDb, frontmatter, memoryContent, undefined, projectId || undefined, "project");
      centralDb.close();

      // Link the memory to its attachment
      await linkMemoryToAttachment(storePath, attachment.uuid, id);

      memories.push({
        id,
        title,
        path: `${category}/${filename}`,
        page: chunk.sourcePage,
        timerange: chunk.sourceTimerange,
      });
    } catch (err) {
      errors.push({
        chunk: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    attachment,
    memories,
    errors,
    duration: Date.now() - startTime,
    fileType: fileInfo.type,
  };
}

// ─── Image Ingestion ────────────────────────────────────────────────────

/**
 * Ingest an image file into a single memory using a vision LLM.
 * Resolves the vision provider from config: multimodal.visionProvider
 * falls back to llm.defaultProvider. Similarly for the model.
 */
async function ingestImage(
  filePath: string,
  storePath: string,
  config: GnosysConfig,
  attachment: AttachmentRecord,
  opts: {
    author: "human" | "ai" | "human+ai";
    authority: "declared" | "observed" | "imported" | "inferred";
    dryRun: boolean;
    mode: "llm" | "structured";
    onProgress?: MultimodalIngestOptions["onProgress"];
    startTime: number;
    sourceFileName: string;
  }
): Promise<MultimodalIngestResult> {
  const { author, authority, dryRun, onProgress, startTime, sourceFileName } = opts;

  if (onProgress) {
    onProgress({ current: 1, total: 1, title: "Analyzing image with vision LLM" });
  }

  // Resolve vision provider: config.multimodal.visionProvider > config.llm.defaultProvider
  const visionProviderName = config.multimodal?.visionProvider || config.llm.defaultProvider;
  const visionModel = config.multimodal?.visionModel || getProviderModel(config, visionProviderName);
  const provider = createProvider(visionProviderName, visionModel, config);

  // Extract description from the image
  const imageDesc = await extractImageDescription(filePath, provider);

  if (!imageDesc.text || imageDesc.text.trim().length === 0) {
    return {
      attachment,
      memories: [],
      errors: [{ chunk: 0, error: "Vision LLM returned an empty description for the image." }],
      duration: Date.now() - startTime,
      fileType: "image",
    };
  }

  // Build the memory
  const baseName = path.basename(filePath, path.extname(filePath));
  const title = imageDesc.description
    ? (imageDesc.description.length > 100
        ? imageDesc.description.slice(0, 97) + "..."
        : imageDesc.description)
    : `Image: ${baseName}`;
  const category = "imported";
  const tags: Record<string, string[]> = {
    type: ["imported", "image"],
    source: ["image"],
    ...(imageDesc.topics.length > 0 ? { topic: imageDesc.topics.slice(0, 5) } : {}),
  };
  const relevance = [
    baseName.replace(/[^a-zA-Z0-9]+/g, " ").trim(),
    ...imageDesc.topics,
  ]
    .filter(Boolean)
    .join(" ");
  const confidence = 0.7;
  const filename = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 60);

  if (dryRun) {
    return {
      attachment,
      memories: [
        {
          id: "dry-run-0",
          title,
          path: `${category}/${filename}.md`,
        },
      ],
      errors: [],
      duration: Date.now() - startTime,
      fileType: "image",
    };
  }

  // Write the memory to central DB (no markdown files)
  const centralDb = GnosysDB.openCentral();
  const today = new Date().toISOString().split("T")[0];

  // Detect project ID for DB writes
  const projectDir = path.dirname(storePath);
  let projectId: string | null = null;
  try {
    const found = await findProjectIdentity(projectDir);
    if (found) projectId = found.identity.projectId;
  } catch {
    // Non-critical
  }

  const id = centralDb.getNextId(category, projectId || undefined);

  const frontmatter = {
    id,
    title,
    category,
    tags,
    relevance,
    author,
    authority,
    confidence,
    created: today,
    modified: today,
    last_reviewed: today,
    status: "active" as const,
    supersedes: null,
    source_file: sourceFileName,
    source_page: null,
    source_timerange: null,
  };

  const memoryContent = `# ${title}\n\n${imageDesc.text}`;
  syncMemoryToDb(centralDb, frontmatter, memoryContent, undefined, projectId || undefined, "project");
  centralDb.close();

  // Link the memory to its attachment
  await linkMemoryToAttachment(storePath, attachment.uuid, id);

  return {
    attachment,
    memories: [{ id, title, path: `${category}/${filename}` }],
    errors: [],
    duration: Date.now() - startTime,
    fileType: "image",
  };
}
