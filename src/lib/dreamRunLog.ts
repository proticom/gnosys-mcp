import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { DbMemory } from "./db.js";
import type { DreamConfig } from "./config.js";
import { getGnosysHome } from "./paths.js";

export type DreamTrigger = "manual" | "scheduled";
export type DreamRunStatus = "completed" | "skipped" | "aborted" | "failed";

export interface DreamRunGateResult {
  name: "designation" | "night-window" | "system-idle" | "dreamworthiness" | "lock";
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface DreamRunPhaseRecord {
  name: "decay" | "critique" | "summaries" | "relationships";
  status: "ran" | "skipped";
  reason?: string;
  durationMs: number;
  memoryIdsTouched: string[];
  llmCallsMade: number;
  llmCallsSkipped: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}

export interface DreamLLMCallRecord {
  phase: DreamRunPhaseRecord["name"];
  label: string;
  status: "made" | "skipped" | "failed";
  reason?: string;
  model: string;
  provider: string;
  memoryIds: string[];
  fingerprint?: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}

export interface DreamEffectivenessRecord {
  usefulOutputScore: number;
  costPerUsefulOutput: number | null;
  decaysApplied: number;
  summariesGenerated: number;
  summariesUpdated: number;
  reviewSuggestions: number;
  relationshipsDiscovered: number;
}

export interface DreamRunRecord {
  id: string;
  trigger: DreamTrigger;
  status: DreamRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  machine: {
    hostname: string;
    machineId?: string;
  };
  provider: string;
  model?: string;
  gates: DreamRunGateResult[];
  phases: DreamRunPhaseRecord[];
  llmCalls: DreamLLMCallRecord[];
  totals: {
    llmCallsMade: number;
    llmCallsSkipped: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostUsd: number;
  };
  effectiveness: DreamEffectivenessRecord;
  errors: string[];
  skipReason?: string;
}

export interface DreamState {
  lastRunAt?: string;
  lastSuccessfulRunAt?: string;
  lastMemoryMaxModified?: string;
  lastMemoryCount?: number;
  analyzedFingerprints: Record<string, {
    kind: "summary" | "critique" | "relationship";
    lastAnalyzedAt: string;
    memoryIds: string[];
  }>;
}

export interface DreamReadOptions {
  limit?: number;
  sinceIso?: string;
  status?: DreamRunStatus;
}

const DEFAULT_STATE: DreamState = {
  analyzedFingerprints: {},
};

const MODEL_PRICES_USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  "grok-4.3": { input: 3, output: 15 },
  "grok-4.20": { input: 3, output: 15 },
  "grok-4": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-5.4-mini": { input: 0.25, output: 2 },
  "gpt-5.4-nano": { input: 0.05, output: 0.4 },
  "mistral-small-4": { input: 0.2, output: 0.6 },
};

export function getDreamRunsPath(): string {
  return path.join(getGnosysHome(), "dream-runs.jsonl");
}

export function getDreamStatePath(): string {
  return path.join(getGnosysHome(), "dream-state.json");
}

export function getDreamLockPath(): string {
  return path.join(getGnosysHome(), "dream.lock");
}

