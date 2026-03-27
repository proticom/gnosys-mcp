/**
 * Gnosys Attachments — File attachment management for multimodal ingestion.
 *
 * Stores binary files in .gnosys/attachments/<uuid>.<ext> with a JSON manifest
 * at .gnosys/attachments/attachments.json for tracking metadata and memory links.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

// ─── Types ──────────────────────────────────────────────────────────────

export interface AttachmentRecord {
  uuid: string;
  originalName: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  createdAt: string;
  memoryIds: string[];
}

interface AttachmentManifest {
  attachments: AttachmentRecord[];
}

// ─── MIME type lookup from extension ────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  // Documents
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  // Video
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  webm: "video/webm",
};

function mimeFromExtension(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] || "application/octet-stream";
}

// ─── Helpers ────────────────────────────────────────────────────────────

function getAttachmentsDir(storePath: string): string {
  return path.join(storePath, "attachments");
}

function getManifestPath(storePath: string): string {
  return path.join(getAttachmentsDir(storePath), "attachments.json");
}

async function readManifest(storePath: string): Promise<AttachmentManifest> {
  const manifestPath = getManifestPath(storePath);
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as AttachmentManifest;
  } catch {
    return { attachments: [] };
  }
}

async function writeManifest(storePath: string, manifest: AttachmentManifest): Promise<void> {
  const manifestPath = getManifestPath(storePath);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/**
 * Compute SHA-256 hash of a file's contents.
 */
async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Initialize the attachments directory and manifest in a store.
 * Safe to call multiple times — creates only if missing.
 */
export async function initAttachments(storePath: string): Promise<void> {
  const dir = getAttachmentsDir(storePath);
  await fs.mkdir(dir, { recursive: true });

  const manifestPath = getManifestPath(storePath);
  try {
    await fs.access(manifestPath);
  } catch {
    // Manifest doesn't exist — create empty one
    await writeManifest(storePath, { attachments: [] });
  }
}

/**
 * Copy a file into .gnosys/attachments/<uuid>.<ext> and register it in the manifest.
 * Returns the attachment record with metadata.
 *
 * If a file with the same content hash already exists, returns the existing record
 * instead of creating a duplicate.
 */
export async function storeAttachment(
  storePath: string,
  filePath: string
): Promise<AttachmentRecord> {
  // Make sure attachments dir exists
  await initAttachments(storePath);

  // Get file info
  const stat = await fs.stat(filePath);
  const originalName = path.basename(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase() || "bin";
  const contentHash = await hashFile(filePath);

  // Check for duplicate by content hash
  const manifest = await readManifest(storePath);
  const existing = manifest.attachments.find((a) => a.contentHash === contentHash);
  if (existing) {
    return existing;
  }

  // Generate UUID and copy file
  const uuid = crypto.randomUUID();
  const destPath = path.join(getAttachmentsDir(storePath), `${uuid}.${ext}`);
  await fs.copyFile(filePath, destPath);

  // Create record
  const record: AttachmentRecord = {
    uuid,
    originalName,
    extension: ext,
    mimeType: mimeFromExtension(ext),
    sizeBytes: stat.size,
    contentHash,
    createdAt: new Date().toISOString(),
    memoryIds: [],
  };

  // Update manifest
  manifest.attachments.push(record);
  await writeManifest(storePath, manifest);

  return record;
}

/**
 * Read and return all attachment records from the manifest.
 */
export async function listAttachments(storePath: string): Promise<AttachmentRecord[]> {
  const manifest = await readManifest(storePath);
  return manifest.attachments;
}

/**
 * Get the full filesystem path for an attachment.
 */
export function getAttachmentPath(storePath: string, uuid: string, ext: string): string {
  return path.join(getAttachmentsDir(storePath), `${uuid}.${ext}`);
}

/**
 * Link a memory ID to an attachment. Updates the manifest so the attachment
 * tracks which memories reference it.
 */
export async function linkMemoryToAttachment(
  storePath: string,
  uuid: string,
  memoryId: string
): Promise<void> {
  const manifest = await readManifest(storePath);
  const record = manifest.attachments.find((a) => a.uuid === uuid);
  if (!record) {
    throw new Error(`Attachment not found: ${uuid}`);
  }

  if (!record.memoryIds.includes(memoryId)) {
    record.memoryIds.push(memoryId);
    await writeManifest(storePath, manifest);
  }
}
