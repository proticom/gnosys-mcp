/**
 * Gnosys DOCX Extraction — Extract text from Word documents as markdown.
 *
 * Uses mammoth for HTML conversion and turndown for markdown conversion.
 * Splits output on H1/H2 headings to produce section-sized chunks.
 * Both libraries are loaded via dynamic import so they stay optional.
 */

import * as fs from "fs/promises";

// ─── Types ──────────────────────────────────────────────────────────────

export interface DocxChunk {
  /** Extracted text content as markdown */
  text: string;
  /** The heading that starts this section, if any */
  sectionHeading?: string;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Extract text from a DOCX file as markdown, split into section chunks.
 *
 * Flow:
 * 1. Read file as buffer
 * 2. mammoth converts DOCX to HTML
 * 3. turndown converts HTML to markdown
 * 4. Split on H1 (# ) and H2 (## ) headings to produce section-sized chunks
 *
 * If the document has no headings, the entire content is returned as
 * a single chunk.
 */
export async function extractDocxText(filePath: string): Promise<DocxChunk[]> {
  // Dynamic imports — these are optional dependencies
  const mammoth = await import("mammoth");
  const TurndownService = (await import("turndown")).default;

  // Read the file and convert to HTML
  const buffer = await fs.readFile(filePath);
  const result = await mammoth.convertToHtml({ buffer });
  const html = result.value;

  if (!html || !html.trim()) {
    return [];
  }

  // Convert HTML to markdown
  const turndown = new TurndownService({
    headingStyle: "atx",       // Use # style headings
    codeBlockStyle: "fenced",  // Use ``` for code blocks
  });
  const markdown = turndown.turndown(html);

  if (!markdown.trim()) {
    return [];
  }

  // Split on H1 and H2 headings (lines starting with # or ##)
  // We keep the heading as part of the chunk it starts
  const lines = markdown.split("\n");
  const chunks: DocxChunk[] = [];
  let currentChunkLines: string[] = [];
  let currentHeading: string | undefined;

  for (const line of lines) {
    // Check if this line is an H1 or H2 heading
    const headingMatch = line.match(/^(#{1,2})\s+(.+)$/);

    if (headingMatch) {
      // Flush the current chunk before starting a new section
      if (currentChunkLines.length > 0) {
        const text = currentChunkLines.join("\n").trim();
        if (text) {
          chunks.push({ text, sectionHeading: currentHeading });
        }
      }

      // Start a new chunk with this heading
      currentChunkLines = [line];
      currentHeading = headingMatch[2].trim();
    } else {
      currentChunkLines.push(line);
    }
  }

  // Flush the last chunk
  if (currentChunkLines.length > 0) {
    const text = currentChunkLines.join("\n").trim();
    if (text) {
      chunks.push({ text, sectionHeading: currentHeading });
    }
  }

  // If no headings were found, the entire document is one chunk
  if (chunks.length === 0) {
    chunks.push({ text: markdown.trim() });
  }

  return chunks;
}
