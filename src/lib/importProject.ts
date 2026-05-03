/**
 * Per-project bundle import — restores a .json.gz bundle produced by
 * exportProject.ts into the central DB. Three conflict strategies for
 * existing project IDs / memory IDs.
 */

import { gunzipSync } from "zlib";
import { readFileSync } from "fs";
import { GnosysDB, DbMemory, DbProject } from "./db.js";
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  ProjectBundle,
  PortableMemory,
} from "./exportProject.js";

export type ImportStrategy =
  /** Skip rows that already exist; insert new ones. Safe default. */
  | "merge"
  /** Replace existing project + its memories. Destructive — deletes target project's memories first. */
  | "replace"
  /** Generate a fresh project ID; suffix any colliding memory IDs with a short marker. */
  | "new-id";

export interface ImportProjectOptions {
  bundlePath: string;
  strategy?: ImportStrategy;
  /** Override the imported project's working_directory (e.g. when restoring on a different machine). */
  workingDirectoryOverride?: string;
}

export interface ImportProjectResult {
  projectId: string;             // The ID actually used (may differ from bundle if strategy = new-id)
  projectName: string;
  strategy: ImportStrategy;
  memoriesInserted: number;
  memoriesSkipped: number;       // strategy=merge: rows that already existed
  memoriesReplaced: number;      // strategy=replace: rows overwritten
  relationshipsInserted: number;
  auditEntriesInserted: number;
}

/** Read and validate a bundle file. Throws on malformed or unsupported version. */
export function readBundle(bundlePath: string): ProjectBundle {
  const compressed = readFileSync(bundlePath);
  const json = gunzipSync(compressed).toString("utf-8");
  const bundle = JSON.parse(json) as ProjectBundle;

  if (bundle?.manifest?.format !== BUNDLE_FORMAT) {
    throw new Error(
      `Not a Gnosys project bundle: format = ${bundle?.manifest?.format ?? "<missing>"}`,
    );
  }
  if (bundle.manifest.version !== BUNDLE_VERSION) {
    throw new Error(
      `Unsupported bundle version ${bundle.manifest.version} (expected ${BUNDLE_VERSION})`,
    );
  }
  return bundle;
}

function portableToDbMemory(p: PortableMemory): Omit<DbMemory, "embedding"> & { embedding?: Buffer | null } {
  const { embedding_b64, ...rest } = p;
  return {
    ...rest,
    embedding: embedding_b64 ? Buffer.from(embedding_b64, "base64") : null,
  };
}

/** Restore a bundle into the central DB. Returns counts and the final project ID. */
export function importProject(
  db: GnosysDB,
  opts: ImportProjectOptions,
): ImportProjectResult {
  const strategy: ImportStrategy = opts.strategy ?? "merge";
  const bundle = readBundle(opts.bundlePath);

  let project: DbProject = bundle.project;
  if (opts.workingDirectoryOverride) {
    project = { ...project, working_directory: opts.workingDirectoryOverride };
  }

  const existing = db.getProject(project.id);
  let projectId = project.id;
  let memoryIdRewrites = new Map<string, string>();
  let memoriesReplaced = 0;

  if (existing) {
    if (strategy === "replace") {
      // Delete all of the existing project's memories before re-inserting
      const existingMems = db.getMemoriesByProject(project.id, true);
      for (const mem of existingMems) {
        db.deleteMemory(mem.id);
        memoriesReplaced++;
      }
      db.insertProject(project);
    } else if (strategy === "new-id") {
      // Generate a fresh project id; remap memory project_ids during insert
      projectId = `${project.id}-imported-${Date.now().toString(36)}`;
      db.insertProject({ ...project, id: projectId });
    } else {
      // merge — keep existing project row; bundle memories get inserted under it
      // (no project upsert)
    }
  } else {
    db.insertProject({ ...project, id: projectId });
  }

  let memoriesInserted = 0;
  let memoriesSkipped = 0;

  for (const portable of bundle.memories) {
    const candidate = portableToDbMemory(portable);
    let id = candidate.id;

    if (strategy === "new-id" && projectId !== bundle.project.id) {
      id = `${candidate.id}-imp${Date.now().toString(36).slice(-4)}`;
      memoryIdRewrites.set(candidate.id, id);
    }

    const existingMem = db.getMemory(id);
    if (existingMem) {
      if (strategy === "merge") {
        memoriesSkipped++;
        continue;
      }
      if (strategy === "replace") {
        db.deleteMemory(id);
        memoriesReplaced++;
      }
    }

    const toInsert = {
      ...candidate,
      id,
      project_id: projectId,
    };
    db.insertMemory(toInsert);
    memoriesInserted++;
  }

  // Relationships — apply the same id rewrites if any
  let relationshipsInserted = 0;
  for (const rel of bundle.relationships) {
    const sourceId = memoryIdRewrites.get(rel.source_id) ?? rel.source_id;
    const targetId = memoryIdRewrites.get(rel.target_id) ?? rel.target_id;
    try {
      db.insertRelationship({
        ...rel,
        source_id: sourceId,
        target_id: targetId,
      });
      relationshipsInserted++;
    } catch {
      // Duplicate primary key (source, target, type) — skip silently in merge mode
    }
  }

  // Audit log — append-only restoration; no rewrites needed since audit
  // is keyed by autoincrement id which the DB regenerates.
  let auditEntriesInserted = 0;
  for (const entry of bundle.audit_log) {
    const memoryId = entry.memory_id ? (memoryIdRewrites.get(entry.memory_id) ?? entry.memory_id) : null;
    db.logAudit({
      timestamp: entry.timestamp,
      operation: entry.operation,
      memory_id: memoryId,
      details: entry.details,
      duration_ms: entry.duration_ms,
      trace_id: entry.trace_id,
    });
    auditEntriesInserted++;
  }

  return {
    projectId,
    projectName: project.name,
    strategy,
    memoriesInserted,
    memoriesSkipped,
    memoriesReplaced,
    relationshipsInserted,
    auditEntriesInserted,
  };
}
