/**
 * Gnosys Portfolio — HTML Dashboard Generator
 *
 * Blockers-first, production-readiness-focused dashboard.
 * Self-contained HTML with embedded data and styling.
 */

import { PortfolioReport, ProjectSnapshot, ActionItem, STATUS_UPDATE_PROMPT } from "./portfolio.js";

// ─── Helpers ────────────────────────────────────────────────────────────

function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineMd(text: string): string {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

// ─── Colors ─────────────────────────────────────────────────────────────

const PALETTE = [
  { accent: "#4285f4", light: "#e8f0fe" },
  { accent: "#ea4335", light: "#fce8e6" },
  { accent: "#34a853", light: "#e6f4ea" },
  { accent: "#fbbc04", light: "#fef7e0" },
  { accent: "#a142f4", light: "#f3e8fd" },
  { accent: "#12b5cb", light: "#e8f7f5" },
  { accent: "#f439a0", light: "#fde7ef" },
  { accent: "#5c6bc0", light: "#e8eaf6" },
];

function readinessColor(score: number): string {
  if (score >= 90) return "#34a853";
  if (score >= 70) return "#4285f4";
  if (score >= 40) return "#fbbc04";
  return "#ea4335";
}

function actionIcon(type: string): { icon: string; color: string; label: string } {
  switch (type) {
    case "question": return { icon: "help", color: "#e37400", label: "Decision Needed" };
    case "blocker": return { icon: "block", color: "#d93025", label: "Blocker" };
    case "manual": return { icon: "build", color: "#1a73e8", label: "Manual Step" };
    case "decision": return { icon: "gavel", color: "#8430ce", label: "Decision Needed" };
    default: return { icon: "flag", color: "#5f6368", label: "Action" };
  }
}

// ─── Generators ─────────────────────────────────────────────────────────

function generateActionCard(item: ActionItem): string {
  const a = actionIcon(item.type);
  return `
    <div class="action-card" data-project="${esc(item.projectName)}">
      <div class="action-icon" style="background:${a.color}">
        <span class="material-icons-outlined">${a.icon}</span>
      </div>
      <div class="action-body">
        <div class="action-text">${inlineMd(item.text)}</div>
        <div class="action-meta">
          <span class="action-project">${esc(item.projectName)}</span>
          <span class="action-type">${a.label}</span>
        </div>
      </div>
    </div>`;
}

function generateReadinessRing(score: number, size: number = 56): string {
  const r = (size - 6) / 2;
  const c = Math.PI * 2 * r;
  const offset = c - (score / 100) * c;
  const color = readinessColor(score);
  return `
    <svg width="${size}" height="${size}" class="ring">
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--border)" stroke-width="5"/>
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}" stroke-width="5"
              stroke-dasharray="${c}" stroke-dashoffset="${offset}"
              stroke-linecap="round" transform="rotate(-90 ${size/2} ${size/2})"
              style="transition:stroke-dashoffset 0.8s ease"/>
      <text x="${size/2}" y="${size/2}" text-anchor="middle" dy="0.35em"
            fill="${color}" font-size="13" font-weight="700" font-family="Inter,sans-serif">${score}%</text>
    </svg>`;
}

function generateBlockingList(snap: ProjectSnapshot): string {
  if (snap.readiness.blocking.length === 0 && snap.actionItems.length === 0) return "";

  const items: string[] = [];

  // Action items first (questions, blockers, manual steps)
  for (const a of snap.actionItems) {
    const ai = actionIcon(a.type);
    items.push(`
      <div class="block-item">
        <span class="material-icons-outlined" style="color:${ai.color};font-size:1rem">${ai.icon}</span>
        <span>${inlineMd(a.text)}</span>
      </div>`);
  }

  // Then blocking items from status that aren't already covered
  const actionTexts = new Set(snap.actionItems.map((a) => a.text.toLowerCase().slice(0, 40)));
  for (const b of snap.readiness.blocking) {
    if (actionTexts.has(b.toLowerCase().slice(0, 40))) continue;
    items.push(`
      <div class="block-item">
        <span class="material-icons-outlined" style="color:var(--text-secondary);font-size:1rem">arrow_forward</span>
        <span>${inlineMd(b)}</span>
      </div>`);
  }

  if (items.length === 0) return "";

  return `
    <div class="section blockers-section">
      <h4><span class="material-icons-outlined">priority_high</span> Blocking Go-Live</h4>
      ${items.join("\n")}
    </div>`;
}

function generateDoneList(snap: ProjectSnapshot): string {
  if (snap.readiness.done.length === 0) return "";
  const items = snap.readiness.done.slice(0, 12).map((d) =>
    `<div class="done-item"><span class="material-icons-outlined">check_circle</span><span>${inlineMd(d)}</span></div>`
  ).join("\n");
  return `
    <div class="section done-section">
      <h4><span class="material-icons-outlined">check_circle</span> Completed</h4>
      ${items}
    </div>`;
}

function generateCategoryBars(snap: ProjectSnapshot, accent: string): string {
  const cats = Object.entries(snap.memoryCounts.byCategory).sort((a, b) => b[1] - a[1]);
  const max = cats[0]?.[1] || 1;
  return cats.map(([cat, count]) => {
    const pct = Math.round((count / max) * 100);
    return `<div class="cat-row">
      <span class="cat-label">${esc(cat)}</span>
      <div class="cat-track"><div class="cat-fill" style="width:${pct}%;background:${accent}"></div></div>
      <span class="cat-count">${count}</span>
    </div>`;
  }).join("\n");
}

function generateRoadmap(snap: ProjectSnapshot): string {
  if (snap.roadmap.length === 0) return "";
  const items = snap.roadmap.map((r) =>
    `<div class="road-item"><span class="material-icons-outlined">flag</span>
     <div><strong>${esc(r.title)}</strong> <span class="mem-id">${esc(r.id)}</span></div></div>`
  ).join("\n");
  return `<div class="section"><h4><span class="material-icons-outlined">map</span> Roadmap</h4>${items}</div>`;
}

function generateActivity(snap: ProjectSnapshot, accent: string): string {
  if (snap.recentActivity.length === 0) return "";
  const items = snap.recentActivity.slice(0, 5).map((a) =>
    `<div class="act-item">
      <span class="act-cat" style="background:${accent}">${esc(a.category)}</span>
      <span class="act-title">${esc(a.title)}</span>
      <span class="act-date">${a.modified.split("T")[0]}</span>
    </div>`
  ).join("\n");
  return `<div class="section"><h4><span class="material-icons-outlined">history</span> Recent Activity</h4>${items}</div>`;
}

function generateProjectCard(snap: ProjectSnapshot, index: number): string {
  const c = PALETTE[index % PALETTE.length];
  const hasBlockers = snap.actionItems.length > 0 || snap.readiness.blocking.length > 0;
  const blockerCount = snap.actionItems.length + snap.readiness.blocking.length;

  return `
    <div class="project-card${hasBlockers ? " has-blockers" : ""}" id="proj-${esc(snap.project.name)}" data-project="${esc(snap.project.name)}">
      <div class="card-head" style="border-left:4px solid ${c.accent}" onclick="toggle(this)">
        <div class="card-head-left">
          ${generateReadinessRing(snap.readiness.score)}
          <div>
            <h3 style="color:${c.accent}">${esc(snap.project.name)}</h3>
            <div class="card-label">${snap.readiness.label}${hasBlockers ? ` &mdash; <strong style="color:#d93025">${blockerCount} blocker${blockerCount !== 1 ? "s" : ""}</strong>` : ""}</div>
          </div>
        </div>
        <div class="card-head-right">
          <div class="mini-stats">
            <span title="Memories"><span class="material-icons-outlined">memory</span>${snap.memoryCounts.total}</span>
            <span title="Roadmap"><span class="material-icons-outlined">map</span>${snap.roadmap.length}</span>
            <span title="Recent 7d"><span class="material-icons-outlined">update</span>${snap.recentActivity.length}</span>
          </div>
          <span class="material-icons-outlined chevron">expand_more</span>
        </div>
      </div>
      <div class="card-body">
        ${generateBlockingList(snap)}
        <div class="card-cols">
          <div class="card-col">
            ${generateDoneList(snap)}
            <div class="section">
              <h4><span class="material-icons-outlined">bar_chart</span> Categories</h4>
              ${generateCategoryBars(snap, c.accent)}
            </div>
          </div>
          <div class="card-col">
            ${generateRoadmap(snap)}
            ${generateActivity(snap, c.accent)}
          </div>
        </div>
      </div>
    </div>`;
}

// ─── Main ───────────────────────────────────────────────────────────────

export function generatePortfolioHtml(report: PortfolioReport, outputPath?: string): string {
  const homeDir = process.env.HOME || "~";
  const dashboardPath = outputPath || `${homeDir}/gnosys-dashboard.html`;
  const regenCmd = `gnosys portfolio --output ${dashboardPath} && open ${dashboardPath}`;
  const cards = report.projects.map((s, i) => generateProjectCard(s, i)).join("\n");
  const totalBlockers = report.projects.reduce((s, p) => s + p.actionItems.length + p.readiness.blocking.length, 0);
  const totalQuestions = report.allActionItems.filter((a) => a.type === "question" || a.type === "decision").length;
  const avgReadiness = report.projects.length > 0
    ? Math.round(report.projects.reduce((s, p) => s + p.readiness.score, 0) / report.projects.length)
    : 0;

  const actionCards = report.allActionItems.map((a) => generateActionCard(a)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gnosys Portfolio</title>
<link href="https://fonts.googleapis.com/icon?family=Material+Icons+Outlined" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f5f6f8;--surface:#fff;--text:#1a1a2e;--text2:#5f6368;--border:#e2e4e9;--shadow:0 1px 3px rgba(0,0,0,.06);--shadow2:0 4px 16px rgba(0,0,0,.08);--radius:10px}
@media(prefers-color-scheme:dark){:root{--bg:#121220;--surface:#1e1e36;--text:#e4e4f0;--text2:#8e8ea8;--border:#2e2e4a;--shadow:0 1px 3px rgba(0,0,0,.3);--shadow2:0 4px 16px rgba(0,0,0,.4)}}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
code{font-family:'JetBrains Mono',monospace;font-size:.75rem;background:var(--border);padding:.1rem .3rem;border-radius:3px}

/* ── Hero ── */
.hero{background:linear-gradient(135deg,#0f0f2d 0%,#1a1a4a 50%,#0f0f2d 100%);color:#fff;padding:2rem 2rem 1.75rem}
.hero-inner{max-width:1100px;margin:0 auto}
.hero h1{font-size:1.5rem;font-weight:700;letter-spacing:-.02em}
.hero .sub{color:#8e8ea8;font-size:.8rem;margin-bottom:1.25rem}
.hero-stats{display:flex;gap:.5rem;flex-wrap:wrap}
.hero-stat{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:.6rem 1rem;display:flex;align-items:center;gap:.5rem;cursor:pointer;transition:all .15s;user-select:none}
.hero-stat:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2)}
.hero-stat.active{background:rgba(100,130,255,.15);border-color:rgba(100,130,255,.4)}
.hero-stat .material-icons-outlined{font-size:1.1rem}
.hero-stat .val{font-size:1.3rem;font-weight:700}
.hero-stat label{font-size:.65rem;text-transform:uppercase;letter-spacing:.04em;color:#8e8ea8}
.stat-alert .val{color:#ff6b6b}
.stat-alert .material-icons-outlined{color:#ff6b6b}
.stat-ok .val{color:#4ade80}
.stat-ok .material-icons-outlined{color:#4ade80}
.stat-warn .val{color:#fbbf24}
.stat-warn .material-icons-outlined{color:#fbbf24}

/* ── Container ── */
.container{max-width:1100px;margin:0 auto;padding:1rem 2rem 3rem}
@media(max-width:768px){.container{padding:1rem}}

/* ── Attention panel ── */
.attention{margin-bottom:1.5rem;display:none}
.attention.visible{display:block}
.attention h2{font-size:.9rem;font-weight:600;color:var(--text2);margin-bottom:.75rem;display:flex;align-items:center;gap:.35rem}
.attention h2 .material-icons-outlined{font-size:1.1rem;color:#d93025}
.action-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:.5rem}
.action-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.65rem .8rem;display:flex;gap:.6rem;align-items:flex-start;transition:box-shadow .15s;cursor:pointer}
.action-card:hover{box-shadow:var(--shadow2)}
.action-icon{width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.action-icon .material-icons-outlined{font-size:.95rem;color:#fff}
.action-body{flex:1;min-width:0}
.action-text{font-size:.8rem;line-height:1.4}
.action-meta{display:flex;gap:.5rem;margin-top:.25rem;font-size:.65rem;color:var(--text2)}
.action-project{font-weight:600}
.action-type{font-family:'JetBrains Mono',monospace;text-transform:uppercase;font-size:.6rem;letter-spacing:.03em}

/* ── Readiness bar ── */
.readiness-bar{margin-bottom:1.5rem}
.readiness-bar h2{font-size:.9rem;font-weight:600;color:var(--text2);margin-bottom:.75rem;display:flex;align-items:center;gap:.35rem}
.readiness-bar h2 .material-icons-outlined{font-size:1.1rem}
.readiness-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.5rem}
.readiness-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.75rem;text-align:center;cursor:pointer;transition:all .15s}
.readiness-card:hover{box-shadow:var(--shadow2);transform:translateY(-1px)}
.readiness-card h4{font-size:.8rem;margin-top:.35rem;font-weight:600}
.readiness-card .label{font-size:.7rem;color:var(--text2)}
.ring{display:block;margin:0 auto}

/* ── Project Cards ── */
.project-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:.75rem;overflow:hidden;transition:box-shadow .15s}
.project-card:hover{box-shadow:var(--shadow2)}
.project-card.has-blockers{border-color:#fca5a5}
@media(prefers-color-scheme:dark){.project-card.has-blockers{border-color:#7f1d1d}}

.card-head{display:flex;align-items:center;justify-content:space-between;padding:.75rem 1rem;cursor:pointer;user-select:none}
.card-head-left{display:flex;align-items:center;gap:.75rem}
.card-head-left h3{font-size:1rem;font-weight:600}
.card-label{font-size:.75rem;color:var(--text2)}
.card-head-right{display:flex;align-items:center;gap:.75rem}
.mini-stats{display:flex;gap:.75rem;font-size:.75rem;color:var(--text2)}
.mini-stats span{display:flex;align-items:center;gap:.2rem}
.mini-stats .material-icons-outlined{font-size:.9rem}
.chevron{color:var(--text2);transition:transform .25s;font-size:1.3rem}
.project-card.expanded .chevron{transform:rotate(180deg)}

.card-body{max-height:0;overflow:hidden;transition:max-height .35s ease}
.project-card.expanded .card-body{max-height:5000px}

.card-cols{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;padding:0 1rem 1rem}
@media(max-width:768px){.card-cols{grid-template-columns:1fr}}

/* ── Blockers section (inside card) ── */
.blockers-section{background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:.75rem;margin:0 1rem .75rem}
@media(prefers-color-scheme:dark){.blockers-section{background:#2a1215;border-color:#7f1d1d}}
.blockers-section h4{color:#d93025}

/* ── Sections ── */
.section{margin-bottom:1rem}
.section h4{font-size:.8rem;font-weight:600;color:var(--text2);margin-bottom:.5rem;display:flex;align-items:center;gap:.3rem}
.section h4 .material-icons-outlined{font-size:.95rem}
.block-item{display:flex;align-items:flex-start;gap:.4rem;padding:.25rem 0;font-size:.78rem;line-height:1.4}
.done-item{display:flex;align-items:flex-start;gap:.4rem;padding:.2rem 0;font-size:.75rem;color:var(--text2)}
.done-item .material-icons-outlined{font-size:.9rem;color:#34a853;flex-shrink:0;margin-top:1px}
.done-section{max-height:200px;overflow-y:auto}

/* ── Category bars ── */
.cat-row{display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem;font-size:.75rem}
.cat-label{width:100px;flex-shrink:0;text-align:right;color:var(--text2);font-family:'JetBrains Mono',monospace;font-size:.7rem}
.cat-track{flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden}
.cat-fill{height:100%;border-radius:3px;transition:width .6s ease}
.cat-count{width:22px;text-align:right;font-weight:600;font-size:.7rem;font-family:'JetBrains Mono',monospace}

/* ── Roadmap/Activity ── */
.road-item{display:flex;align-items:flex-start;gap:.4rem;padding:.3rem 0;font-size:.78rem}
.road-item .material-icons-outlined{font-size:.95rem;color:#1a73e8;flex-shrink:0;margin-top:1px}
.mem-id{font-family:'JetBrains Mono',monospace;font-size:.6rem;color:var(--text2);margin-left:.3rem}
.act-item{display:flex;align-items:center;gap:.4rem;padding:.2rem 0;font-size:.75rem}
.act-cat{font-size:.55rem;color:#fff;padding:.1rem .35rem;border-radius:3px;flex-shrink:0;font-family:'JetBrains Mono',monospace;text-transform:uppercase}
.act-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.act-date{font-family:'JetBrains Mono',monospace;font-size:.65rem;color:var(--text2);flex-shrink:0}

.footer{text-align:center;padding:1.5rem;font-size:.7rem;color:var(--text2)}

/* ── Prompt panel ── */
.prompt-box{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:1rem;font-family:'JetBrains Mono',monospace;font-size:.72rem;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;color:var(--text)}
.prompt-hint{font-size:.75rem;color:var(--text2);margin-top:.5rem}
.prompt-hint code{font-size:.7rem}
.copy-btn{background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;padding:.15rem .3rem;margin-left:.5rem;color:var(--text2);vertical-align:middle;transition:all .15s}
.copy-btn:hover{border-color:var(--text);color:var(--text)}
.copy-btn .material-icons-outlined{font-size:.9rem}

/* ── Regen spinner ── */
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.spinning{animation:spin .8s linear infinite}
</style>
</head>
<body>

<div class="hero">
  <div class="hero-inner">
    <h1>Gnosys Portfolio</h1>
    <p class="sub">Updated ${esc(report.generated)}</p>
    <div class="hero-stats">
      <div class="hero-stat ${totalBlockers > 0 ? "stat-alert" : "stat-ok"}" onclick="togglePanel('attention')" title="Click to show/hide action items">
        <span class="material-icons-outlined">${totalBlockers > 0 ? "warning" : "check_circle"}</span>
        <span class="val">${totalBlockers}</span>
        <label>Blockers</label>
      </div>
      <div class="hero-stat ${totalQuestions > 0 ? "stat-warn" : "stat-ok"}" onclick="filterByType('question')" title="Click to show open questions">
        <span class="material-icons-outlined">help</span>
        <span class="val">${totalQuestions}</span>
        <label>Questions</label>
      </div>
      <div class="hero-stat" onclick="togglePanel('readiness-section')">
        <span class="material-icons-outlined">speed</span>
        <span class="val">${avgReadiness}%</span>
        <label>Avg Ready</label>
      </div>
      <div class="hero-stat">
        <span class="material-icons-outlined">folder_open</span>
        <span class="val">${report.totalProjects}</span>
        <label>Projects</label>
      </div>
      <div class="hero-stat">
        <span class="material-icons-outlined">memory</span>
        <span class="val">${report.totalMemories}</span>
        <label>Memories</label>
      </div>
      <div class="hero-stat" onclick="regenerate()" title="Regenerate this dashboard" style="margin-left:auto">
        <span class="material-icons-outlined" id="regen-icon">refresh</span>
        <label>Regenerate</label>
      </div>
      <div class="hero-stat" onclick="togglePanel('prompt-panel')" title="Show status update prompt for AI agents">
        <span class="material-icons-outlined">terminal</span>
        <label>AI Prompt</label>
      </div>
    </div>
  </div>
</div>

<div class="container">

  <!-- Attention Panel (toggled by hero stat) -->
  <div class="attention${report.allActionItems.length > 0 ? " visible" : ""}" id="attention">
    <h2><span class="material-icons-outlined">notification_important</span> Needs Your Attention</h2>
    <div class="action-grid">
      ${actionCards}
    </div>
  </div>

  <!-- AI Status Prompt Panel -->
  <div class="attention" id="prompt-panel">
    <h2><span class="material-icons-outlined">terminal</span> AI Status Update Prompt <button class="copy-btn" onclick="copyPrompt()" title="Copy to clipboard"><span class="material-icons-outlined">content_copy</span></button></h2>
    <pre class="prompt-box" id="status-prompt">${esc(STATUS_UPDATE_PROMPT)}</pre>
    <p class="prompt-hint">Give this prompt to any AI agent working in a project. It will generate a dashboard-compatible status memory via <code>gnosys_add_structured</code>. You can also run <code>gnosys update-status</code> in a project directory to get a project-specific version.</p>
  </div>

  <!-- Readiness Overview -->
  <div class="readiness-bar" id="readiness-section">
    <h2><span class="material-icons-outlined">speed</span> Production Readiness</h2>
    <div class="readiness-grid">
      ${report.projects.map((s, i) => `
        <div class="readiness-card" onclick="scrollToProject('${esc(s.project.name)}')">
          ${generateReadinessRing(s.readiness.score)}
          <h4>${esc(s.project.name)}</h4>
          <div class="label">${s.readiness.label}</div>
        </div>`).join("\n")}
    </div>
  </div>

  <!-- Project Cards -->
  ${cards}

</div>

<div class="footer">
  Powered by <strong>Gnosys</strong> &mdash; ${report.totalMemories} memories across ${report.totalProjects} projects
</div>

<script>
function toggle(el){el.closest('.project-card').classList.toggle('expanded')}

function togglePanel(id){
  const el=document.getElementById(id);
  if(el)el.classList.toggle('visible');
}

function regenerate(){
  const icon=document.getElementById('regen-icon');
  icon.classList.add('spinning');
  // Copy the regenerate command to clipboard so user can paste in terminal
  const cmd='${esc(regenCmd)}';
  navigator.clipboard.writeText(cmd).then(()=>{
    icon.textContent='check';
    icon.classList.remove('spinning');
    setTimeout(()=>{icon.textContent='refresh'},2000);
    // Show a brief toast
    const toast=document.createElement('div');
    toast.style.cssText='position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:.5rem 1rem;border-radius:8px;font-size:.8rem;z-index:999;box-shadow:0 4px 12px rgba(0,0,0,.3)';
    toast.textContent='Regenerate command copied to clipboard — paste in terminal';
    document.body.appendChild(toast);
    setTimeout(()=>toast.remove(),3500);
  });
}

function copyPrompt(){
  const text=document.getElementById('status-prompt').textContent;
  navigator.clipboard.writeText(text).then(()=>{
    const toast=document.createElement('div');
    toast.style.cssText='position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:.5rem 1rem;border-radius:8px;font-size:.8rem;z-index:999;box-shadow:0 4px 12px rgba(0,0,0,.3)';
    toast.textContent='Status update prompt copied to clipboard';
    document.body.appendChild(toast);
    setTimeout(()=>toast.remove(),2500);
  });
}

function scrollToProject(name){
  const card=document.getElementById('proj-'+name);
  if(!card)return;
  card.classList.add('expanded');
  card.scrollIntoView({behavior:'smooth',block:'start'});
  card.style.outline='2px solid #4285f4';
  setTimeout(()=>card.style.outline='',2000);
}

function filterByType(type){
  // Show attention panel
  const panel=document.getElementById('attention');
  panel.classList.add('visible');

  // Expand projects that have this type of action item
  document.querySelectorAll('.project-card').forEach(c=>{
    const name=c.dataset.project;
    const hasType=document.querySelector('.action-card[data-project="'+name+'"]');
    if(hasType)c.classList.add('expanded');
  });

  // Highlight matching action cards
  document.querySelectorAll('.action-card').forEach(c=>{
    c.style.outline='none';
  });

  // Scroll to attention panel
  panel.scrollIntoView({behavior:'smooth',block:'start'});
}

// Click action card → scroll to that project
document.querySelectorAll('.action-card').forEach(card=>{
  card.addEventListener('click',()=>{
    const name=card.dataset.project;
    scrollToProject(name);
  });
});

// Auto-expand projects with blockers on load
document.querySelectorAll('.project-card.has-blockers').forEach(c=>c.classList.add('expanded'));
</script>
</body>
</html>`;
}
