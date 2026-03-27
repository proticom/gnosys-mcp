/**
 * Gnosys File Detection — Simple file type detection from extension and magic bytes.
 *
 * Used by multimodal ingestion to determine how to process incoming files.
 */

import * as fs from "fs/promises";
import * as path from "path";

// ─── Types ──────────────────────────────────────────────────────────────

export type FileType = "pdf" | "docx" | "image" | "audio" | "video" | "text" | "unknown";

export interface FileInfo {
  type: FileType;
  extension: string;
  mimeType: string;
}

// ─── Extension → Type mapping ───────────────────────────────────────────

const EXTENSION_MAP: Record<string, { type: FileType; mime: string }> = {
  // PDF
  pdf:  { type: "pdf",   mime: "application/pdf" },
  // DOCX
  docx: { type: "docx",  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  // Images
  png:  { type: "image", mime: "image/png" },
  jpg:  { type: "image", mime: "image/jpeg" },
  jpeg: { type: "image", mime: "image/jpeg" },
  gif:  { type: "image", mime: "image/gif" },
  webp: { type: "image", mime: "image/webp" },
  svg:  { type: "image", mime: "image/svg+xml" },
  // Audio
  mp3:  { type: "audio", mime: "audio/mpeg" },
  wav:  { type: "audio", mime: "audio/wav" },
  m4a:  { type: "audio", mime: "audio/mp4" },
  ogg:  { type: "audio", mime: "audio/ogg" },
  flac: { type: "audio", mime: "audio/flac" },
  // Video
  mp4:  { type: "video", mime: "video/mp4" },
  mkv:  { type: "video", mime: "video/x-matroska" },
  mov:  { type: "video", mime: "video/quicktime" },
  avi:  { type: "video", mime: "video/x-msvideo" },
  webm: { type: "video", mime: "video/webm" },
  // Text
  txt:  { type: "text",  mime: "text/plain" },
  md:   { type: "text",  mime: "text/markdown" },
};

// ─── Magic bytes signatures ─────────────────────────────────────────────

interface MagicSignature {
  bytes: number[];
  offset: number;
  type: FileType;
  mime: string;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  // PDF: starts with %PDF (0x25 0x50 0x44 0x46)
  { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0, type: "pdf",  mime: "application/pdf" },
  // PNG: starts with 0x89504E47
  { bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0, type: "image", mime: "image/png" },
  // DOCX (and other Office Open XML): PK zip header (0x50 0x4B 0x03 0x04)
  { bytes: [0x50, 0x4b, 0x03, 0x04], offset: 0, type: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
];

/**
 * Check file header bytes against known magic signatures.
 */
function matchMagicBytes(header: Buffer): { type: FileType; mime: string } | null {
  for (const sig of MAGIC_SIGNATURES) {
    if (header.length < sig.offset + sig.bytes.length) continue;

    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (header[sig.offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }

    if (match) {
      return { type: sig.type, mime: sig.mime };
    }
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Detect a file's type from its extension and (optionally) magic bytes.
 *
 * 1. Checks extension against known mapping
 * 2. Reads first 8 bytes for magic byte verification
 * 3. Falls back to "unknown" if neither matches
 */
export async function detectFileType(filePath: string): Promise<FileInfo> {
  const ext = path.extname(filePath).slice(1).toLowerCase();

  // Step 1: Check extension mapping
  const extMatch = EXTENSION_MAP[ext];

  // Step 2: Try magic bytes for additional confidence
  let magicMatch: { type: FileType; mime: string } | null = null;
  try {
    const fd = await fs.open(filePath, "r");
    try {
      const header = Buffer.alloc(8);
      await fd.read(header, 0, 8, 0);
      magicMatch = matchMagicBytes(header);
    } finally {
      await fd.close();
    }
  } catch {
    // Can't read file header — rely on extension only
  }

  // Magic bytes take priority when extension is missing or ambiguous
  if (magicMatch && !extMatch) {
    return {
      type: magicMatch.type,
      extension: ext || "bin",
      mimeType: magicMatch.mime,
    };
  }

  // Extension match is the primary source
  if (extMatch) {
    return {
      type: extMatch.type,
      extension: ext,
      mimeType: extMatch.mime,
    };
  }

  // Magic bytes as fallback when extension is unrecognized
  if (magicMatch) {
    return {
      type: magicMatch.type,
      extension: ext || "bin",
      mimeType: magicMatch.mime,
    };
  }

  // Nothing matched
  return {
    type: "unknown",
    extension: ext || "bin",
    mimeType: "application/octet-stream",
  };
}
