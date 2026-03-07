/**
 * Gnosys Store Resolver — Discovers and manages layered stores.
 *
 * Four layers, resolved in specificity order:
 *   Project  (auto-discovered from cwd, writable, default write target)
 *   Optional (GNOSYS_STORES, read-only)
 *   Personal (GNOSYS_PERSONAL, writable, fallback write target)
 *   Global   (GNOSYS_GLOBAL, writable only when explicitly targeted)
 */

import fs from "fs/promises";
import path from "path";
import { GnosysStore, Memory } from "./store.js";

export type StoreLayer = "project" | "personal" | "global" | "optional";

export interface ResolvedStore {
  layer: StoreLayer;
  label: string;
  store: GnosysStore;
  writable: boolean;
  path: string;
}

export interface LayeredMemory extends Memory {
  sourceLayer: StoreLayer;
  sourceLabel: string;
}

export class GnosysResolver {
  private stores: ResolvedStore[] = [];

  /**
   * Discover and initialize all store layers.
   */
  async resolve(): Promise<ResolvedStore[]> {
    this.stores = [];

    // 1. Project store — check registered projects first, then walk up from cwd.
    //    Registered projects are saved in ~/.config/gnosys/projects.json by gnosys_init.
    //    This is more reliable than cwd because MCP servers may be spawned
    //    with cwd set to the user's home directory rather than the open project.
    const projectPath = await this.findProjectStore();
    if (projectPath) {
      const store = new GnosysStore(projectPath);
      await store.init();
      this.stores.push({
        layer: "project",
        label: "project",
        store,
        writable: true,
        path: projectPath,
      });
    }

    // 2. Optional stores (GNOSYS_STORES — colon-separated)
    const optionalPaths = process.env.GNOSYS_STORES;
    if (optionalPaths) {
      const paths = optionalPaths.split(":").filter(Boolean);
      for (let i = 0; i < paths.length; i++) {
        const p = path.resolve(paths[i]);
        if (await this.isValidStore(p)) {
          const store = new GnosysStore(p);
          await store.init();
          const dirName = path.basename(path.dirname(p)) || path.basename(p);
          this.stores.push({
            layer: "optional",
            label: `optional:${dirName}`,
            store,
            writable: false,
            path: p,
          });
        }
      }
    }

    // 3. Personal store (GNOSYS_PERSONAL)
    const personalPath = process.env.GNOSYS_PERSONAL;
    if (personalPath) {
      const p = path.resolve(personalPath);
      const store = new GnosysStore(p);
      await store.init();
      this.stores.push({
        layer: "personal",
        label: "personal",
        store,
        writable: true,
        path: p,
      });
    }

    // 4. Global store (GNOSYS_GLOBAL)
    //    Writable, but only when explicitly targeted — never auto-selected.
    const globalPath = process.env.GNOSYS_GLOBAL;
    if (globalPath) {
      const p = path.resolve(globalPath);
      if (await this.isValidStore(p)) {
        const store = new GnosysStore(p);
        await store.init();
        this.stores.push({
          layer: "global",
          label: "global",
          store,
          writable: true,
          path: p,
        });
      }
    }

    return this.stores;
  }

  /**
   * Get all stores in precedence order.
   */
  getStores(): ResolvedStore[] {
    return this.stores;
  }

  /**
   * Get all memories across all stores, tagged with their source.
   */
  async getAllMemories(): Promise<LayeredMemory[]> {
    const allMemories: LayeredMemory[] = [];

    for (const resolved of this.stores) {
      const memories = await resolved.store.getAllMemories();
      for (const m of memories) {
        allMemories.push({
          ...m,
          sourceLayer: resolved.layer,
          sourceLabel: resolved.label,
        });
      }
    }

    return allMemories;
  }

