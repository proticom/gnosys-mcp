/**
 * Table atom — generic tabular layout for the v5.9.4 CLI vocabulary.
 *
 * Per `arch-004`: every tabular CLI screen reaches for `Table` first instead
 * of hand-rolling `padEnd` columns. Header row + thin divider + auto-fit
 * or fixed-width columns + optional per-row marker formatter (e.g. `▶` for
 * changed routing rows).
 *
 * The renderer measures printable width with ANSI stripped so coloured
 * cell contents don't break alignment. Cell `render(row)` returns the
 * RAW string; `color` is applied per-column for the cell value (header
 * is always `text-dim` per design §4).
 */
import { c, color, glyph } from "./tokens.js";
import { stripAnsi } from "./header.js";

export interface TableColumn<T> {
  /** Header label (always rendered in `text-dim`). */
  header: string;
  /** Optional fixed column width; otherwise auto-fits to widest cell + header. */
  width?: number;
  /** Cell alignment within its column. Default `left`. */
  align?: "left" | "right";
  /** Cell value extractor. Returns the RAW string — color is applied below. */
  render: (row: T) => string;
  /** Optional ANSI token for this column's cell values. Defaults to `c.text`. */
  color?: string;
}

export interface TableOptions<T> {
  /** Include the header row + divider. Default true. */
  showHeader?: boolean;
  /** Draw the thin `─` rule under the header. Default true. */
  dividerAfterHeader?: boolean;
  /** Spaces before each line. Default 1 (col 2 baseline per design). */
  indent?: number;
  /** Spaces between columns. Default 2. */
  gap?: number;
  /**
   * Optional row-level decorator. Receives the raw row and the fully built
   * line; returns the final line. Lets callers prepend per-row markers
   * (`▶ ` for changed rows, `✓ ` for completed) without bypassing the atom.
   */
  rowFormatter?: (row: T, line: string) => string;
}

/**
 * Render a table. Returns one string per line (header + divider + rows),
 * never trailing newline. Returns `[]` for an empty `rows` array unless
 * `showHeader` is true (in which case header + divider are still emitted).
 */
export function renderTable<T>(
  rows: T[],
  columns: TableColumn<T>[],
  opts: TableOptions<T> = {},
): string[] {
  if (columns.length === 0) return [];
  const showHeader = opts.showHeader !== false;
  const drawDivider = opts.dividerAfterHeader !== false;
  const indent = " ".repeat(opts.indent ?? 1);
  const gap = " ".repeat(opts.gap ?? 2);

  // Pre-compute raw cell values + per-column widths.
  const rawCells: string[][] = rows.map((row) => columns.map((col) => col.render(row)));
  const widths = columns.map((col, idx) => {
    if (typeof col.width === "number") return col.width;
    const headerLen = col.header.length;
    const maxCell = rawCells.reduce((max, cells) => {
      const len = stripAnsi(cells[idx] ?? "").length;
      return len > max ? len : max;
    }, 0);
    return Math.max(headerLen, maxCell);
  });

  const lines: string[] = [];

  if (showHeader) {
    const headerCells = columns.map((col, idx) =>
      color(c.textDim, padCell(col.header, widths[idx], col.align ?? "left")),
    );
    lines.push(`${indent}${headerCells.join(gap)}`);
    if (drawDivider) {
      const ruleWidth = widths.reduce((sum, w) => sum + w, 0) + gap.length * (columns.length - 1);
      lines.push(`${indent}${color(c.textGhost, glyph.ruleLight.repeat(Math.max(1, ruleWidth)))}`);
    }
  }

  rows.forEach((row, rowIdx) => {
    const cells = columns.map((col, colIdx) => {
      const raw = rawCells[rowIdx][colIdx];
      // Last left-aligned column doesn't need trailing pad — saves a row of
      // ghost whitespace per snapshot and matches the v5.9.3 hand-rolled output.
      const isLastCol = colIdx === columns.length - 1;
      const align = col.align ?? "left";
      const padded = isLastCol && align === "left"
        ? raw
        : padCell(raw, widths[colIdx], align);
      // Empty string opts out of column-level colouring — useful when the
      // cell's `render()` already emits its own ANSI (e.g. cost tiers).
      const cellColor = col.color === "" ? null : col.color ?? c.text;
      return cellColor ? color(cellColor, padded) : padded;
    });
    const line = `${indent}${cells.join(gap)}`;
    lines.push(opts.rowFormatter ? opts.rowFormatter(row, line) : line);
  });

  return lines;
}

/** Convenience: render + print + trailing newline. */
export function printTable<T>(
  rows: T[],
  columns: TableColumn<T>[],
  opts: TableOptions<T> = {},
): void {
  const lines = renderTable(rows, columns, opts);
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

/** Pad a cell value (which may contain ANSI) to a target printable width. */
function padCell(value: string, width: number, align: "left" | "right"): string {
  const bareLen = stripAnsi(value).length;
  const padLen = Math.max(0, width - bareLen);
  const pad = " ".repeat(padLen);
  return align === "right" ? `${pad}${value}` : `${value}${pad}`;
}
