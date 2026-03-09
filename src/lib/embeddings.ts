/**
 * Gnosys Embeddings — Lazy-loaded semantic embedding engine.
 * Uses @xenova/transformers (ONNX, pure Node) with all-MiniLM-L6-v2.
 * Model (~80 MB) is downloaded only on first use and cached.
 * Embeddings are stored in SQLite as regeneratable sidecar data.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs/promises";

// Type for the pipeline function from @xenova/transformers
type Pipeline = (texts: string[], options?: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

export class GnosysEmbeddings {
  private pipeline: Pipeline | null = null;
  private db: Database.Database | null = null;
  private storePath: string;
  private modelReady = false;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  /**
   * Lazily initialize the embedding model. Downloads on first use (~80 MB).
   * Cached in ~/.cache/gnosys or GNOSYS_CACHE_DIR.
   */
  async init(): Promise<void> {
    if (this.modelReady) return;

    // Set cache directory before importing transformers
    const cacheDir =
      process.env.GNOSYS_CACHE_DIR ||
      path.join(
        process.env.HOME || process.env.USERPROFILE || "/tmp",
        ".cache",
        "gnosys"
      );
    await fs.mkdir(cacheDir, { recursive: true });
    process.env.TRANSFORMERS_CACHE = cacheDir;

    // Dynamic import — keeps @xenova/transformers out of the main bundle
    const { pipeline } = await import("@xenova/transformers");
    this.pipeline = (await pipeline("feature-extraction", MODEL_NAME, {
      quantized: true,
    })) as unknown as Pipeline;

    this.modelReady = true;
  }

  /**
   * Open (or create) the embeddings SQLite table.
   * Stored in the same .config/search.db used by FTS5 search,
   * or a separate embeddings.db if search.db isn't writable.
   */
  openDb(): Database.Database {
    if (this.db) return this.db;

    const dbPath = path.join(this.storePath, ".config", "embeddings.db");
    try {
      this.db = new Database(dbPath);
    } catch {
      // Fallback to in-memory
      this.db = new Database(":memory:");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        file_path TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    return this.db;
  }

  /**
   * Embed a single text string. Returns a Float32Array of dimension 384.
   */
  async embed(text: string): Promise<Float32Array> {
    await this.init();
    if (!this.pipeline) throw new Error("Embedding model not initialized");

    const output = await this.pipeline([text], { pooling: "mean", normalize: true });
    const nested = output.tolist();
    return new Float32Array(nested[0]);
  }

  /**
   * Embed multiple texts in a batch.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();
    if (!this.pipeline) throw new Error("Embedding model not initialized");

    const results: Float32Array[] = [];
    // Process in batches of 32 to manage memory
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const output = await this.pipeline(batch, { pooling: "mean", normalize: true });
      const nested = output.tolist();
      for (const vec of nested) {
        results.push(new Float32Array(vec));
      }
    }
    return results;
  }

  /**
   * Store an embedding in SQLite.
   */
  storeEmbedding(filePath: string, embedding: Float32Array, contentHash: string): void {
    const db = this.openDb();
    const buffer = Buffer.from(embedding.buffer);
    db.prepare(
      "INSERT OR REPLACE INTO embeddings (file_path, embedding, content_hash, updated_at) VALUES (?, ?, ?, ?)"
    ).run(filePath, buffer, contentHash, new Date().toISOString());
  }

  /**
   * Get a stored embedding by file path.
   */
  getEmbedding(filePath: string): Float32Array | null {
    const db = this.openDb();
    const row = db.prepare("SELECT embedding FROM embeddings WHERE file_path = ?").get(filePath) as
      | { embedding: Buffer }
      | undefined;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }

  /**
   * Get all stored embeddings.
   */
  getAllEmbeddings(): { filePath: string; embedding: Float32Array; contentHash: string }[] {
    const db = this.openDb();
    const rows = db.prepare("SELECT file_path, embedding, content_hash FROM embeddings").all() as {
      file_path: string;
      embedding: Buffer;
      content_hash: string;
    }[];

    return rows.map((r) => ({
      filePath: r.file_path,
      embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      contentHash: r.content_hash,
    }));
  }

  /**
   * Check if an embedding exists and is up to date.
   */
  isUpToDate(filePath: string, contentHash: string): boolean {
    const db = this.openDb();
    const row = db.prepare("SELECT content_hash FROM embeddings WHERE file_path = ?").get(filePath) as
      | { content_hash: string }
      | undefined;
    return row?.content_hash === contentHash;
  }

  /**
   * Count stored embeddings.
   */
  count(): number {
    const db = this.openDb();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Check if embeddings exist (without loading the model).
   */
  hasEmbeddings(): boolean {
    try {
      return this.count() > 0;
    } catch {
      return false;
    }
  }

  /**
   * Clear all embeddings.
   */
  clear(): void {
    const db = this.openDb();
    db.exec("DELETE FROM embeddings");
  }

  /**
   * Cosine similarity between two vectors.
   * Assumes both are normalized (which all-MiniLM-L6-v2 with normalize=true gives us).
   */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  /**
   * Simple content hash for change detection.
   */
  static contentHash(content: string): string {
    // Simple FNV-1a hash — fast, good enough for change detection
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(36);
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    this.db = null;
  }
}

export { EMBEDDING_DIM };
