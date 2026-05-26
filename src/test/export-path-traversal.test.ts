/**
 * Export path traversal — category slugify + assertWithin guard.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GnosysDB } from "../lib/db.js";
import { GnosysExporter } from "../lib/export.js";

function makeDb(): { db: GnosysDB; tmp: string } {
  const tmp = mkdtempSync(join(tmpdir(), "gnosys-export-traversal-"));
  const db = new GnosysDB(tmp);
  return { db, tmp };
}

function insertMemory(
  db: GnosysDB,
  opts: { id: string; title: string; category: string },
): void {
  const now = new Date().toISOString();
  db.insertMemory({
    id: opts.id,
    title: opts.title,
    category: opts.category,
    content: "Traversal test content",
    summary: null,
    tags: "[]",
    relevance: "test",
    author: "ai",
    authority: "imported",
    confidence: 0.8,
    reinforcement_count: 0,
    content_hash: `hash-${opts.id}`,
    status: "active",
    tier: "active",
    supersedes: null,
    superseded_by: null,
    last_reinforced: null,
    created: now,
    modified: now,
    embedding: null,
    source_path: null,
    source_file: null,
    source_page: null,
    source_timerange: null,
    project_id: null,
    scope: "global",
  });
}

describe("export path traversal", () => {
  let workspace: { db: GnosysDB; tmp: string };

  beforeEach(() => {
    workspace = makeDb();
  });

  afterEach(() => {
    workspace.db.close();
    rmSync(workspace.tmp, { recursive: true, force: true });
  });

  it("slugifies traversal category and writes inside export dir", async () => {
    insertMemory(workspace.db, {
      id: "mem-escape",
      title: "Escape attempt",
      category: "../../escape",
    });

    const exportDir = join(workspace.tmp, "vault");
    const exporter = new GnosysExporter(workspace.db);
    const report = await exporter.export({
      targetDir: exportDir,
      includeSummaries: false,
      includeReviews: false,
      includeGraph: false,
      overwrite: true,
    });

    expect(report.memoriesExported).toBe(1);
    expect(report.errors).toHaveLength(0);

    const expectedFile = join(exportDir, "escape", "escape-attempt.md");
    expect(existsSync(expectedFile)).toBe(true);

    // Nothing written outside the export root
    const siblingEscape = join(workspace.tmp, "escape");
    expect(existsSync(siblingEscape)).toBe(false);
    expect(readdirSync(exportDir)).toContain("escape");
  });

  it("assertWithin allows paths inside target and blocks outside", () => {
    const exporter = Object.create(GnosysExporter.prototype) as {
      slugify(text: string): string;
      assertWithin(targetDir: string, filePath: string): void;
    };

    expect(exporter.slugify("../../evil")).toBe("evil");

    expect(() =>
      exporter.assertWithin("/tmp/vault", "/tmp/vault/decisions/x.md"),
    ).not.toThrow();

    expect(() =>
      exporter.assertWithin("/tmp/vault", "/tmp/evil/x.md"),
    ).toThrow(/Refusing to write outside export dir/);
  });
});
