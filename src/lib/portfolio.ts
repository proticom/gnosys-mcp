/**
 * Gnosys Portfolio — Cross-project status dashboard
 *
 * Queries the central DB for all registered projects and generates
 * a formatted dashboard showing blockers, production readiness,
 * open questions, and roadmap status.
 */

import { GnosysDB, DbMemory, DbProject } from "./db.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface ActionItem {
  type: "question" | "blocker" | "manual" | "decision";
  text: string;
  projectName: string;
  sourceId: string;
  sourceTitle: string;
}

export interface ProjectSnapshot {
  project: DbProject;
  memoryCounts: {
    total: number;
    byCategory: Record<string, number>;
  };
  /** Most recent landscape memory (status snapshot) */
  latestStatus: { id: string; title: string; modified: string; content: string } | null;
  /** Active roadmap memories */
  roadmap: Array<{ id: string; title: string; content: string }>;
  /** Active open questions */
  openQuestions: Array<{ id: string; title: string; content: string }>;
  /** Top tags across all memories */
  topTags: Array<{ tag: string; count: number }>;
  /** Most recently modified memories (last 7 days) */
  recentActivity: Array<{ id: string; title: string; category: string; modified: string }>;
  /** Extracted blockers and action items needing manual intervention */
  actionItems: ActionItem[];
  /** Production readiness assessment */
  readiness: {
    /** 0-100 score */
    score: number;
    /** Short label: "Shipped", "Ready", "Mostly Done", "In Progress", "Early" */
    label: string;
    /** What's done (extracted bullet points) */
    done: string[];
    /** What's blocking go-live */
    blocking: string[];
  };
}

export interface PortfolioReport {
  generated: string;
  totalProjects: number;
  totalMemories: number;
  projects: ProjectSnapshot[];
  /** All action items across projects, sorted by urgency */
  allActionItems: ActionItem[];
}

// ─── Core ───────────────────────────────────────────────────────────────