  /**
   * Read a memory, searching stores in precedence order.
   * Path format: "layer:category/filename.md" or just "category/filename.md" (searches all).
   */
  async readMemory(memPath: string): Promise<LayeredMemory | null> {
    // Check if path includes a layer prefix
    const layerMatch = memPath.match(/^(project|personal|global|optional(?::[^:]+)?):(.+)/);

    if (layerMatch) {
      const targetLabel = layerMatch[1];
      const filePath = layerMatch[2];
      const resolved = this.stores.find((s) => s.label === targetLabel || s.layer === targetLabel);
      if (!resolved) return null;

      const memory = await resolved.store.readMemory(filePath);
      if (!memory) return null;
      return { ...memory, sourceLayer: resolved.layer, sourceLabel: resolved.label };
    }

    // No layer prefix — search in precedence order
    for (const resolved of this.stores) {
      const memory = await resolved.store.readMemory(memPath);
      if (memory) {
        return { ...memory, sourceLayer: resolved.layer, sourceLabel: resolved.label };
      }
    }
    return null;
  }

  /**
   * Get the writable store for a given target layer.
   *
   * When no target is specified, auto-selects: project → personal.
   * Global is writable but NEVER auto-selected — it must be explicitly
   * requested (store: "global"). This prevents accidental writes to
   * shared org knowledge.
   * Optional stores are always read-only.
   */
  getWriteTarget(target?: StoreLayer): ResolvedStore | null {
    if (target) {
      const store = this.stores.find((s) => s.layer === target && s.writable);
      return store || null;
    }

    // Default: project first, then personal. Never global (requires explicit intent).
    const project = this.stores.find((s) => s.layer === "project");
    if (project?.writable) return project;

    const personal = this.stores.find((s) => s.layer === "personal");
    if (personal?.writable) return personal;

    return null;
  }

  /**
   * Get a summary of all active stores for logging.
   */
  getSummary(): string {
    if (this.stores.length === 0) {
      return "No stores found. Create a .gnosys/ directory or set GNOSYS_PERSONAL.";
    }

    return this.stores
      .map(
        (s) =>
          `[${s.label}] ${s.path} (${s.writable ? "read-write" : "read-only"})`
      )
      .join("\n");
  }

  /**
   * Register a project directory in the persistent project registry.
   * Called by gnosys_init after creating a new store.
   */
  async registerProject(projectDir: string): Promise<void> {
    const configPath = this.getRegistryPath();
    let projects: string[] = [];

    try {
      const raw = await fs.readFile(configPath, "utf-8");
      projects = JSON.parse(raw);
    } catch {
      // File doesn't exist yet — that's fine
    }

    const resolved = path.resolve(projectDir);
    if (!projects.includes(resolved)) {
      projects.push(resolved);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(projects, null, 2), "utf-8");
    }
  }

  /**
   * Directly add a project store to the active stores list.
   * Used after gnosys_init creates a store, to avoid re-resolving from cwd.
   */
  async addProjectStore(storePath: string): Promise<void> {
    // Remove any existing project store first
    this.stores = this.stores.filter((s) => s.layer !== "project");

    const store = new GnosysStore(storePath);
    await store.init();
    this.stores.unshift({
      layer: "project",
      label: "project",
      store,
      writable: true,
      path: storePath,
    });
  }

  /**
   * Find a project store. Checks registered projects first (from
   * ~/.config/gnosys/projects.json), then walks up from cwd as fallback.
   */
  private async findProjectStore(): Promise<string | null> {
    // Check registered projects first — most reliable when MCP server
    // cwd doesn't match the editor's open project.
    const registered = await this.getRegisteredProjects();
    for (const projectDir of registered) {
      const candidate = path.join(projectDir, ".gnosys");
      if (await this.isValidStore(candidate)) {
        return candidate;
      }
    }

    // Fallback: walk up from cwd (works when cwd matches the project)
    let dir = path.resolve(process.cwd());
    const root = path.parse(dir).root;

    while (dir !== root) {
      const candidate = path.join(dir, ".gnosys");
      if (await this.isValidStore(candidate)) {
        return candidate;
      }
      dir = path.dirname(dir);
    }

    return null;
  }

  /**
   * Read registered project directories from persistent config.
   */
  private async getRegisteredProjects(): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.getRegistryPath(), "utf-8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  /**
   * Path to the persistent project registry file.
   */
  private getRegistryPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    return path.join(home, ".config", "gnosys", "projects.json");
  }

  /**
   * Check if a path looks like a valid Gnosys store.
   */
  private async isValidStore(storePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(storePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
