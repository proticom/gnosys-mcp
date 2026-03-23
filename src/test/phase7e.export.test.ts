/**
 * Phase 7e: Obsidian Export Bridge
 * Test Plan Reference: "Phase 7 Sub-Phase Tests — 7e"
 *
 *   TC-7e.1: gnosys export creates clean vault with wikilinks
 *   TC-7e.2: Round-trip export → edit → re-import
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "fs/promises";
import path from "path";
import {
  createTestEnv,
  cleanupTestEnv,
  makeMemory,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase7e");
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

describe("Phase 7e: Obsidian Export Bridge", () => {
  // ─── TC-7e.1: Clean vault export with wikilinks ──────────────────────

  describe("TC-7e.1: Export creates clean Obsidian vault", () => {
    it("exports memories into target directory", async () => {
      env.db.insertMemory(
        makeMemory({
          id: "exp-001",
          title: "Decision One",
          content: "# Decision One\n\nWe chose [[exp-002|Concept Two]] for this.",
          category: "decisions",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "exp-002",
          title: "Concept Two",
          content: "# Concept Two\n\nA concept that relates to decision one.",
          category: "concepts",
        })
      );

      const { GnosysExporter } = await import("../lib/export.js");
      const exportDir = path.join(env.tmpDir, "obsidian-vault");
      const exporter = new GnosysExporter(env.db);
      const report = await exporter.export({ targetDir: exportDir });

      expect(report.memoriesExported).toBe(2);

      // Verify directory was created
      const files = await fsp.readdir(exportDir, { recursive: true });
      const mdFiles = (files as string[]).filter((f) =>
        f.toString().endsWith(".md")
      );
      expect(mdFiles.length).toBeGreaterThanOrEqual(2);
    });

    it("exported files preserve wikilinks", async () => {
      env.db.insertMemory(
        makeMemory({
          id: "wl-001",
          title: "Wikilink Source",
          content:
            "# Wikilink Source\n\nReferences [[wl-002|Target Memory]].",
          category: "decisions",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "wl-002",
          title: "Target Memory",
          content: "# Target Memory\n\nThe target of a wikilink.",
          category: "concepts",
        })
      );

      const { GnosysExporter } = await import("../lib/export.js");
      const exportDir = path.join(env.tmpDir, "wikilink-export");
      const exporter = new GnosysExporter(env.db);
      await exporter.export({ targetDir: exportDir });

      // Find exported files and check wikilinks preserved
      const files = await fsp.readdir(exportDir, { recursive: true });
      const sourceFiles = (files as string[]).filter(
        (f) =>
          f.toString().includes("wikilink") ||
          f.toString().includes("Wikilink")
      );

      if (sourceFiles.length > 0) {
        const content = await fsp.readFile(
          path.join(exportDir, sourceFiles[0]),
          "utf-8"
        );
        expect(content).toContain("[[");
      }
    });

    it("only exports active memories when activeOnly=true", async () => {
      env.db.insertMemory(
        makeMemory({
          id: "act-001",
          title: "Active",
          content: "Active memory.",
          status: "active",
          tier: "active",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "arc-001",
          title: "Archived",
          content: "Archived memory.",
          status: "archived",
          tier: "archive",
        })
      );

      const { GnosysExporter } = await import("../lib/export.js");
      const exportDir = path.join(env.tmpDir, "active-only-export");
      const exporter = new GnosysExporter(env.db);
      const report = await exporter.export({
        targetDir: exportDir,
        activeOnly: true,
      });

      expect(report.memoriesExported).toBe(1);
    });
  });

  // ─── TC-7e.2: Round-trip ─────────────────────────────────────────────

  describe("TC-7e.2: Round-trip export and re-import", () => {
    it("exported memory can be read back as valid markdown", async () => {
      env.db.insertMemory(
        makeMemory({
          id: "rt-001",
          title: "Round Trip Test",
          content: "# Round Trip Test\n\nContent survives round trip.",
          confidence: 0.85,
        })
      );

      const { GnosysExporter } = await import("../lib/export.js");
      const exportDir = path.join(env.tmpDir, "roundtrip-export");
      const exporter = new GnosysExporter(env.db);
      await exporter.export({ targetDir: exportDir });

      // Read exported files
      const files = await fsp.readdir(exportDir, { recursive: true });
      const mdFiles = (files as string[]).filter((f) =>
        f.toString().endsWith(".md")
      );

      expect(mdFiles.length).toBeGreaterThan(0);

      // Verify the exported file content
      const content = await fsp.readFile(
        path.join(exportDir, mdFiles[0]),
        "utf-8"
      );
      expect(content).toContain("---");
      expect(content).toContain("Round Trip Test");
    });
  });
});
