/**
 * Gnosys PDF Extraction — Extract text from PDF files by section.
 *
 * Splits on content structure (headings, topic boundaries) rather than page
 * breaks. Page numbers are tracked as metadata so memories know which pages
 * they came from. This mirrors DOCX extraction behavior.
 *
 * Uses pdf-parse v2 (class-based API wrapping Mozilla's pdf.js) via dynamic
 * import so it stays optional and doesn't break builds that don't need it.
 */

import * as fs from "fs/promises";

// ─── Types ──────────────────────────────────────────────────────────────

export interface PdfChunk {
  /** Extracted text content for this section */
  text: string;
  /** Section heading if detected */
  sectionHeading?: string;
  /** Page range where this section appears, e.g. "3" or "3-5" */
  pages: string;
  /** Total number of pages in the PDF */
  pageCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Regex patterns that look like section headings in PDF text */
const HEADING_PATTERNS = [
  /^#{1,3}\s+.+$/m,                        // Markdown-style headings
  /^[A-Z][A-Z\s]{4,60}$/m,                 // ALL CAPS lines (common in PDFs)
  /^\d+\.\s+[A-Z].{3,80}$/m,              // Numbered sections: "1. Introduction"
  /^\d+\.\d+\s+[A-Z].{3,80}$/m,           // Sub-sections: "1.1 Overview"
  /^Chapter\s+\d+/im,                      // "Chapter 1"
  /^(?:Introduction|Conclusion|Summary|Abstract|References|Appendix|Background|Overview|Discussion|Methods|Results)\s*$/im,
];

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Extract text from a PDF file, splitting by sections/topics.
 *
 * First extracts all text with page tracking, then splits on detected
 * headings or structural boundaries. Each chunk includes the page range
 * where the content appears.
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

  // Build a list of text blocks with their page numbers
  const pageBlocks: Array<{ text: string; pageNum: number }> = [];

  if (textResult.pages && textResult.pages.length > 0) {
    for (const page of textResult.pages) {
      const pageText = page.text?.trim();
      if (pageText) {
        pageBlocks.push({ text: pageText, pageNum: page.num || 1 });
      }
    }
  } else if (textResult.text?.trim()) {
    // Fallback: no per-page data, treat as single page
    pageBlocks.push({ text: textResult.text.trim(), pageNum: 1 });
  }

  if (pageBlocks.length === 0) return [];

  // Combine all text with page markers for tracking
  const combinedText = pageBlocks.map((b) => b.text).join("\n\n");

  // Split into sections based on headings
  const sections = splitBySections(combinedText);

  // Map each section back to its page range
  const chunks: PdfChunk[] = [];
  let textOffset = 0;

  for (const section of sections) {
    // Find which pages this section spans
    const startOffset = combinedText.indexOf(section.text, textOffset);
    const endOffset = startOffset + section.text.length;
    textOffset = startOffset >= 0 ? startOffset : textOffset;

    const startPage = findPageForOffset(pageBlocks, combinedText, startOffset);
    const endPage = findPageForOffset(pageBlocks, combinedText, endOffset);
    const pages = startPage === endPage ? `${startPage}` : `${startPage}-${endPage}`;

    chunks.push({
      text: section.text,
      sectionHeading: section.heading,
      pages,
      pageCount: totalPages,
    });
  }

  return chunks;
}

// ─── Internal Helpers ───────────────────────────────────────────────────

interface Section {
  heading?: string;
  text: string;
}

/**
 * Split text into sections based on detected headings.
 * If no headings are found, splits on double-newline paragraph boundaries
 * and groups into ~1500 character chunks.
 */
function splitBySections(text: string): Section[] {
  // Try to find heading boundaries
  const headingIndices: Array<{ index: number; heading: string }> = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 100) continue;

    for (const pattern of HEADING_PATTERNS) {
      if (pattern.test(trimmed)) {
        const idx = text.indexOf(line);
        if (idx >= 0) {
          headingIndices.push({ index: idx, heading: trimmed });
        }
        break;
      }
    }
  }

  // Deduplicate headings that point to the same location
  const uniqueHeadings = headingIndices.filter(
    (h, i) => i === 0 || h.index !== headingIndices[i - 1].index
  );

  if (uniqueHeadings.length >= 2) {
    // Split at heading boundaries
    const sections: Section[] = [];

    // Text before first heading (if any)
    const preHeadingText = text.slice(0, uniqueHeadings[0].index).trim();
    if (preHeadingText) {
      sections.push({ text: preHeadingText });
    }

    for (let i = 0; i < uniqueHeadings.length; i++) {
      const start = uniqueHeadings[i].index;
      const end = i + 1 < uniqueHeadings.length ? uniqueHeadings[i + 1].index : text.length;
      const sectionText = text.slice(start, end).trim();
      if (sectionText) {
        sections.push({ heading: uniqueHeadings[i].heading, text: sectionText });
      }
    }

    return sections;
  }

  // No headings found — split on paragraph boundaries and group
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length <= 1) {
    return [{ text: text.trim() }];
  }

  const TARGET_SIZE = 1500;
  const sections: Section[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && current.length + para.length > TARGET_SIZE) {
      sections.push({ text: current.trim() });
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim()) {
    sections.push({ text: current.trim() });
  }

  return sections;
}

/**
 * Find which page a given character offset falls on.
 */
function findPageForOffset(
  pageBlocks: Array<{ text: string; pageNum: number }>,
  combinedText: string,
  offset: number
): number {
  let currentOffset = 0;
  for (const block of pageBlocks) {
    const blockEnd = currentOffset + block.text.length + 2; // +2 for \n\n separator
    if (offset <= blockEnd) return block.pageNum;
    currentOffset = blockEnd;
  }
  return pageBlocks[pageBlocks.length - 1]?.pageNum || 1;
}
