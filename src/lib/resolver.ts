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

  /** MCP workspace roots (file:// URIs → local paths). Updated via roots/list. */
  private static mcpRoots: string[] = [];

  /**
   * Update the MCP roots list. Call this from the MCP server on init
   * and on "notifications/roots/list_changed".
   */
  static setMcpRoots(roots: Array<{ uri: string; name?: string }>): void {
    GnosysResolver.mcpRoots = roots
      .map((r) => {
        try {
          // Convert file:// URI to local path
          if (r.uri.startsWith("file://")) {
            return new URL(r.uri).pathname;
          }
          return r.uri;
        } catch {
          return r.uri;
        }
      })
      .filter(Boolean);
  }

  /**
   * Get the current MCP roots as local paths.
   */
  static getMcpRoots(): string[] {
    return [...GnosysResolver.mcpRoots];
  }

  /**
   * Create a resolver scoped to a specific project root.
   * Used for per-tool projectRoot parameter — each call gets its own
   * resolver instance, so there's no shared mutable state.
   */
  static async resolveForProject(projectRoot: string): Promise<GnosysResolver> {
    const resolver = new GnosysResolver();
    const storePath = path.join(path.resolve(projectRoot), ".gnosys");

    try {
      const stat = await fs.stat(storePath);
      if (stat.isDirectory()) {
        const store = new GnosysStore(storePath);
        await store.init();
        resolver.stores.push({
          layer: "project",
          label: "project",
          store,
          writable: true,
          path: storePath,
        });
      }
    } catch {
      // Store doesn't exist at projectRoot — fall through to empty resolver
    }

    return resolver;
  }

  /**
   * Discover and initialize all store layers.
   */
  async resolve(): Promise<ResolvedStore[]> {
    this.stores = [];

    // 1. Project store — check registered projects first, then MCP roots, then walk up from cwd.
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
   * Find a project store. Priority order:
   *   1. Walk up from cwd (most specific — matches the directory the user is in)
   *   2. MCP workspace roots (from roots/list)
   *   3. Registered project matching cwd (from ~/.config/gnosys/projects.json)
   *   4. First registered project (fallback when cwd has no store)
   */
  private async findProjectStore(): Promise<string | null> {
    // 1. Walk up from cwd — most reliable for CLI usage.
    //    If the user is inside a project with .gnosys/, use that.
    let dir = path.resolve(process.cwd());
    const root = path.parse(dir).root;

    while (dir !== root) {
      const candidate = path.join(dir, ".gnosys");
      if (await this.isValidStore(candidate)) {
        return candidate;
      }
      dir = path.dirname(dir);
    }

    // 2. Check MCP roots — workspace folders the host tells us about.
    for (const rootPath of GnosysResolver.mcpRoots) {
      const candidate = path.join(rootPath, ".gnosys");
      if (await this.isValidStore(candidate)) {
        return candidate;
      }
    }

    // 3. Check registered projects — fallback when cwd has no store
    //    (e.g., MCP server started from a different directory).
    const registered = await this.getRegisteredProjects();
    for (const projectDir of registered) {
      const candidate = path.join(projectDir, ".gnosys");
      if (await this.isValidStore(candidate)) {
        return candidate;
      }
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
   * Detect all available stores from all sources (registered, MCP roots, cwd, env vars).
   * Returns a flat list for debugging. Does NOT modify the active stores.
   */
  async detectAllStores(): Promise<Array<{
    source: string;
    path: string;
    hasGnosys: boolean;
    isActive: boolean;
  }>> {
    const results: Array<{ source: string; path: string; hasGnosys: boolean; isActive: boolean }> = [];
    const activePaths = new Set(this.stores.map((s) => s.path));

    // Registered projects
    const registered = await this.getRegisteredProjects();
    for (const dir of registered) {
      const storePath = path.join(dir, ".gnosys");
      const has = await this.isValidStore(storePath);
      results.push({ source: "registered", path: dir, hasGnosys: has, isActive: activePaths.has(storePath) });
    }

    // MCP roots
    for (const rootPath of GnosysResolver.mcpRoots) {
      const storePath = path.join(rootPath, ".gnosys");
      const has = await this.isValidStore(storePath);
      // Skip if already listed as registered
      if (!results.some((r) => r.path === rootPath)) {
        results.push({ source: "mcp-root", path: rootPath, hasGnosys: has, isActive: activePaths.has(storePath) });
      }
    }

    // CWD
    const cwd = process.cwd();
    if (!results.some((r) => r.path === cwd)) {
      const cwdStore = path.join(cwd, ".gnosys");
      const has = await this.isValidStore(cwdStore);
      results.push({ source: "cwd", path: cwd, hasGnosys: has, isActive: activePaths.has(cwdStore) });
    }

    // Env vars
    if (process.env.GNOSYS_PERSONAL) {
      results.push({ source: "env:GNOSYS_PERSONAL", path: process.env.GNOSYS_PERSONAL, hasGnosys: true, isActive: activePaths.has(process.env.GNOSYS_PERSONAL) });
    }
    if (process.env.GNOSYS_GLOBAL) {
      results.push({ source: "env:GNOSYS_GLOBAL", path: process.env.GNOSYS_GLOBAL, hasGnosys: true, isActive: activePaths.has(process.env.GNOSYS_GLOBAL) });
    }

    return results;
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
