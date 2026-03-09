/**
 * Gnosys Store — Core module for reading/writing atomic memory files.
 * The filesystem is the source of truth. All memories are markdown files
 * with YAML frontmatter organized in category directories.
 */

import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import { glob } from "glob";
import { execSync } from "child_process";

export interface MemoryFrontmatter {
  id: string;
  title: string;
  category: string;
  tags: Record<string, string[]> | string[];
  relevance: string;
  author: "human" | "ai" | "human+ai";
  authority: "declared" | "observed" | "imported" | "inferred";
  confidence: number;
  created: string;
  modified: string;
  last_reviewed?: string | null;
  status: "active" | "archived" | "superseded";
  supersedes?: string | null;
  superseded_by?: string | null;
  [key: string]: unknown;
}

export interface Memory {
  frontmatter: MemoryFrontmatter;
  content: string;
  filePath: string;
  relativePath: string;
}

export class GnosysStore {
  private storePath: string;
  private gitEnabled: boolean;

  constructor(storePath: string) {
    this.storePath = path.resolve(storePath);
    this.gitEnabled = false;
  }

  async init(): Promise<void> {
    // Ensure store directory exists
    await fs.mkdir(this.storePath, { recursive: true });
    await fs.mkdir(path.join(this.storePath, ".gnosys"), { recursive: true });

    // Init git if not already
    try {
      const gitDir = path.join(this.storePath, ".git");
      const stat = await fs.stat(gitDir).catch(() => null);
      if (!stat) {
        execSync("git init", { cwd: this.storePath, stdio: "pipe" });
      }
      this.gitEnabled = true;
    } catch {
      this.gitEnabled = false;
    }
  }

  /**
   * Read all memory files from the store.
   */
  async getAllMemories(): Promise<Memory[]> {
    const files = await glob("**/*.md", {
      cwd: this.storePath,
      ignore: ["MANIFEST.md", "CHANGELOG.md", ".gnosys/**", "node_modules/**"],
    });

    const memories: Memory[] = [];
    for (const file of files) {
      try {
        const memory = await this.readMemory(file);
        if (memory) memories.push(memory);
      } catch {
        // Skip files that can't be parsed
      }
    }
    return memories;
  }

  /**
   * Read a single memory by relative path.
   */
  async readMemory(relativePath: string): Promise<Memory | null> {
    const fullPath = path.join(this.storePath, relativePath);
    try {
      const raw = await fs.readFile(fullPath, "utf-8");
      const parsed = matter(raw);

      if (!parsed.data.id) return null; // Not a valid memory file

      return {
        frontmatter: parsed.data as MemoryFrontmatter,
        content: parsed.content.trim(),
        filePath: fullPath,
        relativePath,
      };
    } catch {
      return null;
    }
  }

  /**
   * Write a new memory to the store.
   */
  async writeMemory(
    category: string,
    filename: string,
    frontmatter: MemoryFrontmatter,
    content: string,
    options?: { autoCommit?: boolean }
  ): Promise<string> {
    const dir = path.join(this.storePath, category);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, filename);
    const relativePath = path.join(category, filename);

    const fileContent = matter.stringify(content, frontmatter);
    await fs.writeFile(filePath, fileContent, "utf-8");

    // Auto git commit (skip when batching)
    if (options?.autoCommit !== false) {
      await this.autoCommit(`Add memory: ${frontmatter.title}`);
    }

    return relativePath;
  }

  /**
   * Batch commit all pending changes (used after bulk imports).
   */
  async batchCommit(message: string): Promise<void> {
    await this.autoCommit(message);
  }

  /**
   * Update an existing memory.
   */
  async updateMemory(
    relativePath: string,
    updates: Partial<MemoryFrontmatter>,
    newContent?: string
  ): Promise<Memory | null> {
    const existing = await this.readMemory(relativePath);
    if (!existing) return null;

    const updatedFrontmatter = {
      ...existing.frontmatter,
      ...updates,
      modified: new Date().toISOString().split("T")[0],
    };
    const updatedContent = newContent ?? existing.content;

    const fullPath = path.join(this.storePath, relativePath);
    const fileContent = matter.stringify(updatedContent, updatedFrontmatter);
    await fs.writeFile(fullPath, fileContent, "utf-8");

    await this.autoCommit(`Update memory: ${updatedFrontmatter.title}`);

    return {
      frontmatter: updatedFrontmatter as MemoryFrontmatter,
      content: updatedContent,
      filePath: fullPath,
      relativePath,
    };
  }

  /**
   * List all categories (directories) in the store.
   */
  async getCategories(): Promise<string[]> {
    const entries = await fs.readdir(this.storePath, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          e.name !== "node_modules"
      )
      .map((e) => e.name)
      .sort();
  }

  /**
   * Generate a unique ID for a new memory.
   */
  async generateId(category: string): Promise<string> {
    const prefix = category.substring(0, 4);
    const memories = await this.getAllMemories();
    const existingIds = memories
      .map((m) => m.frontmatter.id)
      .filter((id) => id.startsWith(prefix));

    let maxNum = 0;
    for (const id of existingIds) {
      const match = id.match(/(\d+)$/);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1]));
    }
    return `${prefix}-${String(maxNum + 1).padStart(3, "0")}`;
  }

  /**
   * Get the store path.
   */
  getStorePath(): string {
    return this.storePath;
  }

  /**
   * Auto-commit changes to git (silent, never user-facing).
   */
  private async autoCommit(message: string): Promise<void> {
    if (!this.gitEnabled) return;
    try {
      execSync("git add -A", { cwd: this.storePath, stdio: "pipe" });
      execSync(`git commit -m "${message}" --allow-empty-message`, {
        cwd: this.storePath,
        stdio: "pipe",
      });
    } catch {
      // Git commit can fail if nothing changed — that's fine
    }
  }
}
