#!/usr/bin/env node
/**
 * Command coverage auditor — v5.10.0 Phase 0 gate.
 *
 * Read-only static analysis (no npm, no test execution). Safe to run with
 * bare `node` even when node_modules is unavailable.
 *
 * For every command registered in src/cli.ts it derives:
 *   - full invocation, parent chain, sidebar group, line number
 *   - description + option count (from the Commander chain)
 *   - handler functions the .action delegates to (dynamic-import destructures)
 *   - which test files reference those handlers, and what those files validate
 *     (their describe() titles) — the "is there a test, what's it called,
 *     what does it check" signal Edward asked for
 *   - a coverage verdict: green (handler tested) / amber (domain test exists,
 *     no handler-level test) / red (no test reference at all)
 *   - doc status: present|missing (docs/commands/<full>.md)
 *
 * Emits ../command-coverage-dashboard.data.json (workspace root). The HTML
 * renderer reads that file (with an embedded fallback for file://).
 *
 * Coverage is a HEURISTIC, intentionally conservative. Command handlers
 * delegate to lib functions; tests mostly target those lib functions, not
 * the CLI surface. Amber/red here means "no command-level test", which is
 * the gap this audit exists to surface — not necessarily "untested logic".
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const TEST_DIR = path.join(REPO_ROOT, "src", "test");
const DOCS_DIR = path.join(REPO_ROOT, "docs", "commands");
const OUT = path.resolve(REPO_ROOT, "..", "command-coverage-dashboard.data.json");
const QUEUE = path.resolve(REPO_ROOT, "..", "reviews", "command-coverage-review-queue.json");
const DEFERRED_IDS = new Set(["config", "dream", "export", "pref"]);

// ── Edward's approved sidebar grouping (full invocation, minus "gnosys ") ──
// Commands found in cli.ts but absent here surface in "Ungrouped (not in sidebar)".
const GROUPS = [
  ["Getting Started", ["setup", "setup models", "setup ides", "setup routing", "setup preferences", "setup chat", "setup dream", "init", "config", "config show", "config set", "config init", "stores", "doctor", "serve"]],
  ["Writing Memories", ["add", "add-structured", "commit-context", "bootstrap", "import", "ingest"]],
  ["Reading & Search", ["read", "discover", "search", "hybrid-search", "semantic-search", "ask", "recall", "fsearch", "chat", "working-set"]],
  ["Organization", ["list", "lens", "tags", "tags-add", "links", "graph"]],
  ["History & Updates", ["update", "reinforce", "stale", "history", "rollback", "timeline", "stats"]],
  ["Web Knowledge Base", ["web init", "web ingest", "web build-index", "web build", "web add", "web remove", "web update", "web status"]],
  ["Process Tracing", ["trace", "reflect", "traverse"]],
  ["Agent Integration", ["sandbox start", "sandbox stop", "sandbox status", "helper generate"]],
  ["System & Maintenance", ["upgrade", "maintain", "reindex", "reindex-graph", "dearchive", "dream", "dream run", "dream log", "export", "export vault", "export project", "audit", "migrate", "backup", "restore", "projects", "pref", "pref set", "pref get", "pref delete", "sync", "ambiguity", "briefing", "check", "setup sync-projects", "cleanup", "migrate-db"]],
  ["Portfolio & Status", ["status", "update-status"]],
  ["Multi-Machine Sync", ["setup remote", "setup remote configure", "setup remote status", "setup remote sync", "setup remote push", "setup remote pull", "setup remote resolve"]],
  ["Containers & Parents", ["import", "import project", "web", "sandbox", "helper", "dream", "export", "config", "pref"]],
];

function groupFor(full) {
  for (const [name, cmds] of GROUPS) if (cmds.includes(full)) return name;
  return "Ungrouped (not in sidebar)";
}

function lineAt(text, idx) {
  return text.slice(0, idx).split("\n").length;
}

// Balance parens from an opening "(" to find the matching close. Naive
// (counts parens in strings too) but action bodies rarely break it.
function balancedSlice(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(openIdx, i + 1);
  }
  return text.slice(openIdx);
}

// Ubiquitous infra identifiers — these appear in nearly every test file and
// would produce false-green coverage if treated as command-specific handlers.
const GENERIC_HANDLERS = new Set([
  "GnosysDB", "GnosysResolver", "GnosysStore", "GnosysSearch", "GnosysTagRegistry",
  "handleRequest", "loadConfig", "updateConfig", "writeConfig", "getResolver",
  "getGnosysHome", "printStatus", "Spinner", "DEFAULT_CONFIG",
  // Node built-ins occasionally destructured in action bodies — not handlers.
  "mkdirSync", "existsSync", "readFileSync", "writeFileSync", "readdirSync",
  "createInterface", "spawn", "execSync",
]);

// ── Parse cli.ts ──────────────────────────────────────────────────────────
const src = fs.readFileSync(CLI, "utf8");

// Pass 1: variable → command name + receiver var (for full-path resolution).
// Matches: const X = <receiver>.command("Y" ...)
const bindings = {}; // varName -> { name, receiver }
const bindRe = /const\s+(\w+)\s*=\s*(\w+)\s*\.\s*command\(\s*["']([^"'\s]+)/g;
for (let m; (m = bindRe.exec(src)); ) {
  bindings[m[1]] = { name: m[3], receiver: m[2] };
}

function fullPath(receiver) {
  // Resolve a receiver token to its full command path (array of names).
  if (receiver === "program") return [];
  const b = bindings[receiver];
  if (!b) return [receiver]; // unknown — surface verbatim
  return [...fullPath(b.receiver), b.name];
}

// Pass 2: every .command("spec") site.
const cmds = [];
const cmdRe = /(\w+)\s*\.\s*command\(\s*["']([^"']+?)["']/g;
for (let m; (m = cmdRe.exec(src)); ) {
  const receiver = m[1];
  const spec = m[2];
  const leaf = spec.split(/\s+/)[0];
  const parentPath = fullPath(receiver);
  const fullArr = [...parentPath, leaf];
  const full = fullArr.join(" ");
  const idx = m.index;
  const line = lineAt(src, idx);

  // Window from this command to the next .command( or .action( for desc/options.
  const rest = src.slice(idx + m[0].length);
  const nextCmd = rest.search(/\w+\s*\.\s*command\(/);
  const nextAction = rest.search(/\.\s*action\(/);
  const descEnd = nextAction >= 0 ? nextAction : (nextCmd >= 0 ? nextCmd : rest.length);
  const descWindow = rest.slice(0, descEnd);
  const descM = descWindow.match(/\.\s*description\(\s*["'`]([^"'`]+)/);
  const description = descM ? descM[1] : "";
  const optionCount = (descWindow.match(/\.\s*option\(/g) || []).length;

  // Handler window: paren-balance the .action(...) call so we capture ONLY
  // this command's body, not handlers bleeding in from later commands.
  let handlers = [];
  if (nextAction >= 0) {
    const actionOpen = rest.indexOf("(", nextAction);
    const body = balancedSlice(rest, actionOpen);
    // destructured dynamic imports: const { a, b } = await import("./lib/x.js")
    const destructRe = /const\s*\{([^}]+)\}\s*=\s*await\s+import\(/g;
    for (let d; (d = destructRe.exec(body)); ) {
      d[1].split(",").map((s) => s.trim().split(":")[0].trim()).filter(Boolean).forEach((n) => handlers.push(n));
    }
    handlers = [...new Set(handlers)];
  }
  // Coverage-driving handlers exclude generic infra identifiers.
  const specificHandlers = handlers.filter((h) => !GENERIC_HANDLERS.has(h));

  cmds.push({ full, leaf, parent: parentPath.join(" ") || null, line, description, options: optionCount, handlers, specificHandlers });
}

// De-dupe (a leaf like "chat" appears as both top-level and setup chat).
const seen = new Set();
const commands = cmds.filter((c) => {
  const key = c.full + "@" + c.line;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// ── Index test files ──────────────────────────────────────────────────────
const testFiles = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"));
const testIndex = testFiles.map((file) => {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const titles = [];
  const titleRe = /\b(?:describe|it|test)\(\s*["'`]([^"'`]+)/g;
  for (let t; (t = titleRe.exec(text)); ) titles.push(t[1]);
  return { file, text, titles };
});

function testsForHandlers(handlers, domainHints) {
  const hits = [];
  for (const tf of testIndex) {
    const handlerHit = handlers.some((h) => h && new RegExp(`\\b${h}\\b`).test(tf.text));
    const domainHit = domainHints.some((d) => d && tf.file.toLowerCase().includes(d.toLowerCase()));
    if (handlerHit) {
      hits.push({ file: tf.file, match: "handler", validates: tf.titles.slice(0, 6) });
    } else if (domainHit) {
      hits.push({ file: tf.file, match: "domain", validates: tf.titles.slice(0, 6) });
    }
  }
  return hits;
}

// ── Build records ───────────────────────────────────────────────────────────
const parentPaths = new Set(commands.map((c) => c.parent).filter(Boolean));
let green = 0, amber = 0, red = 0, na = 0, docsPresent = 0;
const records = commands.map((c) => {
  const isParent = parentPaths.has(c.full); // a container for subcommands
  const domainHints = [c.leaf, (c.parent || "").split(" ").pop()].filter(Boolean);
  const hits = testsForHandlers(c.specificHandlers, domainHints);
  const hasHandler = hits.some((h) => h.match === "handler");
  const hasDomain = hits.some((h) => h.match === "domain");
  let coverage;
  if (isParent && c.specificHandlers.length === 0) coverage = "n/a"; // pure container
  else coverage = hasHandler ? "green" : hasDomain ? "amber" : "red";
  if (coverage === "green") green++; else if (coverage === "amber") amber++; else if (coverage === "red") red++; else na++;

  const docPath = path.join(DOCS_DIR, c.full.replace(/\s+/g, "-") + ".md");
  const docPresent = fs.existsSync(docPath);
  if (docPresent) docsPresent++;

  return {
    full: "gnosys " + c.full,
    group: groupFor(c.full),
    kind: isParent ? "parent" : "leaf",
    line: c.line,
    description: c.description,
    options: c.options,
    handlers: c.handlers,
    tests: hits,
    coverage,
    doc: docPresent ? "present" : "missing",
  };
});

// Order by group (sidebar order, ungrouped last), then by line.
const groupOrder = [...GROUPS.map((g) => g[0]), "Ungrouped (not in sidebar)"];
records.sort((a, b) => {
  const ga = groupOrder.indexOf(a.group), gb = groupOrder.indexOf(b.group);
  return ga !== gb ? ga - gb : a.line - b.line;
});

const data = {
  generated: new Date().toISOString().slice(0, 10),
  repo: "gnosys-public",
  cli_file: "src/cli.ts",
  snapshot_policy: "Local sprint visibility artifact only. Do not stage, commit, or push this dashboard.",
  note: "Coverage is a conservative static heuristic. green = a test references the command's handler function. amber = a domain test file exists but no handler-level test. red = no test reference at all. Amber/red flags command-level test gaps, not necessarily untested logic.",
  summary: {
    total: records.length,
    green, amber, red, na,
    docs_present: docsPresent,
    docs_missing: records.length - docsPresent,
  },
  groups: groupOrder.filter((g) => records.some((r) => r.group === g)),
  commands: records,
};

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fullToId(full) {
  if (!full.startsWith("gnosys ")) throw new Error(`unexpected command full name: ${full}`);
  return full.slice("gnosys ".length).replace(/\s+/g, "-");
}

function groupSlug(title) {
  return "group-" + title.toLowerCase().replace(/\s+/g, "-").replace(/&/g, "and");
}

function buildEvidence(cmd) {
  const handlers = (cmd.handlers || []).join(", ");
  const testFiles = (cmd.tests || []).map((t) => t.file).join(", ");
  return `src/cli.ts:${cmd.line || "?"} · handlers: ${handlers} · tests: ${testFiles}`;
}

function buildReviewerGuidance(cmd, taskId) {
  const handlers = (cmd.handlers || []).join(", ");
  if (cmd.coverage === "green" && cmd.doc === "present") {
    return `Command ${taskId} is green with doc present. Verify audit fields and doc quality.`;
  }
  if (cmd.coverage === "red") {
    return `No test reference for gnosys ${taskId.replace(/-/g, " ")}. Add handler-level test for ${handlers} or document accepted domain-only rationale.`;
  }
  return `Domain test exists but no handler-level CLI test for gnosys ${taskId.replace(/-/g, " ")}. Add test referencing handler(s): ${handlers}, or document why domain coverage is sufficient.`;
}

function implStatusForReview(reviewStatus) {
  if (reviewStatus === "review_passed") return "done";
  if (["in_review", "waiting_for_builder", "waiting_for_reviewer", "review_failed"].includes(reviewStatus)) {
    return "in_progress";
  }
  return "todo";
}

function toDashboardShape(audit) {
  const queue = readJsonIfExists(QUEUE);
  if (!queue?.tasks) return audit;

  const previous = readJsonIfExists(OUT);
  const previousMeta = previous?.meta || {};
  const queueById = new Map(queue.tasks.map((t) => [t.id, t]));
  const grouped = new Map();
  const orderedGroups = audit.groups || [];

  for (const title of orderedGroups) grouped.set(title, { id: groupSlug(title), title, tasks: [] });
  for (const cmd of audit.commands) {
    const group = cmd.group || "Ungrouped";
    if (!grouped.has(group)) grouped.set(group, { id: groupSlug(group), title: group, tasks: [] });

    const taskId = fullToId(cmd.full);
    const q = queueById.get(taskId) || {};
    const reviewStatus = q.review_status || "not_started";
    const status = DEFERRED_IDS.has(taskId)
      ? "deferred"
      : (q.status === "active" || reviewStatus !== "not_started")
        ? implStatusForReview(reviewStatus)
        : "todo";

    grouped.get(group).tasks.push({
      id: taskId,
      title: taskId,
      status,
      review_status: reviewStatus,
      evidence: buildEvidence(cmd),
      reviewer_guidance: buildReviewerGuidance(cmd, taskId),
      notes: q.notes || "",
      ...cmd,
    });
  }

  const groups = Array.from(grouped.values()).filter((g) => g.tasks.length);
  const counts = { done: 0, partial: 0, in_progress: 0, todo: 0, deferred: 0 };
  const reviewCounts = {};
  let total = 0;
  for (const group of groups) {
    total += group.tasks.length;
    for (const task of group.tasks) {
      counts[task.status] = (counts[task.status] || 0) + 1;
      reviewCounts[task.review_status] = (reviewCounts[task.review_status] || 0) + 1;
    }
  }

  const defaultBrand = {
    title: "Gnosys — Command Coverage Gate",
    accent: "#C04C4C",
    accent_light: "#D46A6A",
    success: "#4C9A6E",
    bg: "#12141A",
    surface: "#1A1D26",
    border: "#2E3340",
    text: "#E4E2E8",
    text_muted: "#9CA0AB",
    logo_alt: "Gnosys",
  };

  return {
    meta: {
      project: "Gnosys — Command Coverage Gate",
      spec: "gnosys-command-coverage-plan.md",
      dashboard_version: "1.3.0",
      ...previousMeta,
      last_updated: audit.generated,
      total_atomic_tasks: total,
      completed: counts.done || 0,
      partial: counts.partial || 0,
      in_progress: counts.in_progress || 0,
      todo: counts.todo || 0,
      deferred: counts.deferred || 0,
      notes: audit.note,
      review_status_legend: "not_started | in_review | waiting_for_builder | waiting_for_reviewer | review_passed | review_failed | needs_human | blocked",
      roles_note: previousMeta.roles_note || "Builder: cursor · Reviewer: codex · Decider: codex · max_turns: 3",
      brand: { ...defaultBrand, ...(previousMeta.brand || {}) },
    },
    generated: audit.generated,
    repo: audit.repo,
    cli_file: audit.cli_file,
    snapshot_policy: audit.snapshot_policy,
    note: audit.note,
    summary: {
      ...audit.summary,
      review_passed: reviewCounts.review_passed || 0,
      review_not_started: reviewCounts.not_started || 0,
      impl_done: counts.done || 0,
      impl_todo: counts.todo || 0,
    },
    groups,
    commands: audit.commands,
  };
}

const output = toDashboardShape(data);
fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
console.log(`✓ ${records.length} commands audited → ${OUT}`);
console.log(`  coverage: ${green} green · ${amber} amber · ${red} red · ${na} n/a (containers)`);
console.log(`  docs: ${docsPresent} present · ${records.length - docsPresent} missing`);
const ungrouped = records.filter((r) => r.group === "Ungrouped (not in sidebar)");
if (ungrouped.length) console.log(`  ungrouped (in cli.ts, not in sidebar): ${ungrouped.map((r) => r.full.replace("gnosys ", "")).join(", ")}`);