export function acquireDreamLock(): { acquired: true; release: () => void } | { acquired: false; reason: string } {
  const lockPath = getDreamLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return {
      acquired: true,
      release: () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Best effort: stale lock cleanup happens on the next acquire.
        }
      },
    };
  } catch {
    try {
      const raw = fs.readFileSync(lockPath, "utf8");
      const parsed = JSON.parse(raw) as { pid?: number; startedAt?: string };
      if (parsed.pid && !isProcessRunning(parsed.pid)) {
        fs.unlinkSync(lockPath);
        return acquireDreamLock();
      }
      return { acquired: false, reason: `dream already running (pid ${parsed.pid || "unknown"})` };
    } catch {
      return { acquired: false, reason: "dream already running (lock exists)" };
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCost(model: string | undefined, inputTokens: number, outputTokens: number): number {
  const key = (model || "").toLowerCase();
  const exact = MODEL_PRICES_USD_PER_MILLION[key];
  const fuzzy = exact ?? Object.entries(MODEL_PRICES_USD_PER_MILLION).find(([m]) => key.includes(m))?.[1];
  if (!fuzzy) return 0;
  const cost = (inputTokens / 1_000_000) * fuzzy.input + (outputTokens / 1_000_000) * fuzzy.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function readDreamState(): DreamState {
  try {
    const raw = fs.readFileSync(getDreamStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DreamState>;
    return {
      ...DEFAULT_STATE,
      ...parsed,
      analyzedFingerprints: parsed.analyzedFingerprints ?? {},
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeDreamState(state: DreamState): void {
  const file = getDreamStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function appendDreamRun(record: DreamRunRecord): void {
  const file = getDreamRunsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

export function readDreamRuns(opts: DreamReadOptions = {}): DreamRunRecord[] {
  const file = getDreamRunsPath();
  if (!fs.existsSync(file)) return [];
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : null;
  const rows = fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as DreamRunRecord;
      } catch {
        return null;
      }
    })
    .filter((row): row is DreamRunRecord => !!row)
    .filter((row) => !opts.status || row.status === opts.status)
    .filter((row) => sinceMs == null || Date.parse(row.startedAt) >= sinceMs)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return typeof opts.limit === "number" ? rows.slice(0, opts.limit) : rows;
}

export function fingerprintMemories(kind: "summary" | "critique" | "relationship", memories: DbMemory[]): string {
  const material = memories
    .map((m) => `${m.id}:${m.modified}:${m.content_hash || ""}`)
    .sort()
    .join("|");
  return `${kind}:${crypto.createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

export function memoryWatermark(memories: DbMemory[]): { count: number; maxModified: string | undefined } {
  const maxModified = memories
    .map((m) => m.modified || m.created)
    .filter(Boolean)
    .sort()
    .at(-1);
  return { count: memories.length, maxModified };
}

export function countChangedMemoriesSince(memories: DbMemory[], sinceIso?: string): number {
  if (!sinceIso) return memories.length;
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return memories.length;
  return memories.filter((m) => Date.parse(m.modified || m.created) > sinceMs).length;
}

export function isInsideNightWindow(now: Date, schedule: DreamConfig["schedule"]): boolean {
  const start = schedule.startHour;
  const end = schedule.endHour;
  const hour = now.getHours();
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function getSystemIdleMinutes(): number | null {
  if (process.platform !== "darwin") return null;
  try {
    const output = execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8", timeout: 2000 });
    const match = output.match(/HIDIdleTime"\s*=\s*(\d+)/);
    if (!match) return null;
    const nanoseconds = Number(match[1]);
    return nanoseconds / 1_000_000_000 / 60;
  } catch {
    return null;
  }
}

export function createSkipRunRecord(input: {
  trigger: DreamTrigger;
  startedAt: string;
  finishedAt?: string;
  provider: string;
  model?: string;
  gates: DreamRunGateResult[];
  reason: string;
  machineId?: string;
}): DreamRunRecord {
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  return {
    id: `dream-${Date.parse(input.startedAt)}-${Math.random().toString(36).slice(2, 8)}`,
    trigger: input.trigger,
    status: "skipped",
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(input.startedAt)),
    machine: { hostname: os.hostname(), machineId: input.machineId },
    provider: input.provider,
    model: input.model,
    gates: input.gates,
    phases: [],
    llmCalls: [],
    totals: {
      llmCallsMade: 0,
      llmCallsSkipped: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
    },
    effectiveness: {
      usefulOutputScore: 0,
      costPerUsefulOutput: null,
      decaysApplied: 0,
      summariesGenerated: 0,
      summariesUpdated: 0,
      reviewSuggestions: 0,
      relationshipsDiscovered: 0,
    },
    errors: [],
    skipReason: input.reason,
  };
}
