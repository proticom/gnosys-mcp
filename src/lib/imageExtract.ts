/**
 * Gnosys Image Extraction — Send an image to a vision-capable LLM
 * and get a structured description suitable for memory creation.
 *
 * Part of v5.0 Phase 3: Multimodal Ingestion — Image support.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { LLMProvider } from "./llm.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface ImageDescription {
  /** Combined text suitable for storing as memory content */
  text: string;
  /** What the image shows */
  description: string;
  /** Any visible text extracted via OCR (if found) */
  detectedText?: string;
  /** Key topics / subjects relevant to this image */
  topics: string[];
}

// ─── MIME type detection from file extension ────────────────────────────

const EXTENSION_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_TO_MIME[ext] || "image/png";
}

// ─── Vision prompt ──────────────────────────────────────────────────────

const VISION_PROMPT = `Analyze this image and provide:
1. A detailed description of what the image shows
2. Any visible text (OCR)
3. The likely purpose of this image (documentation, diagram, screenshot, photo, etc.)
4. Key topics or subjects relevant to this image

Format your response as:
DESCRIPTION: <description>
VISIBLE TEXT: <any text in the image, or "none">
PURPOSE: <purpose>
TOPICS: <comma-separated list>`;

// ─── Response parser ────────────────────────────────────────────────────

function parseVisionResponse(raw: string): ImageDescription {
  const lines = raw.split("\n").map((l) => l.trim());

  let description = "";
  let detectedText: string | undefined;
  let purpose = "";
  let topics: string[] = [];

  for (const line of lines) {
    if (line.toUpperCase().startsWith("DESCRIPTION:")) {
      description = line.slice("DESCRIPTION:".length).trim();
    } else if (line.toUpperCase().startsWith("VISIBLE TEXT:")) {
      const text = line.slice("VISIBLE TEXT:".length).trim();
      if (text.toLowerCase() !== "none" && text.length > 0) {
        detectedText = text;
      }
    } else if (line.toUpperCase().startsWith("PURPOSE:")) {
      purpose = line.slice("PURPOSE:".length).trim();
    } else if (line.toUpperCase().startsWith("TOPICS:")) {
      const raw = line.slice("TOPICS:".length).trim();
      topics = raw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }

  // If parsing failed (LLM returned unstructured text), use the raw response
  if (!description && raw.length > 0) {
    description = raw.trim();
  }

  // Build the combined text for memory content
  const parts: string[] = [];
  if (description) parts.push(description);
  if (purpose) parts.push(`Purpose: ${purpose}`);
  if (detectedText) parts.push(`Visible text: ${detectedText}`);

  return {
    text: parts.join("\n\n"),
    description,
    detectedText,
    topics,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Send an image to a vision-capable LLM and get a structured description.
 * Returns a single text chunk suitable for memory creation.
 *
 * If the provider does not support vision (no `generateWithImage` method),
 * returns a minimal fallback description with just filename and file size.
 */
export async function extractImageDescription(
  filePath: string,
  provider: LLMProvider
): Promise<ImageDescription> {
  // Read the image file
  const buffer = await fs.readFile(filePath);
  const imageBase64 = buffer.toString("base64");
  const mimeType = detectMimeType(filePath);

  // Check if the provider supports vision
  if (!provider.generateWithImage) {
    // Fallback: return minimal description without LLM
    const stat = await fs.stat(filePath);
    const fileName = path.basename(filePath);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);

    return {
      text: `Image file: ${fileName} (${sizeMb} MB, ${mimeType})`,
      description: `Image file "${fileName}" — no vision LLM available for analysis.`,
      topics: [],
    };
  }

  // Call the vision LLM
  const raw = await provider.generateWithImage(
    VISION_PROMPT,
    imageBase64,
    mimeType
  );

  return parseVisionResponse(raw);
}
