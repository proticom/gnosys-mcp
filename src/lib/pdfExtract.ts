/**
 * Gnosys PDF Extraction — Extract text from PDF files, one chunk per page.
 *
 * Uses pdf-parse v2 (class-based API wrapping Mozilla's pdf.js) via dynamic
 * import so it stays optional and doesn't break builds that don't need it.
 */

import * as fs from "fs/promises";

// ─── Types ──────────────────────────────────────────────────────────────

export interface PdfChunk {
  /** Extracted text content for this page (or merged pages) */
  text: string;
  /** 1-based page number */
  pageNumber: number;
  /** Total number of pages in the PDF */
  pageCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Pages with fewer characters than this get merged with the next page */
const MIN_PAGE_CHARS = 50;

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Extract text from a PDF file, returning one chunk per page.
 *
 * Pages with fewer than 50 characters are merged with the next page
 * to avoid creating tiny, useless chunks (e.g. cover pages, blank pages).
 *
 * Uses pdf-parse v2's PDFParse class with per-page text extraction.
 */
export async function extractPdfText(filePath: string): Promise<PdfChunk[]> {
  // Dynamic import — pdf-parse is an optional dependency
  const { PDFParse } = await import("pdf-parse");

  // Read the file as a buffer and convert to Uint8Array
  const buffer = await fs.readFile(filePath);
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Create parser and extract text
  const parser = new PDFParse({ data });
  let textResult;
  try {
    textResult = await parser.getText();
  } finally {
    await parser.destroy();
  }

  const totalPages = textResult.total || 1;

  // If no pages with text, return empty
  if (!textResult.pages || textResult.pages.length === 0) {
    const fullText = textResult.text?.trim();
    if (!fullText) return [];
    return [{ text: fullText, pageNumber: 1, pageCount: totalPages }];
  }

  // Process per-page text results, merging small pages
  const chunks: PdfChunk[] = [];
  let pendingText = "";
  let pendingPageNumber = 1;

  for (const page of textResult.pages) {
    const pageText = page.text?.trim() || "";
    const currentPageNumber = page.num || 1;

    if (!pageText) {
      // Skip completely empty pages
      continue;
    }

    if (!pendingText) {
      pendingText = pageText;
      pendingPageNumber = currentPageNumber;
    } else {
      pendingText = pendingText + "\n\n" + pageText;
    }

    // If accumulated text is long enough, emit a chunk
    if (pendingText.length >= MIN_PAGE_CHARS) {
      chunks.push({
        text: pendingText,
        pageNumber: pendingPageNumber,
        pageCount: totalPages,
      });
      pendingText = "";
    }
  }

  // Flush any remaining text
  if (pendingText.trim()) {
    if (chunks.length > 0) {
      // Merge with the last chunk if it's too small
      const last = chunks[chunks.length - 1];
      last.text = last.text + "\n\n" + pendingText;
    } else {
      chunks.push({
        text: pendingText,
        pageNumber: pendingPageNumber,
        pageCount: totalPages,
      });
    }
  }

  // If per-page extraction yielded nothing, fall back to full text
  if (chunks.length === 0 && textResult.text?.trim()) {
    return [{ text: textResult.text.trim(), pageNumber: 1, pageCount: totalPages }];
  }

  return chunks;
}
