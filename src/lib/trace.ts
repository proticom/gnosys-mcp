/**
 * Gnosys Process Tracing — Phase 10
 *
 * Builds call chains from TypeScript/JavaScript source files and stores them
 * as procedural "how" memories with relationship chaining:
 *   - follows_from: sequential call order
 *   - requires: dependency / import relationships
 *   - leads_to: what this function calls
 *
 * No external dependencies beyond Node built-ins and the Gnosys DB.
 */

import fs from "fs";
import path from "path";
import { GnosysDB, DbMemory } from "./db.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface TraceNode {
  name: string;           // function/class/method name
  file: string;           // relative file path
  kind: "function" | "class" | "method" | "export";
  line: number;
  calls: string[];        // names of functions this node calls
  calledBy: string[];     // names of functions that call this node
  imports: string[];      // imported modules/symbols
}

export interface TraceGraph {
  nodes: Map<string, TraceNode>;
  files: string[];
  rootDir: string;
}

export interface TraceResult {
  memoriesCreated: number;
  relationshipsCreated: number;
  functionsFound: number;
  filesScanned: number;
  memoryIds: string[];
}

// ─── Source Parsing (Regex-based, no TS compiler dependency) ─────────

/**
 * Extract function declarations, class methods, exports, and call sites
 * from a TypeScript/JavaScript source file using regex patterns.
 *
 * This is intentionally lightweight — no AST parsing dependency needed.
 */
function parseSourceFile(filePath: string, rootDir: string): TraceNode[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relPath = path.relative(rootDir, filePath);
  const nodes: TraceNode[] = [];

  // Track imports for the file
  const fileImports: string[] = [];
  const importRegex = /import\s+(?:{[^}]*}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importRegex.exec(content))) {
    fileImports.push(importMatch[1]);
  }

  // Pattern: function declarations (named functions, arrow functions assigned to const/let/var)
  const funcPatterns = [
    // export function foo(...) or function foo(...)
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g,
    // const foo = (...) => or const foo = function(...)
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\s*\()/g,
    // class methods: foo(...) { or async foo(...) {
    /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/gm,
  ];

  // Pattern: class declarations
  const classRegex = /(?:export\s+)?class\s+(\w+)(?:\s+(?:extends|implements)\s+\w+)?\s*\{/g;

  // Extract function call sites: identifier followed by (
  const callRegex = /\b(\w+)\s*\(/g;

  // Common built-ins to exclude from call detection
  const builtins = new Set([
    "if", "for", "while", "switch", "catch", "return", "throw", "new", "typeof",
    "instanceof", "delete", "void", "yield", "await", "import", "export",
    "require", "console", "process", "JSON", "Object", "Array", "String",
    "Number", "Boolean", "Map", "Set", "Promise", "Error", "Math", "Date",
    "parseInt", "parseFloat", "setTimeout", "setInterval", "clearTimeout",
    "clearInterval", "Buffer", "Symbol", "RegExp", "Proxy", "Reflect",
    "describe", "it", "expect", "test", "beforeEach", "afterEach",
  ]);

  // First pass: find all function/class/method declarations
  const declaredNames = new Set<string>();

  for (const pattern of funcPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      const name = match[1];
      if (builtins.has(name) || declaredNames.has(name)) continue;
      declaredNames.add(name);

      // Find line number
      const lineNum = content.slice(0, match.index).split("\n").length;

      nodes.push({
        name,
        file: relPath,
        kind: "function",
        line: lineNum,
        calls: [],
        calledBy: [],
        imports: fileImports,
      });
    }
  }

  // Extract classes
  {
    classRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = classRegex.exec(content))) {
      const name = match[1];
      if (declaredNames.has(name)) continue;
      declaredNames.add(name);
      const lineNum = content.slice(0, match.index).split("\n").length;
      nodes.push({
        name,
        file: relPath,
        kind: "class",
        line: lineNum,
        calls: [],
        calledBy: [],
        imports: fileImports,
      });
    }
  }

  // Second pass: for each declared function, find what it calls
  // This is an approximation — we scan the function body for call sites
  for (const node of nodes) {
    // Find the function body (from declaration to next top-level declaration or EOF)
    const startLine = node.line - 1;
    let endLine = lines.length;

    // Simple heuristic: scan forward until we find the closing brace at the same indent level
    let braceDepth = 0;
    let foundOpen = false;
    for (let i = startLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { braceDepth++; foundOpen = true; }
        if (ch === "}") { braceDepth--; }
      }
      if (foundOpen && braceDepth <= 0) {
        endLine = i + 1;
        break;
      }
    }

    const body = lines.slice(startLine, endLine).join("\n");
    callRegex.lastIndex = 0;
    let callMatch: RegExpExecArray | null;
    const callSet = new Set<string>();
    while ((callMatch = callRegex.exec(body))) {
      const callee = callMatch[1];
      if (callee !== node.name && !builtins.has(callee) && declaredNames.has(callee)) {
        callSet.add(callee);
      }
    }
    node.calls = [...callSet];
  }

  // Back-fill calledBy
  const nodeMap = new Map(nodes.map((n) => [n.name, n]));
  for (const node of nodes) {
    for (const callee of node.calls) {
      const target = nodeMap.get(callee);
      if (target) {
        target.calledBy.push(node.name);
      }
    }
  }

  return nodes;
}

// ─── File Discovery ─────────────────────────────────────────────────────

function discoverSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const extensions = new Set([".ts", ".js", ".tsx", ".jsx"]);
  const ignoreDirs = new Set(["node_modules", "dist", "build", ".git", "coverage", ".gnosys"]);

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied or other error
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (ignoreDirs.has(entry.name) && entry.isDirectory()) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        // Skip test files and declaration files
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.js")) continue;
        if (entry.name.endsWith(".d.ts")) continue;
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

// ─── Trace Codebase ─────────────────────────────────────────────────────

/**
 * Trace a codebase directory: discover source files, parse function declarations
 * and call relationships, then store as procedural "how" memories in the DB.
 */
export function traceCodebase(
  db: GnosysDB,
  rootDir: string,
  opts: {
    projectId?: string;
    maxFiles?: number;
  } = {}
): TraceResult {
  const absRoot = path.resolve(rootDir);
  const sourceFiles = discoverSourceFiles(absRoot);
  const filesToScan = opts.maxFiles
    ? sourceFiles.slice(0, opts.maxFiles)
    : sourceFiles;

  // Parse all files
  const allNodes: TraceNode[] = [];
  for (const file of filesToScan) {
    try {
      const nodes = parseSourceFile(file, absRoot);
      allNodes.push(...nodes);
    } catch {
      // Skip unparseable files
    }
  }

  if (allNodes.length === 0) {
    return {
      memoriesCreated: 0,
      relationshipsCreated: 0,
      functionsFound: 0,
      filesScanned: filesToScan.length,
      memoryIds: [],
    };
  }

  // Build a global name→node map (deduplicate by file:name)
  const globalMap = new Map<string, TraceNode>();
  for (const node of allNodes) {
    const key = `${node.file}:${node.name}`;
    globalMap.set(key, node);
  }

  // Cross-file: resolve calls to any declared function across files
  const nameToKeys = new Map<string, string[]>();
  for (const [key, node] of globalMap) {
    if (!nameToKeys.has(node.name)) nameToKeys.set(node.name, []);
    nameToKeys.get(node.name)!.push(key);
  }

  const now = new Date().toISOString();
  const memoryIds: string[] = [];
  let relationshipsCreated = 0;

  // Create a procedural memory for each function/class
  const keyToMemId = new Map<string, string>();

  for (const [key, node] of globalMap) {
    const memId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    keyToMemId.set(key, memId);

    const content = [
      `## ${node.kind}: ${node.name}`,
      "",
      `**File:** \`${node.file}\` (line ${node.line})`,
      "",
      node.calls.length > 0
        ? `**Calls:** ${node.calls.map((c) => `\`${c}\``).join(", ")}`
        : "**Calls:** (none)",
      node.calledBy.length > 0
        ? `**Called by:** ${node.calledBy.map((c) => `\`${c}\``).join(", ")}`
        : "**Called by:** (none)",
      node.imports.length > 0
        ? `\n**Imports:** ${node.imports.map((i) => `\`${i}\``).join(", ")}`
        : "",
    ].filter(Boolean).join("\n");

    db.insertMemory({
      id: memId,
      title: `How: ${node.name} (${node.file})`,
      category: "how",
      content,
      summary: null,
      tags: JSON.stringify(["procedural", node.kind, path.basename(node.file, path.extname(node.file))]),
      relevance: `how procedural ${node.name} ${node.file} ${node.kind}`,
      author: "ai",
      authority: "observed",
      confidence: 0.85,
      reinforcement_count: 0,
      content_hash: "",
      status: "active",
      tier: "active",
      supersedes: null,
      superseded_by: null,
      last_reinforced: null,
      created: now,
      modified: now,
      embedding: null,
      source_path: node.file,
      project_id: opts.projectId || null,
      scope: "project",
    });

    memoryIds.push(memId);
  }

  // Create relationships: leads_to, follows_from, requires
  for (const [key, node] of globalMap) {
    const sourceMemId = keyToMemId.get(key)!;

    for (const callee of node.calls) {
      // Find target memory IDs for this callee name
      const targetKeys = nameToKeys.get(callee) || [];
      for (const targetKey of targetKeys) {
        const targetMemId = keyToMemId.get(targetKey);
        if (!targetMemId || targetMemId === sourceMemId) continue;

        // leads_to: this function leads to the callee
        db.insertRelationship({
          source_id: sourceMemId,
          target_id: targetMemId,
          rel_type: "leads_to",
          label: `${node.name} calls ${callee}`,
          confidence: 0.9,
          created: now,
        });
        relationshipsCreated++;

        // follows_from: the callee follows from this function
        db.insertRelationship({
          source_id: targetMemId,
          target_id: sourceMemId,
          rel_type: "follows_from",
          label: `${callee} is called by ${node.name}`,
          confidence: 0.9,
          created: now,
        });
        relationshipsCreated++;
      }
    }

    // requires: import relationships (module-level)
    for (const imp of node.imports) {
      // Find any nodes from the imported module
      for (const [targetKey, targetNode] of globalMap) {
        if (targetNode.file.includes(imp.replace(/^\.\//, "").replace(/\.\w+$/, ""))) {
          const targetMemId = keyToMemId.get(targetKey);
          if (!targetMemId || targetMemId === sourceMemId) continue;

          db.insertRelationship({
            source_id: sourceMemId,
            target_id: targetMemId,
            rel_type: "requires",
            label: `${node.file} imports from ${targetNode.file}`,
            confidence: 0.7,
            created: now,
          });
          relationshipsCreated++;
        }
      }
    }
  }

  return {
    memoriesCreated: memoryIds.length,
    relationshipsCreated,
    functionsFound: allNodes.length,
    filesScanned: filesToScan.length,
    memoryIds,
  };
}
