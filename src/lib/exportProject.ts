/**
 * Per-project bundle export — packs a single project's memories, relationships,
 * audit log, and metadata into a portable .json.gz file. Lossless round-trip
 * with importProject.ts. Format version 1.
 */

import { gzipSync } from "zlib";
import { writeFileSync } from "fs";
import { hostname, userInfo } from "os";
import { GnosysDB, DbMemory, DbProject, DbRelationship, DbAuditEntry } from "./db.js";
import { readFileSync as readPkg } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

export const BUNDLE_FORMAT = "gnosys-project-bundle";
export const BUNDLE_VERSION = 1;

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: number;
  created: string;
  source_machine: string;
  source_user: string;
  gnosys_version: string;
}

/** A memory row with its embedding base64-encoded for JSON transport. */
export interface PortableMemory extends Omit<DbMemory, "embedding"> {
  embedding_b64: string | null;
}

export interface ProjectBundle {
  manifest: BundleManifest;
  project: DbProject;
  memories: PortableMemory[];
  relationships: DbRelationship[];
  audit_log: DbAuditEntry[];
}

export interface ExportProjectOptions {
  /** Project ID to export. */
  projectId: string;
  /** Output path for the .json.gz file. */
  outputPath: string;
  /** Include archived/superseded memories too (default: only active). */
  includeArchived?: boolean;
  /** Include audit log entries (default: true). */
  includeAudit?: boolean;
}

export interface ExportProjectResult {
  outputPath: string;
  memoryCount: number;
  archivedExcluded: number;
  relationshipCount: number;
  auditEntryCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
}

function getGnosysVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readPkg(join(here, "..", "..", "package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

/**
 * Export a single project to a .json.gz bundle.
 * Bundle is fully self-contained — embeddings are base64-encoded inline.
 */
export function exportProject(
  db: GnosysDB,
  opts: ExportProjectOptions,
): ExportProjectResult {
  const project = db.getProject(opts.projectId);
  if (!project) {
    throw new Error(`Project not found: ${opts.projectId}`);
  }

  const rawMemories = db.getMemoriesByProject(opts.projectId, !!opts.includeArchived);
  const totalIncludingArchived = db.getMemoriesByProject(opts.projectId, true).length;
  const archivedExcluded = opts.includeArchived ? 0 : totalIncludingArchived - rawMemories.length;

  const memories: PortableMemory[] = rawMemories.map((m) => {
    const { embedding: _embedding, ...rest } = m;
    return {
      ...rest,
      embedding_b64: m.embedding ? Buffer.from(m.embedding).toString("base64") : null,
    };
  });

  const memoryIds = rawMemories.map((m) => m.id);
  const relationships = db.getRelationshipsForMemoryIds(memoryIds);
  const audit_log: DbAuditEntry[] = opts.includeAudit !== false
    ? db.getAuditEntriesByProject(opts.projectId)
    : [];

  const bundle: ProjectBundle = {
    manifest: {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      created: new Date().toISOString(),
      source_machine: hostname(),
      source_user: userInfo().username,
      gnosys_version: getGnosysVersion(),
    },
    project,
    memories,
    relationships,
    audit_log,
  };

  const json = JSON.stringify(bundle);
  const compressed = gzipSync(Buffer.from(json, "utf-8"));
  writeFileSync(opts.outputPath, compressed);

  return {
    outputPath: opts.outputPath,
    memoryCount: memories.length,
    archivedExcluded,
    relationshipCount: relationships.length,
    auditEntryCount: audit_log.length,
    uncompressedBytes: Buffer.byteLength(json, "utf-8"),
    compressedBytes: compressed.length,
  };
}