/** Parse tags from the DB column (JSON array string or comma-separated) */
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((t: unknown) => typeof t === "string");
  } catch {
    // fallback: comma-separated
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Extract action items from memory content */
function extractActionItems(content: string, projectName: string, sourceId: string, sourceTitle: string): ActionItem[] {
  const items: ActionItem[] = [];
  const lines = content.split("\n");

  // Track which section we're in to improve classification
  let inWaitingOnHuman = false;
  let inBlockers = false;
  let inOpenDecisions = false;

  for (const line of lines) {
    // Detect guided-checklist section headings
    if (/^#+\s*waiting on human/i.test(line)) { inWaitingOnHuman = true; inBlockers = false; inOpenDecisions = false; continue; }
    if (/^#+\s*blocker/i.test(line)) { inBlockers = true; inWaitingOnHuman = false; inOpenDecisions = false; continue; }
    if (/^#+\s*open decision/i.test(line)) { inOpenDecisions = true; inWaitingOnHuman = false; inBlockers = false; continue; }
    if (/^#+\s/.test(line)) { inWaitingOnHuman = false; inBlockers = false; inOpenDecisions = false; }

    const trimmed = line.replace(/^[-*\d.)\s]+/, "").trim();
    if (!trimmed || trimmed.length < 10) continue;
    // Skip checklist formatting
    if (/^\[[ xX]\]/.test(trimmed)) continue;

    // Items in explicit sections get classified directly
    if (inWaitingOnHuman) {
      items.push({ type: "manual", text: trimmed.replace(/^\*\*(.+?)\*\*:?\s*/, "$1: "), projectName, sourceId, sourceTitle });
      continue;
    }
    if (inBlockers) {
      items.push({ type: "blocker", text: trimmed.replace(/^\*\*(.+?)\*\*:?\s*/, "$1: "), projectName, sourceId, sourceTitle });
      continue;
    }
    if (inOpenDecisions) {
      items.push({ type: "decision", text: trimmed.replace(/^\*\*(.+?)\*\*:?\s*/, "$1: "), projectName, sourceId, sourceTitle });
      continue;
    }

    // Fallback: pattern-match for action items in unstructured content

    // Account/service setup
    if (/\b(apple developer|developer program|sign[- ]?up|create.*(account|certificate)|register|enroll|submission|publish to|deploy to)\b/i.test(trimmed) &&
        /\b(need|require|must|block|pending|not yet|missing)\b/i.test(trimmed)) {
      items.push({ type: "manual", text: trimmed, projectName, sourceId, sourceTitle });
      continue;
    }

    // Decisions needed
    if (/\b(needs?.*(edward|confirm|decision|your|input)|decision.*needed|open question|still open|choose between|recommend)\b/i.test(trimmed) &&
        !/resolved/i.test(trimmed)) {
      items.push({ type: "decision", text: trimmed, projectName, sourceId, sourceTitle });
      continue;
    }

    // Explicit blockers
    if (/\b(block(s|ed|er|ing)|require[sd]?|must|cannot|gatekeeper|without (it|this))\b/i.test(trimmed) &&
        /\b(sign|notari|certificate|account|api key|token|credential|dns|domain|migration|deploy|publish|submit)\b/i.test(trimmed)) {
      items.push({ type: "blocker", text: trimmed, projectName, sourceId, sourceTitle });
    }
  }

  return items;
}

/** Extract blockers and "done" items from status content for readiness */
function extractReadiness(snap: { latestStatus: ProjectSnapshot["latestStatus"]; roadmap: ProjectSnapshot["roadmap"]; openQuestions: ProjectSnapshot["openQuestions"] }): ProjectSnapshot["readiness"] {
  const done: string[] = [];
  const blocking: string[] = [];

  if (!snap.latestStatus) {
    return { score: 0, label: "Unknown", done: [], blocking: ["No status snapshot available"] };
  }

  const content = snap.latestStatus.content;
  const lines = content.split("\n");

  // Patterns that signal "done" sections
  const donePattern = /^#+\s*(what'?s?.*(complete|done|built|shipped)|all.*done|complete[d]?\s*(work|as|in|features)?|features|core (architecture|features|functionality)|infrastructure)/i;
  // Also match plain text section openers like "Completed in the app:"
  const doneTextPattern = /^(completed|done|built|shipped|working|functional|implemented)\b/i;

  // Patterns that signal "blocking/remaining" sections — includes new guided checklist headings
  const blockPattern = /^#+\s*(what'?s?.*(not|left|missing|next|blocking)|to (go live|ship)|gap|blocker|remaining|pending|bug|not (started|done|built)|issue|missing|product gaps|waiting on human|open decision|roadmap change)/i;
  // Also match "X gaps:" or "Not started:" as plain text
  const blockTextPattern = /^(not (started|done|built|implemented)|remaining|gaps?|blocker|missing|pending|issue|app product gaps|waiting on)\b/i;

  let section: "none" | "done" | "blocking" = "none";

  for (const line of lines) {
    // Detect section headings (markdown ## or ### style)
    if (donePattern.test(line)) {
      section = "done";
      continue;
    }
    if (blockPattern.test(line)) {
      section = "blocking";
      continue;
    }

    // Detect plain text section openers (e.g. "Completed in the app:")
    if (section === "none" && doneTextPattern.test(line.trim()) && line.trim().endsWith(":")) {
      section = "done";
      continue;
    }
    if (section === "none" && blockTextPattern.test(line.trim()) && line.trim().endsWith(":")) {
      section = "blocking";
      continue;
    }

    // Sub-headings within a section: keep the section but skip the heading text
    if (/^#{3,}\s/.test(line) && section !== "none") {
      // Check if sub-heading switches context
      if (donePattern.test(line)) { section = "done"; continue; }
      if (blockPattern.test(line)) { section = "blocking"; continue; }
      continue; // stay in current section
    }

    // Top-level headings (# or ##) reset section
    if (/^#{1,2}\s/.test(line) && section !== "none") {
      // Unless it's clearly a continuation of done/blocking
      if (donePattern.test(line)) { section = "done"; continue; }
      if (blockPattern.test(line)) { section = "blocking"; continue; }
      section = "none";
      continue;
    }

    // Bold-label lines like "**name**: description" — treat as items in current section
    // or if no section yet, infer from content (success words = done, problem words = blocking)
    if (/^\*\*[^*]+\*\*:/.test(line.trim()) && section === "none") {
      const lower = line.toLowerCase();
      if (/succeed|pass|complete|built|working|functional|clean|integrat/i.test(lower)) {
        done.push(line.trim().replace(/^\*\*(.+?)\*\*:?\s*/, "$1: "));
      } else if (/fail|miss|broken|block|error|not|issue|gap|pending/i.test(lower)) {
        blocking.push(line.trim().replace(/^\*\*(.+?)\*\*:?\s*/, "$1: "));
      } else {
        // Ambiguous — treat as done (build status reports are usually positive when listing)
        done.push(line.trim().replace(/^\*\*(.+?)\*\*:?\s*/, "$1: "));
      }
      continue;
    }

    const trimmed = line.replace(/^[-*\d.)\s]+/, "").trim();
    if (!trimmed || trimmed.length < 5) continue;
    // Skip pure markdown formatting
    if (/^\*\*[^*]+\*\*$/.test(trimmed) && trimmed.length < 30) continue;
    // Strip leading bold markers for cleaner display
    const cleaned = trimmed.replace(/^\*\*(.+?)\*\*:?\s*/, "$1: ").replace(/^\*\*(.+?)\*\*$/, "$1");

    if (section === "done") {
      done.push(cleaned);
    } else if (section === "blocking") {
      blocking.push(cleaned);
    }
  }

  // Calculate score
  const totalItems = done.length + blocking.length;
  let score: number;
  if (totalItems === 0) {
    score = 50; // No structured done/blocking data found
  } else {
    score = Math.round((done.length / totalItems) * 100);
  }

  // Adjust for open questions (each unresolved question reduces score slightly)
  const unresolvedQuestions = snap.openQuestions.filter((q) => !/resolved/i.test(q.title)).length;
  score = Math.max(0, score - unresolvedQuestions * 3);

  // Determine label
  let label: string;
  if (score >= 95) label = "Shipped";
  else if (score >= 85) label = "Ready";
  else if (score >= 65) label = "Mostly Done";
  else if (score >= 30) label = "In Progress";
  else label = "Early";

  return { score, label, done: done.slice(0, 20), blocking: blocking.slice(0, 20) };
}

/** Build a snapshot for a single project */
function buildProjectSnapshot(db: GnosysDB, project: DbProject): ProjectSnapshot {
  const memories = db.getMemoriesByProject(project.id);

  // Count by category
  const byCategory: Record<string, number> = {};
  for (const m of memories) {
    byCategory[m.category] = (byCategory[m.category] || 0) + 1;
  }

  // Find best status snapshot — search ALL categories, prefer "status" or "go-live" in title
  const statusCandidates = memories
    .filter((m) => /status|go.?live|complete|shipped|what'?s (left|done|built)|readiness/i.test(m.title))
    .sort((a, b) => {
      // Prefer memories with "status" or "project status" in title
      const aIsStatus = /\bstatus\b/i.test(a.title) ? 1 : 0;
      const bIsStatus = /\bstatus\b/i.test(b.title) ? 1 : 0;
      if (bIsStatus !== aIsStatus) return bIsStatus - aIsStatus;
      // Then by recency
      return (b.modified || b.created).localeCompare(a.modified || a.created);
    });

  // If multiple status memories exist (e.g. "completed" + "remaining"), merge them
  // Prefer memories with "Project Status" or "status" in title for the merge
  const completedMem = statusCandidates.find((m) => /\bstatus\b.*complete|complete.*\bstatus\b|shipped/i.test(m.title))
    || statusCandidates.find((m) => /complete|shipped|done|built/i.test(m.title));
  const remainingMem = statusCandidates.find((m) => /left|remaining|gaps|not done|not started/i.test(m.title) && m.id !== completedMem?.id);

  let latestStatus: ProjectSnapshot["latestStatus"] = null;
  if (completedMem && remainingMem) {
    // Merge both into one synthetic status
    const merged = `${completedMem.content || ""}\n\n${remainingMem.content || ""}`;
    latestStatus = {
      id: completedMem.id,
      title: `${completedMem.title} + ${remainingMem.title}`,
      modified: completedMem.modified || completedMem.created,
      content: merged,
    };
  } else if (statusCandidates[0]) {
    const s = statusCandidates[0];
    latestStatus = { id: s.id, title: s.title, modified: s.modified || s.created, content: s.content || "" };
  } else {
    // Fallback: latest landscape memory
    const landscapes = memories
      .filter((m) => m.category === "landscape")
      .sort((a, b) => (b.modified || b.created).localeCompare(a.modified || a.created));
    if (landscapes[0]) {
      const s = landscapes[0];
      latestStatus = { id: s.id, title: s.title, modified: s.modified || s.created, content: s.content || "" };
    }
  }

  // Roadmap memories
  const roadmap = memories
    .filter((m) => m.category === "roadmap")
    .map((m) => ({ id: m.id, title: m.title, content: m.content || "" }));

  // Open questions (exclude resolved)
  const openQuestions = memories
    .filter((m) => m.category === "open-questions")
    .map((m) => ({ id: m.id, title: m.title, content: m.content || "" }));

  // Top tags
  const tagCounts = new Map<string, number>();
  for (const m of memories) {
    for (const tag of parseTags(m.tags)) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));

  // Recent activity (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentActivity = memories
    .filter((m) => (m.modified || m.created) >= sevenDaysAgo)
    .sort((a, b) => (b.modified || b.created).localeCompare(a.modified || a.created))
    .slice(0, 10)
    .map((m) => ({ id: m.id, title: m.title, category: m.category, modified: m.modified || m.created }));

  // Extract action items from status + roadmap memories
  const actionItems: ActionItem[] = [];
  if (latestStatus) {
    actionItems.push(...extractActionItems(latestStatus.content, project.name, latestStatus.id, latestStatus.title));
  }
  for (const r of roadmap) {
    actionItems.push(...extractActionItems(r.content, project.name, r.id, r.title));
  }
  // Open questions are action items by definition
  for (const q of openQuestions) {
    if (!/resolved/i.test(q.title)) {
      actionItems.push({
        type: "question",
        text: q.title.replace(/^(open question:?\s*)/i, ""),
        projectName: project.name,
        sourceId: q.id,
        sourceTitle: q.title,
      });
    }
  }

  // Deduplicate by text similarity
  const seen = new Set<string>();
  const uniqueActions = actionItems.filter((a) => {
    const key = a.text.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const readiness = extractReadiness({ latestStatus, roadmap, openQuestions });

  return {
    project,
    memoryCounts: { total: memories.length, byCategory },
    latestStatus,
    roadmap,
    openQuestions,
    topTags,
    recentActivity,
    actionItems: uniqueActions,
    readiness,
  };
}

/** Generate the full portfolio report */
export function generatePortfolio(db: GnosysDB): PortfolioReport {
  const projects = db.getAllProjects();

  // Filter out test projects (those in /tmp/ or /private/tmp/)
  const realProjects = projects.filter(
    (p) => !p.working_directory.startsWith("/tmp/") && !p.working_directory.startsWith("/private/tmp/")
  );

  const snapshots = realProjects.map((p) => buildProjectSnapshot(db, p));

  // Filter out projects with 0 memories
  const activeSnapshots = snapshots.filter((s) => s.memoryCounts.total > 0);

  const totalMemories = activeSnapshots.reduce((sum, s) => sum + s.memoryCounts.total, 0);

  // Collect all action items, sorted: questions first, then blockers, then manual, then decisions
  const typeOrder: Record<string, number> = { question: 0, blocker: 1, manual: 2, decision: 3 };
  const allActionItems = activeSnapshots
    .flatMap((s) => s.actionItems)
    .sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

  // Sort projects: most action items first, then by readiness (lowest first)
  activeSnapshots.sort((a, b) => {
    if (b.actionItems.length !== a.actionItems.length) return b.actionItems.length - a.actionItems.length;
    return a.readiness.score - b.readiness.score;
  });

  return {
    generated: new Date().toISOString().split("T")[0],
    totalProjects: activeSnapshots.length,
    totalMemories,
    projects: activeSnapshots,
    allActionItems,
  };
}

// ─── Formatters ─────────────────────────────────────────────────────────

/** Extract a short summary from a status landscape memory's content */
function extractStatusSummary(content: string, maxLines: number = 8): string {
  const lines = content.split("\n");
  const summaryLines: string[] = [];

  let capturing = false;
  for (const line of lines) {
    if (/^#+\s*(what'?s?.*(not|left|next|missing|blocking)|to go live|gaps|blockers)/i.test(line)) {
      capturing = true;
      summaryLines.push(line);
      continue;
    }
    if (capturing) {
      if (/^#+\s/.test(line) && summaryLines.length > 1) break;
      summaryLines.push(line);
      if (summaryLines.length >= maxLines) break;
    }
  }

  if (summaryLines.length > 0) return summaryLines.join("\n").trim();
  return lines.filter((l) => l.trim()).slice(0, maxLines).join("\n").trim();
}

/** Format the portfolio as markdown */
export function formatPortfolioMarkdown(report: PortfolioReport): string {
  const lines: string[] = [
    "# Gnosys Portfolio Dashboard",
    "",
    `_Auto-generated ${report.generated} | ${report.totalProjects} projects | ${report.totalMemories} memories_`,
    "",
  ];

  // Action items summary
  if (report.allActionItems.length > 0) {
    lines.push("## Needs Your Attention", "");
    for (const item of report.allActionItems) {
      const icon = item.type === "question" ? "?" : item.type === "blocker" ? "!" : item.type === "manual" ? ">" : "*";
      lines.push(`- [${icon}] **${item.projectName}**: ${item.text}`);
    }
    lines.push("");
  }

  // Readiness overview
  lines.push("## Production Readiness", "");
  lines.push("| Project | Readiness | Score | Blockers |");
  lines.push("|---------|-----------|-------|----------|");
  for (const snap of report.projects) {
    const blockerCount = snap.readiness.blocking.length;
    lines.push(`| **${snap.project.name}** | ${snap.readiness.label} | ${snap.readiness.score}% | ${blockerCount} |`);
  }
  lines.push("", "---", "");

  // Per-project details
  for (const snap of report.projects) {
    lines.push(`## ${snap.project.name} — ${snap.readiness.label} (${snap.readiness.score}%)`, "");

    if (snap.actionItems.length > 0) {
      lines.push("### Action Items", "");
      for (const item of snap.actionItems) {
        lines.push(`- [${item.type}] ${item.text}`);
      }
      lines.push("");
    }

    if (snap.readiness.blocking.length > 0) {
      lines.push("### Blocking Go-Live", "");
      for (const b of snap.readiness.blocking) {
        lines.push(`- ${b}`);
      }
      lines.push("");
    }

    const catEntries = Object.entries(snap.memoryCounts.byCategory).sort((a, b) => b[1] - a[1]);
    lines.push(`**${snap.memoryCounts.total} memories** across ${catEntries.length} categories`, "");

    if (snap.roadmap.length > 0) {
      lines.push("### Roadmap", "");
      for (const r of snap.roadmap) {
        lines.push(`- **${r.title}** (${r.id})`);
      }
      lines.push("");
    }

    if (snap.recentActivity.length > 0) {
      lines.push("### Recent Activity (7d)", "");
      for (const a of snap.recentActivity) {
        lines.push(`- ${a.title} — _${a.category}_ (${a.modified.split("T")[0]})`);
      }
      lines.push("");
    }

    lines.push("---", "");
  }

  return lines.join("\n");
}

/** Format as compact text (for MCP tool responses) */
export function formatPortfolioCompact(report: PortfolioReport): string {
  const lines: string[] = [
    `# Portfolio Dashboard (${report.generated})`,
    `${report.totalProjects} projects, ${report.totalMemories} total memories`,
    "",
  ];

  if (report.allActionItems.length > 0) {
    lines.push("## NEEDS ATTENTION");
    for (const item of report.allActionItems) {
      lines.push(`  [${item.type}] ${item.projectName}: ${item.text}`);
    }
    lines.push("");
  }

  for (const snap of report.projects) {
    lines.push(`## ${snap.project.name} — ${snap.readiness.label} (${snap.readiness.score}%)`);
    if (snap.readiness.blocking.length > 0) {
      lines.push(`  Blocking: ${snap.readiness.blocking.slice(0, 3).join("; ")}`);
    }
    if (snap.roadmap.length > 0) {
      lines.push(`  Roadmap: ${snap.roadmap.map((r) => r.title).join("; ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Status Template ────────────────────────────────────────────────────

/**
 * The canonical prompt to give any AI agent so it writes a dashboard-compatible
 * status memory via gnosys_add_structured.
 *
 * The prompt is structured as a guided checklist. The AI must:
 * 1. Analyze the codebase to fill in what it can determine
 * 2. ASK the user for anything it cannot determine from code alone
 * 3. Only write the status memory once all sections are addressed
 */
export const STATUS_UPDATE_PROMPT = `# Gnosys Status Update — Guided Checklist

You are updating the project status for the Gnosys portfolio dashboard. Follow this process exactly.

## Step 1: Analyze the codebase

Read the project structure, recent git history, test results, build status, and any existing status memories (use gnosys_discover and gnosys_read). Fill in as much as you can from code.

## Step 2: Work through every section below

For EACH section, either fill it in from your analysis or ASK the user. Do NOT skip sections. Do NOT write the status memory until all sections are addressed.

### Section A: What's Complete
List all features, milestones, and capabilities that are done and working. Be specific (e.g., "14 Playwright E2E tests passing" not "tests exist").

### Section B: What's NOT Done
List everything remaining before the project can go live. Include partial work, missing features, and known gaps.

### Section C: Waiting on Human
**YOU MUST ASK THE USER** if you cannot determine these from code:
- Are there accounts that need to be created or configured? (Apple Developer, cloud providers, API keys, DNS, domain registrars, app store submissions)
- Are there approvals or sign-offs needed? (legal, compliance, stakeholder review)
- Are there purchases needed? (certificates, licenses, subscriptions)
- Are there manual deployment steps only the user can do?
- Is the user waiting on anyone else? (contractors, partners, third-party services)

If the code shows signs of these (e.g., placeholder API keys, TODO comments about accounts, unsigned builds), list what you found and confirm with the user.

### Section D: Blockers
Items that are actively preventing progress. Distinguish between:
- **Technical blockers**: bugs, dependency issues, broken builds
- **External blockers**: waiting on third-party, account access, API approval
- **Decision blockers**: choices that need to be made before work can continue

### Section E: Open Decisions
Questions or choices that haven't been resolved yet. **ASK the user** about any you find:
- Architecture or technology choices still open
- Scope decisions (what's in v1 vs deferred)
- Prioritization questions
- Trade-offs that need a human call

### Section F: Go-Live Readiness
Assess each area — mark as Ready, Partial, Not Started, or N/A:
- [ ] Core features functional
- [ ] Error handling and edge cases
- [ ] Security review (auth, input validation, secrets management)
- [ ] Performance acceptable (or: performance testing not done)
- [ ] Functional testing sufficient (state coverage level and any known gaps)
- [ ] Documentation (user-facing: README, API docs, guides)
- [ ] Deployment pipeline (CI/CD, hosting, domain, SSL)
- [ ] Monitoring and logging
- [ ] Data migration / seed data
- [ ] Legal (privacy policy, terms, licenses, compliance)

### Section G: Testing Status
- **Functional tests**: What exists? What's the coverage? Any known failing tests?
- **Performance tests**: Have they been run? Any issues found? Any remediation done?
- **Integration tests**: Do external services / APIs work end-to-end?
- **Known defects**: List any open bugs with severity (critical/major/minor)
- **Defect remediation**: Any bugs that were found and fixed recently?

### Section H: Roadmap Changes
- Has the plan changed since the last status update?
- Any new work discovered during development?
- Any scope added or removed?
- What's the recommended next priority?

## Step 3: Ask the user about gaps

Before writing the memory, present your findings and explicitly ask about anything you couldn't determine:

> "I've analyzed the codebase and filled in what I can. I need your input on these items before I can write the status:
> 1. [specific question]
> 2. [specific question]
> ..."

If the user says "skip" or "not applicable" for a section, mark it as "N/A — skipped by owner" in the status.

## Step 4: Write the status memory

Once all sections are addressed, call gnosys_add_structured with:

- **title**: "[Project Name] status as of [YYYY-MM-DD] — [one-line summary]"
- **category**: "landscape"
- **tags**: { "type": ["status", "milestone"], "concern": ["release"] }
- **relevance**: "[project-name] status complete shipped ready go-live production blockers testing"
- **author**: "human+ai"
- **authority**: "observed"
- **confidence**: 0.95
- **projectRoot**: "[the project's working directory]"

The content MUST use these exact heading formats (the dashboard parser depends on them):

\`\`\`markdown
# [Project Name] Status — [YYYY-MM-DD]

## What's Complete
- [from Section A]

## What's NOT Done
- [from Section B]

## Waiting on Human
- [from Section C — manual steps, accounts, approvals]

## Blockers
- [from Section D — categorized as Technical / External / Decision]

## Open Decisions
- [from Section E]

## Go-Live Readiness
- [from Section F — checklist with status per area]

## Testing Status
- [from Section G — functional, performance, integration, defects]

## Roadmap Changes
- [from Section H — plan changes, new work, next priority]
\`\`\`

IMPORTANT: Be specific enough that someone reading the dashboard can take action immediately. "Needs testing" is useless — "No load tests run; API response times unknown under concurrent usage" is actionable.`;

/** Generate the status update prompt pre-filled for a specific project */
export function generateStatusPrompt(projectName: string, projectRoot: string): string {
  const date = new Date().toISOString().split("T")[0];
  return STATUS_UPDATE_PROMPT
    .replace(/\[Project Name\]/g, projectName)
    .replace(/\[YYYY-MM-DD\]/g, date)
    .replace(/\[project-name\]/g, projectName.toLowerCase().replace(/\s+/g, "-"))
    .replace(/\[the project's working directory\]/g, projectRoot)
    .replace(/\[one-line summary\]/g, "[fill in based on analysis]");
}
