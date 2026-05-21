/**
 * Snapshot tests for the v5.9.4 Table atom (arch-004).
 *
 * Pins terminal width to 80 cols and strips ANSI before snapshotting so
 * the fixtures remain stable across terminals and stay human-diffable.
 */

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

async function load() {
  return await import("../lib/setup/ui/index.js");
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

interface ProviderRow {
  name: string;
  model: string;
  cost: string;
}

const sampleRows: ProviderRow[] = [
  { name: "anthropic", model: "claude-sonnet-4-6", cost: "$$" },
  { name: "openai", model: "gpt-5.4-mini", cost: "$" },
  { name: "xai", model: "grok-4.3", cost: "$$" },
];

describe("setup/ui Table atom — Phase A", () => {
  it("renders header + divider + rows (auto-fit widths)", async () => {
    const { renderTable } = await load();
    const out = renderTable(sampleRows, [
      { header: "provider", render: (r) => r.name },
      { header: "model", render: (r) => r.model },
      { header: "cost", render: (r) => r.cost },
    ]);
    expect(out.map(strip).join("\n")).toMatchSnapshot();
  });

  it("omits header when showHeader is false", async () => {
    const { renderTable } = await load();
    const out = renderTable(sampleRows, [
      { header: "provider", render: (r) => r.name },
      { header: "model", render: (r) => r.model },
    ], { showHeader: false });
    expect(out.map(strip).join("\n")).toMatchSnapshot();
  });

  it("renders header without divider when dividerAfterHeader is false", async () => {
    const { renderTable } = await load();
    const out = renderTable(sampleRows, [
      { header: "provider", render: (r) => r.name },
      { header: "cost", render: (r) => r.cost },
    ], { dividerAfterHeader: false });
    expect(out.map(strip).join("\n")).toMatchSnapshot();
  });

  it("supports fixed column widths", async () => {
    const { renderTable } = await load();
    const out = renderTable(sampleRows, [
      { header: "provider", width: 14, render: (r) => r.name },
      { header: "model", width: 26, render: (r) => r.model },
      { header: "cost", width: 6, align: "right", render: (r) => r.cost },
    ]);
    expect(out.map(strip).join("\n")).toMatchSnapshot();
  });

  it("supports right-aligned columns", async () => {
    const { renderTable } = await load();
    const out = renderTable(sampleRows, [
      { header: "provider", render: (r) => r.name },
      { header: "cost", align: "right", render: (r) => r.cost },
    ]);
    expect(out.map(strip).join("\n")).toMatchSnapshot();
  });

  it("handles empty row arrays (header still emitted)", async () => {
    const { renderTable } = await load();
    const out = renderTable<ProviderRow>([], [
      { header: "provider", render: (r) => r.name },
      { header: "cost", render: (r) => r.cost },
    ]);
    expect(out.map(strip).join("\n")).toMatchSnapshot();
  });

  it("handles empty row arrays with showHeader=false (returns no lines)", async () => {
    const { renderTable } = await load();
    const out = renderTable<ProviderRow>([], [
      { header: "provider", render: (r) => r.name },
    ], { showHeader: false });
    expect(out).toEqual([]);
  });

  it("respects custom indent + gap", async () => {
    const { renderTable } = await load();
    const out = renderTable(sampleRows, [
      { header: "provider", render: (r) => r.name },
      { header: "cost", render: (r) => r.cost },
    ], { indent: 3, gap: 4 });
    expect(out.map(strip).join("\n")).toMatchSnapshot();
  });

  it("preserves coloured cell content while padding to printable width", async () => {
    const { renderTable, c, color: paint } = await load();
    const rows = [
      { task: "synthesis", uses: paint(c.accentHi, "anthropic / sonnet") },
      { task: "vision", uses: paint(c.text, "openai / gpt-5.4") },
    ];
    const out = renderTable(rows, [
      { header: "task", render: (r) => r.task },
      { header: "uses", render: (r) => r.uses },
    ]);
    // After stripping ANSI, column alignment must still be byte-identical.
    expect(out.map(strip).join("\n")).toMatchSnapshot();
  });

  it("invokes rowFormatter for per-row markers", async () => {
    const { renderTable } = await load();
    const rows: { task: string; changed: boolean }[] = [
      { task: "synthesis", changed: true },
      { task: "vision", changed: false },
    ];
    const out = renderTable(rows, [
      { header: "task", render: (r) => r.task },
    ], {
      rowFormatter: (row, line) => (row.changed ? `> ${line}` : `  ${line}`),
    });
    expect(out.map(strip).join("\n")).toMatchSnapshot();
  });

  it("returns [] when columns is empty", async () => {
    const { renderTable } = await load();
    expect(renderTable(sampleRows, [])).toEqual([]);
  });
});
