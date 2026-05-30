import fs from "fs";
import path from "path";
import { readDreamRuns, type DreamRunRecord } from "./dreamRunLog.js";

export interface DreamReportOptions {
  output?: string;
  last?: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMoney(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function sum(runs: DreamRunRecord[], fn: (run: DreamRunRecord) => number): number {
  return runs.reduce((total, run) => total + fn(run), 0);
}

function bar(value: number, max: number): string {
  const width = max <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return `<div class="bar"><span style="width:${width}%"></span></div>`;
}

export function generateDreamDashboardHtml(runs: DreamRunRecord[]): string {
  const sorted = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const completed = sorted.filter((r) => r.status === "completed");
  const totalCost = sum(sorted, (r) => r.totals.estimatedCostUsd);
  const totalCalls = sum(sorted, (r) => r.totals.llmCallsMade);
  const totalSkippedCalls = sum(sorted, (r) => r.totals.llmCallsSkipped);
  const totalUseful = sum(sorted, (r) => r.effectiveness.usefulOutputScore);
  const maxUseful = Math.max(1, ...sorted.map((r) => r.effectiveness.usefulOutputScore));
  const maxCost = Math.max(0.000001, ...sorted.map((r) => r.totals.estimatedCostUsd));

  const rows = sorted.map((run) => {
    const phaseSummary = run.phases
      .map((p) => `${p.name}: ${p.status}, ${p.memoryIdsTouched.length} memories, ${p.llmCallsMade}/${p.llmCallsSkipped} calls`)
      .join("; ");
    const gateSummary = run.gates
      .map((g) => `${g.name}: ${g.passed ? "pass" : "skip"}${g.reason ? ` (${g.reason})` : ""}`)
      .join("; ");
    return `<tr>
      <td>${escapeHtml(run.startedAt)}</td>
      <td><span class="pill ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${escapeHtml(run.trigger)}</td>
      <td>${escapeHtml(run.provider)}${run.model ? `/${escapeHtml(run.model)}` : ""}</td>
      <td>${(run.durationMs / 1000).toFixed(1)}s</td>
      <td>${run.totals.llmCallsMade}</td>
      <td>${run.totals.llmCallsSkipped}</td>
      <td>${fmtMoney(run.totals.estimatedCostUsd)}</td>
      <td>${run.effectiveness.usefulOutputScore}</td>
      <td title="${escapeHtml(gateSummary)}">${escapeHtml(run.skipReason || phaseSummary || gateSummary || "—")}</td>
    </tr>`;
  }).join("\n");

  const chartRows = sorted.slice(0, 30).map((run) => `<div class="runChart">
    <div class="date">${escapeHtml(run.startedAt.slice(0, 16).replace("T", " "))}</div>
    <div>${bar(run.effectiveness.usefulOutputScore, maxUseful)}</div>
    <div>${bar(run.totals.estimatedCostUsd, maxCost)}</div>
  </div>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gnosys Dream Dashboard</title>
  <style>
    :root { color-scheme: light dark; --border: #8b949e55; --muted: #8b949e; --bg2: #8b949e18; }
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; }
    h1, h2 { margin: 0 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0; }
    .card { border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--bg2); }
    .metric { font-size: 28px; font-weight: 700; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border-bottom: 1px solid var(--border); padding: 8px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .pill { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; }
    .completed { color: #2da44e; }
    .skipped { color: #bf8700; }
    .failed, .aborted { color: #cf222e; }
    .runChart { display: grid; grid-template-columns: 160px 1fr 1fr; gap: 10px; align-items: center; margin: 7px 0; }
    .date { color: var(--muted); font-size: 12px; }
    .bar { height: 10px; border-radius: 999px; background: var(--bg2); overflow: hidden; }
    .bar span { display: block; height: 100%; background: currentColor; opacity: .65; }
    .hint { color: var(--muted); }
  </style>
</head>
<body>
  <h1>Gnosys Dream Dashboard</h1>
  <p class="hint">Generated from <code>~/.gnosys/dream-runs.jsonl</code>. Useful output is a weighted score: decay=1, summary generated=5, summary updated=3, relationship=2.</p>
  <section class="grid">
    <div class="card"><div class="label">Runs</div><div class="metric">${sorted.length}</div></div>
    <div class="card"><div class="label">Completed</div><div class="metric">${completed.length}</div></div>
    <div class="card"><div class="label">LLM Calls</div><div class="metric">${totalCalls}</div><div class="hint">${totalSkippedCalls} skipped</div></div>
    <div class="card"><div class="label">Estimated Cost</div><div class="metric">${fmtMoney(totalCost)}</div></div>
    <div class="card"><div class="label">Useful Output</div><div class="metric">${totalUseful}</div></div>
  </section>

  <h2>Recent Runs</h2>
  <div class="runChart"><div></div><div class="label">Useful output</div><div class="label">Cost</div></div>
  ${chartRows || "<p>No dream runs logged yet.</p>"}

  <h2>Run Details</h2>
  <table>
    <thead>
      <tr><th>Started</th><th>Status</th><th>Trigger</th><th>Model</th><th>Duration</th><th>Calls</th><th>Skipped</th><th>Cost</th><th>Useful</th><th>Notes</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

export async function runDreamReportCommand(opts: DreamReportOptions): Promise<void> {
  const limit = opts.last ? Math.max(1, parseInt(opts.last, 10) || 100) : undefined;
  const runs = readDreamRuns({ limit });
  const output = path.resolve(opts.output || "dream-dashboard.html");
  fs.writeFileSync(output, generateDreamDashboardHtml(runs), "utf8");
  console.log(`Wrote ${output}`);
}
