/**
 * Gnosys Tag Registry — Categorized controlled vocabulary for tags.
 * Stored in .config/tags.json. The ingestion LLM must use existing tags
 * but can propose new ones for approval.
 */

import fs from "fs/promises";
import path from "path";

export interface TagRegistry {
  domain: string[];
  type: string[];
  concern: string[];
  status_tag: string[];
  [category: string]: string[];
}

const DEFAULT_REGISTRY: TagRegistry = {
  domain: [
    "auth",
    "database",
    "frontend",
    "backend",
    "deployment",
    "api",
    "cli",
    "mcp",
    "wiki",
    "obsidian",
    "architecture",
    "retrieval",
    "search",
    "ingestion",
    "memory",
    "lensing",
    "decay",
    "reinforcement",
    "contradiction",
    "tags",
    "git",
    "typescript",
    "tooling",
    "roadmap",
    "scope",
  ],
  type: [
    "decision",
    "convention",
    "architecture",
    "concept",
    "requirement",
    "landscape",
    "open-question",
  ],
  concern: [
    "security",
    "performance",
    "scalability",
    "dx",
    "adoption",
    "community",
    "portability",
  ],
  status_tag: ["core", "experimental", "deprecated", "phased"],
};

export class GnosysTagRegistry {
  private registryPath: string;
  private registry: TagRegistry;

  constructor(storePath: string) {
    this.registryPath = path.join(storePath, ".config", "tags.json");
    this.registry = { ...DEFAULT_REGISTRY };
  }

  async load(): Promise<TagRegistry> {
    try {
      const raw = await fs.readFile(this.registryPath, "utf-8");
      this.registry = JSON.parse(raw) as TagRegistry;
    } catch {
      // File doesn't exist yet — use defaults and create it
      await this.save();
    }
    return this.registry;
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.registryPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.registryPath,
      JSON.stringify(this.registry, null, 2),
      "utf-8"
    );
  }

  getRegistry(): TagRegistry {
    return this.registry;
  }

  getAllTags(): string[] {
    return [...new Set(Object.values(this.registry).flat())].sort();
  }

  getTagsByCategory(category: string): string[] {
    return this.registry[category] || [];
  }

  hasTag(tag: string): boolean {
    return Object.values(this.registry).some((tags) => tags.includes(tag));
  }

  findTagCategory(tag: string): string | null {
    for (const [category, tags] of Object.entries(this.registry)) {
      if (tags.includes(tag)) return category;
    }
    return null;
  }

  async addTag(category: string, tag: string): Promise<boolean> {
    if (!this.registry[category]) {
      this.registry[category] = [];
    }
    if (this.registry[category].includes(tag)) return false;
    this.registry[category].push(tag);
    await this.save();
    return true;
  }
}
