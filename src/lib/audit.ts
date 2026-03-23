/**
 * Gnosys Audit — Structured JSON logging for every memory operation.
 *
 * Provides observability for enterprise agent systems. Every read, write,
 * reinforce, dearchive, and recall operation is logged with timestamps
 * and optional traceIds for correlation with the outer orchestrator.
 *
 * Logs are stored in .gnosys/.config/audit.jsonl (append-only).
 */

import fs from "fs";
import path from "path";

// ─── Types ──────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  operation: AuditOperation;
  memoryId?: string;
  memoryTitle?: string;
  query?: string;
  resultCount?: number;
  durationMs?: number;
  traceId?: string;
  details?: Record<string, unknown>;
}

export type AuditOperation =
  | "read"
  | "write"
  | "update"
  | "delete"
  | "reinforce"
  | "dearchive"
  | "archive"
  | "maintain"
  | "search"
  | "ask"
  | "recall"
  | "consolidate"
  | "decay";

// ─── Module State ───────────────────────────────────────────────────────

let auditFilePath: string | null = null;
let auditStream: fs.WriteStream | null = null;

/**
 * Initialize the audit log for a specific store path.
 * Creates .gnosys/.config/audit.jsonl if it doesn't exist.
 */
export function initAudit(storePath: string): void {
  const configDir = path.join(storePath, ".config");

  // Ensure .config dir exists (sync — called once at startup)
  try {
    fs.mkdirSync(configDir, { recursive: true });
  } catch {
    // Already exists
  }

  auditFilePath = path.join(configDir, "audit.jsonl");

  // Open append-only write stream
  auditStream = fs.createWriteStream(auditFilePath, { flags: "a" });
}

/**
 * Log an audit entry. Fire-and-forget — never blocks the caller.
 */
export function auditLog(
  entry: Omit<AuditEntry, "timestamp">
): void {
  const full: AuditEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  if (auditStream && !auditStream.destroyed) {
    auditStream.write(JSON.stringify(full) + "\n");
  }
}

/**
 * Read audit entries, optionally filtered by days.
 */
export function readAuditLog(
  storePath: string,
  options?: { days?: number; operation?: AuditOperation; limit?: number }
): AuditEntry[] {
  const logPath = path.join(storePath, ".config", "audit.jsonl");

  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.trim().split("\n").filter(Boolean);
  let entries: AuditEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // Skip malformed lines
    }
  }

  // Filter by days
  if (options?.days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - options.days);
    const cutoffStr = cutoff.toISOString();
    entries = entries.filter((e) => e.timestamp >= cutoffStr);
  }

  // Filter by operation
  if (options?.operation) {
    entries = entries.filter((e) => e.operation === options.operation);
  }

  // Limit (take most recent)
  if (options?.limit) {
    entries = entries.slice(-options.limit);
  }

  return entries;
}

/**
 * Format audit entries as a human-readable timeline.
 */
export function formatAuditTimeline(entries: AuditEntry[]): string {
  if (entries.length === 0) {
    return "No audit entries found for the specified period.";
  }

  const lines: string[] = [
    `Gnosys Audit Trail — ${entries.length} operations`,
    "═".repeat(60),
    "",
  ];

  // Group by date
  const byDate = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const date = entry.timestamp.split("T")[0];
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(entry);
  }

  for (const [date, dayEntries] of byDate) {
    lines.push(`── ${date} (${dayEntries.length} ops) ──`);
    for (const e of dayEntries) {
      const time = e.timestamp.split("T")[1]?.split(".")[0] || "";
      const duration = e.durationMs ? ` (${e.durationMs.toFixed(1)}ms)` : "";
      const trace = e.traceId ? ` [trace:${e.traceId.substring(0, 8)}]` : "";
      const memory = e.memoryId ? ` → ${e.memoryId}` : "";
      const query = e.query ? ` q="${e.query.substring(0, 30)}"` : "";
      const count = e.resultCount !== undefined ? ` (${e.resultCount} results)` : "";

      lines.push(`  ${time}  ${e.operation.toUpperCase().padEnd(12)}${memory}${query}${count}${duration}${trace}`);
    }
    lines.push("");
  }

  // Summary
  const opCounts = new Map<string, number>();
  for (const e of entries) {
    opCounts.set(e.operation, (opCounts.get(e.operation) || 0) + 1);
  }
  lines.push("Summary:");
  for (const [op, count] of [...opCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${op}: ${count}`);
  }

  return lines.join("\n");
}

/**
 * Close the audit stream cleanly.
 */
export function closeAudit(): void {
  if (auditStream && !auditStream.destroyed) {
    auditStream.end();
    auditStream = null;
  }
}
