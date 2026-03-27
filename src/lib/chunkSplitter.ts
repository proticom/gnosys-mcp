/**
 * Gnosys Chunk Splitter — Text chunking for multi-page content.
 *
 * Splits long text into memory-sized chunks at natural boundaries
 * (paragraphs first, then sentences). Used by multimodal ingestion
 * to break PDFs, transcripts, and documents into atomic memories.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface TextChunk {
  text: string;
  index: number;
  sourcePage?: string;
  sourceTimerange?: string;
  metadata?: Record<string, unknown>;
}

export interface ChunkOptions {
  /** Target chunk size in characters (default: 1500) */
  targetSize?: number;
  /** Minimum chunk size — chunks below this merge with the next (default: 200) */
  minSize?: number;
  /** Maximum chunk size — paragraphs exceeding this get split at sentences (default: 4000) */
  maxSize?: number;
}

// ─── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_TARGET = 1500;
const DEFAULT_MIN = 200;
const DEFAULT_MAX = 4000;

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Split text at sentence boundaries (. ! ? followed by space or newline).
 * Never splits mid-sentence.
 */
function splitAtSentences(text: string): string[] {
  // Match sentence-ending punctuation followed by whitespace or end-of-string
  const sentences: string[] = [];
  // Use regex to find sentence boundaries
  const pattern = /[.!?](?:\s|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const endPos = match.index + match[0].length;
    const sentence = text.slice(lastIndex, endPos).trim();
    if (sentence) {
      sentences.push(sentence);
    }
    lastIndex = endPos;
  }

  // Remaining text after last sentence boundary
  const remainder = text.slice(lastIndex).trim();
  if (remainder) {
    sentences.push(remainder);
  }

  // If no sentence boundaries found, return the original text as-is
  if (sentences.length === 0 && text.trim()) {
    return [text.trim()];
  }

  return sentences;
}

/**
 * Split a large paragraph into chunks that fit within maxSize
 * by splitting at sentence boundaries.
 */
function splitLargeParagraph(paragraph: string, maxSize: number): string[] {
  if (paragraph.length <= maxSize) {
    return [paragraph];
  }

  const sentences = splitAtSentences(paragraph);
  const result: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    // If a single sentence exceeds maxSize, include it as-is
    // (we never split mid-sentence)
    if (sentence.length > maxSize) {
      if (current) {
        result.push(current.trim());
        current = "";
      }
      result.push(sentence);
      continue;
    }

    if (current.length + sentence.length + 1 > maxSize) {
      if (current) {
        result.push(current.trim());
      }
      current = sentence;
    } else {
      current = current ? current + " " + sentence : sentence;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Split a block of text into chunks at paragraph boundaries (double newlines).
 *
 * Algorithm:
 * 1. Split at double-newline (paragraph) boundaries
 * 2. Accumulate paragraphs until reaching targetSize
 * 3. If a single paragraph exceeds maxSize, split it at sentence boundaries
 * 4. Merge chunks that are under minSize with the next chunk
 */
export function splitIntoChunks(text: string, options?: ChunkOptions): TextChunk[] {
  const targetSize = options?.targetSize ?? DEFAULT_TARGET;
  const minSize = options?.minSize ?? DEFAULT_MIN;
  const maxSize = options?.maxSize ?? DEFAULT_MAX;

  if (!text.trim()) {
    return [];
  }

  // Split into paragraphs at double-newlines
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  if (paragraphs.length === 0) {
    return [];
  }

  // Expand any oversized paragraphs into sentence-level pieces
  const pieces: string[] = [];
  for (const para of paragraphs) {
    if (para.length > maxSize) {
      pieces.push(...splitLargeParagraph(para, maxSize));
    } else {
      pieces.push(para);
    }
  }

  // Accumulate pieces into target-sized chunks
  const rawChunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    if (!current) {
      current = piece;
      continue;
    }

    // Would adding this piece exceed the target?
    if (current.length + piece.length + 2 > targetSize) {
      rawChunks.push(current);
      current = piece;
    } else {
      current = current + "\n\n" + piece;
    }
  }

  if (current) {
    rawChunks.push(current);
  }

  // Merge undersized chunks with the next chunk
  const merged: string[] = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = rawChunks[i];
    if (chunk.length < minSize && i < rawChunks.length - 1) {
      // Merge with next chunk
      rawChunks[i + 1] = chunk + "\n\n" + rawChunks[i + 1];
    } else {
      merged.push(chunk);
    }
  }

  // Convert to TextChunk objects
  return merged.map((text, index) => ({
    text,
    index,
  }));
}

/**
 * Split pre-segmented content (pages, transcript segments) into chunks.
 *
 * Each segment has its own page number or timerange metadata.
 * Segments are chunked individually, preserving their source metadata.
 * Short segments that are under minSize get merged with the next segment
 * (only if they share the same page).
 */
export function splitSegments(
  segments: Array<{ text: string; page?: string; timerange?: string }>,
  options?: ChunkOptions
): TextChunk[] {
  const targetSize = options?.targetSize ?? DEFAULT_TARGET;
  const minSize = options?.minSize ?? DEFAULT_MIN;
  const maxSize = options?.maxSize ?? DEFAULT_MAX;

  if (segments.length === 0) {
    return [];
  }

  const allChunks: TextChunk[] = [];
  let globalIndex = 0;

  // Buffer for merging undersized segments with matching page/timerange
  let buffer = "";
  let bufferPage: string | undefined;
  let bufferTimerange: string | undefined;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const text = seg.text.trim();
    if (!text) continue;

    const page = seg.page;
    const timerange = seg.timerange;

    // If we have buffered text from a previous undersized segment
    // and this segment has a different page, flush the buffer first
    if (buffer && page !== bufferPage) {
      const chunks = splitIntoChunks(buffer, { targetSize, minSize, maxSize });
      for (const chunk of chunks) {
        allChunks.push({
          ...chunk,
          index: globalIndex++,
          sourcePage: bufferPage,
          sourceTimerange: bufferTimerange,
        });
      }
      buffer = "";
      bufferPage = undefined;
      bufferTimerange = undefined;
    }

    // Accumulate text
    if (buffer) {
      buffer = buffer + "\n\n" + text;
    } else {
      buffer = text;
      bufferPage = page;
      bufferTimerange = timerange;
    }

    // If buffer is large enough, process it
    if (buffer.length >= minSize) {
      const chunks = splitIntoChunks(buffer, { targetSize, minSize, maxSize });
      for (const chunk of chunks) {
        allChunks.push({
          ...chunk,
          index: globalIndex++,
          sourcePage: bufferPage,
          sourceTimerange: bufferTimerange,
        });
      }
      buffer = "";
      bufferPage = undefined;
      bufferTimerange = undefined;
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    const chunks = splitIntoChunks(buffer, { targetSize, minSize: 0, maxSize });
    for (const chunk of chunks) {
      allChunks.push({
        ...chunk,
        index: globalIndex++,
        sourcePage: bufferPage,
        sourceTimerange: bufferTimerange,
      });
    }
  }

  return allChunks;
}
