/**
 * CC.2 — coverage for dream.ts (orchestrator, phases, formatDreamReport, DreamScheduler).
 * NEW file only; does not modify existing dream*.test.ts files.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { GnosysDB, type DbMemory } from "../lib/db.js";
import type { GnosysConfig } from "../lib/config.js";
import {
  GnosysDreamEngine,
  DreamScheduler,
  DEFAULT_DREAM_CONFIG,
  formatDreamReport,
  type DreamReport,
} from "../lib/dream.js";
import { createProvider, getLLMProvider } from "../lib/llm.js";
import { notifyDesktop } from "../lib/desktopNotify.js";
import { makeMemory } from "./_helpers.js";

const mockGenerate = vi.fn();
const fakeProvider = {
  name: "ollama" as const,
  model: "stub",
  generate: mockGenerate,
  testConnection: async () => true,
};

vi.mock("../lib/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/llm.js")>();
  return {
    ...actual,
    getLLMProvider: vi.fn(() => fakeProvider),
    createProvider: vi.fn(() => fakeProvider),
  };
});

vi.mock("../lib/desktopNotify.js", () => ({
  notifyDesktop: vi.fn().mockResolvedValue(undefined),
}));

function baseConfig(): GnosysConfig {
  return { llm: { defaultProvider: "anthropic" }, dream: { enabled: true } } as unknown as GnosysConfig;
}

const decayOnlyDream = {
  enabled: true,
  minMemories: 3,
  selfCritique: false,
  generateSummaries: false,
  discoverRelationships: false,
};

function insertMemory(db: GnosysDB, overrides: Partial<DbMemory> = {}): void {
  const mem = makeMemory(overrides);
  db.insertMemory(mem);
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function todayIso(): string {
  return new Date().toISOString().split("T")[0] + "T12:00:00.000Z";
}

let tmp: string;
let db: GnosysDB;
let prevGnosysHome: string | undefined;

beforeEach(() => {
  vi.mocked(getLLMProvider).mockImplementation(() => fakeProvider);
  vi.mocked(createProvider).mockImplementation(() => fakeProvider);
  mockGenerate.mockReset();
  vi.mocked(notifyDesktop).mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-dream-cov-"));
  // Isolate dream-runs.jsonl / dream-state.json from the real ~/.gnosys.
  prevGnosysHome = process.env.GNOSYS_HOME;
  process.env.GNOSYS_HOME = tmp;
  db = new GnosysDB(tmp);
});

afterEach(() => {
  db.close();
  if (prevGnosysHome === undefined) {
    delete process.env.GNOSYS_HOME;
  } else {
    process.env.GNOSYS_HOME = prevGnosysHome;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("GnosysDreamEngine.dream() orchestrator", () => {
  it("exits early when DB is unavailable", async () => {
    vi.spyOn(db, "isAvailable").mockReturnValue(false);
    const engine = new GnosysDreamEngine(db, baseConfig(), decayOnlyDream);
    const report = await engine.dream();
    expect(report.errors).toContain("gnosys.db not available or not migrated");
    expect(report.decayUpdated).toBe(0);
  });

  it("exits early when too few memories", async () => {
    insertMemory(db);
    insertMemory(db);
    const engine = new GnosysDreamEngine(db, baseConfig(), { ...decayOnlyDream, minMemories: 10 });
    const report = await engine.dream();
    expect(report.errors[0]).toMatch(/Too few memories/);
  });

  it("records provider-init error and increments consecutive failures", async () => {
    vi.mocked(createProvider).mockImplementationOnce(() => {
      throw new Error("no key");
    });
    for (let i = 0; i < 5; i++) insertMemory(db, { id: `prov-${i}` });
    const engine = new GnosysDreamEngine(db, baseConfig(), decayOnlyDream);
    const report = await engine.dream();
    expect(report.errors.some((e) => e.includes("Provider unavailable"))).toBe(true);
    const audit = db.queryAuditLog({ operation: "dream_provider_unreachable", limit: 1 });
    expect(audit.length).toBe(1);
    expect(audit[0].operation).toBe("dream_provider_unreachable");
    expect(db.getDreamConsecutiveFailures()).toBe(1);
  });

  it("fires desktop notification at consecutive failure threshold", async () => {
    db.setMeta("dream_consecutive_failures", "2");
    vi.mocked(createProvider).mockImplementationOnce(() => {
      throw new Error("no key");
    });
    for (let i = 0; i < 5; i++) insertMemory(db, { id: `notify-${i}` });
    const engine = new GnosysDreamEngine(db, baseConfig(), decayOnlyDream);
    await engine.dream();
    expect(notifyDesktop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyDesktop).mock.calls[0][0]).toMatch(/failed 3 times/);
  });

  it("runs all phases on happy path with stubbed LLM", async () => {
    for (let i = 0; i < 6; i++) {
      insertMemory(db, {
        id: `happy-a-${i}`,
        category: "decisions",
        content: "A long enough memory body for dream coverage testing purposes here.",
        tags: '["test"]',
        relevance: "dream test",
      });
    }
    for (let i = 0; i < 6; i++) {
      insertMemory(db, {
        id: `happy-b-${i}`,
        category: "concepts",
        content: "Another long enough memory body for dream coverage testing purposes.",
        tags: '["test"]',
        relevance: "dream test",
      });
    }
    mockGenerate.mockImplementation(async (prompt: string) => {
      if (prompt.includes("relationship")) {
        return JSON.stringify([
          { source_id: "happy-a-0", target_id: "happy-a-1", rel_type: "references", label: "link", confidence: 0.9 },
        ]);
      }
      if (prompt.includes("Category summary") || prompt.includes("category")) {
        return "# Category summary\nKey themes and patterns.";
      }
      return '{"action":"ok"}';
    });
    const engine = new GnosysDreamEngine(db, baseConfig(), {
      minMemories: 3,
      selfCritique: true,
      generateSummaries: true,
      discoverRelationships: true,
    });
    const report = await engine.dream();
    expect(report.summariesGenerated).toBeGreaterThanOrEqual(1);
    expect(report.errors.filter((e) => !e.includes("Provider unavailable"))).toEqual([]);
  });

  it("aborts at shouldStop checkpoint when abort requested", async () => {
    for (let i = 0; i < 5; i++) insertMemory(db, { id: `abort-${i}` });
    const engine = new GnosysDreamEngine(db, baseConfig(), decayOnlyDream);
    const report = await engine.dream((phase) => {
      if (phase === "decay") engine.abort();
    });
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toBe("abort requested");
  });

  it("aborts when max runtime exceeded", async () => {
    for (let i = 0; i < 5; i++) {
      insertMemory(db, {
        id: `overtime-${i}`,
        category: i % 2 === 0 ? "decisions" : "concepts",
        content: "Long content for overtime dream test with enough text for critique rules.",
        tags: '["test"]',
        relevance: "overtime",
        confidence: 0.45,
      });
    }
    mockGenerate.mockResolvedValue('{"action":"review","reason":"check"}');
    let currentTime = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    const engine = new GnosysDreamEngine(db, baseConfig(), {
      minMemories: 3,
      maxRuntimeMinutes: 0.001,
      selfCritique: true,
      generateSummaries: false,
      discoverRelationships: false,
    });
    const report = await engine.dream((phase) => {
      if (phase === "decay") currentTime += 120;
    });
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/max runtime exceeded/);
  });

  it("resets consecutive failures when LLM work succeeded", async () => {
    db.setMeta("dream_consecutive_failures", "5");
    for (let i = 0; i < 4; i++) {
      insertMemory(db, { id: `reset-a-${i}`, category: "decisions", content: "Enough content for summary generation in dream coverage test." });
    }
    for (let i = 0; i < 4; i++) {
      insertMemory(db, { id: `reset-b-${i}`, category: "concepts", content: "Enough content for summary generation in dream coverage test." });
    }
    mockGenerate.mockResolvedValue("# Summary\nCategory overview.");
    const engine = new GnosysDreamEngine(db, baseConfig(), {
      minMemories: 3,
      selfCritique: false,
      generateSummaries: true,
      discoverRelationships: false,
    });
    const report = await engine.dream();
    expect(report.summariesGenerated).toBeGreaterThan(0);
    expect(db.getMeta("dream_consecutive_failures")).toBe("0");
  });
});

describe("GnosysDreamEngine phase implementations", () => {
  it("decaySweep updates stale memories and skips recent ones", async () => {
    insertMemory(db, {
      id: "decay-today",
      last_reinforced: todayIso(),
      confidence: 0.9,
    });
    insertMemory(db, {
      id: "decay-5d",
      last_reinforced: daysAgoIso(5),
      confidence: 0.9,
      content: "Five day old memory with enough content for dream decay sweep testing.",
    });
    insertMemory(db, {
      id: "decay-200d",
      last_reinforced: daysAgoIso(200),
      confidence: 0.9,
      content: "Very old memory with enough content for dream decay sweep testing.",
    });
    insertMemory(db, { id: "decay-extra", last_reinforced: daysAgoIso(5), confidence: 0.9 });
    const engine = new GnosysDreamEngine(db, baseConfig(), decayOnlyDream);
    const report = await engine.dream();
    expect(report.decayUpdated).toBeGreaterThanOrEqual(2);
  });

  it("critiquMemory rule arms produce review suggestions", async () => {
    insertMemory(db, { id: "crit-low", confidence: 0.2, content: "Low confidence memory with enough content length for rules." });
    insertMemory(db, {
      id: "crit-old",
      reinforcement_count: 0,
      created: daysAgoIso(60),
      content: "Never reinforced old memory with enough content for critique rules.",
    });
    insertMemory(db, { id: "crit-short", content: "short", confidence: 0.5 });
    insertMemory(db, { id: "crit-notags", tags: "[]", content: "Memory without tags but with enough content for critique.", confidence: 0.5 });
    {
      const mem = makeMemory({
        id: "crit-norelevance",
        content: "Memory without relevance keywords but enough content.",
        confidence: 0.5,
      });
      mem.relevance = "";
      db.insertMemory(mem);
    }
    insertMemory(db, { id: "crit-badtags", tags: "not-json", content: "Memory with invalid tags format and enough content.", confidence: 0.5 });
    vi.mocked(getLLMProvider).mockImplementationOnce(() => {
      throw new Error("no key");
    });
    const engine = new GnosysDreamEngine(db, baseConfig(), {
      ...decayOnlyDream,
      selfCritique: true,
    });
    const report = await engine.dream();
    const reasons = report.reviewSuggestions.map((s) => s.reason).join(" ");
    expect(reasons).toMatch(/Very low confidence/);
    expect(reasons).toMatch(/Never reinforced/);
    expect(reasons).toMatch(/short content/);
    expect(reasons).toMatch(/No tags/);
    expect(reasons).toMatch(/No relevance/);
    expect(reasons).toMatch(/Invalid tags/);
    const lowConf = report.reviewSuggestions.find((s) => s.memoryId === "crit-low");
    expect(lowConf?.suggestedAction).toBe("consider-archive");
  });

  it("llmCritique handles ok, review, needs-update, and malformed JSON", async () => {
    insertMemory(db, {
      id: "borderline-1",
      confidence: 0.45,
      content: "Borderline memory for LLM critique path in dream coverage testing with enough text.",
      tags: '["test"]',
      relevance: "borderline",
    });
    insertMemory(db, { id: "borderline-2", confidence: 0.45, content: "Second borderline memory for LLM critique coverage.", tags: '["test"]', relevance: "x" });
    insertMemory(db, { id: "borderline-3", confidence: 0.45, content: "Third borderline memory for LLM critique coverage.", tags: '["test"]', relevance: "x" });
    insertMemory(db, { id: "borderline-4", confidence: 0.45, content: "Fourth borderline memory for LLM critique coverage.", tags: '["test"]', relevance: "x" });
    mockGenerate
      .mockResolvedValueOnce('{"action":"ok"}')
      .mockResolvedValueOnce('{"action":"review","reason":"needs eyes"}')
      .mockResolvedValueOnce('{"action":"needs-update","reason":"stale info"}')
      .mockResolvedValueOnce("not json at all");
    const engine = new GnosysDreamEngine(db, baseConfig(), {
      ...decayOnlyDream,
      selfCritique: true,
    });
    const report = await engine.dream();
    const llmReasons = report.reviewSuggestions.filter((s) => s.reason.includes("needs eyes") || s.reason.includes("stale info"));
    expect(llmReasons.length).toBeGreaterThanOrEqual(2);
  });

  it("generateSummaries creates, skips unchanged, and updates summaries", async () => {
    for (let i = 0; i < 3; i++) {
      insertMemory(db, { id: `sum-a-${i}`, category: "decisions", content: "Decision memory content for summary generation testing in dream." });
    }
    for (let i = 0; i < 3; i++) {
      insertMemory(db, { id: `sum-b-${i}`, category: "concepts", content: "Concept memory content for summary generation testing in dream." });
    }
    mockGenerate.mockResolvedValue("# Category X\nSummary text.");
    const cfg = {
      minMemories: 3,
      selfCritique: false,
      generateSummaries: true,
      discoverRelationships: false,
    };
    const engine1 = new GnosysDreamEngine(db, baseConfig(), cfg);
    const first = await engine1.dream();
    expect(first.summariesGenerated).toBe(2);

    const engine2 = new GnosysDreamEngine(db, baseConfig(), cfg);
    const second = await engine2.dream();
    expect(second.summariesGenerated).toBe(0);
    expect(second.summariesUpdated).toBe(0);

    insertMemory(db, { id: "sum-a-new", category: "decisions", content: "New decision memory to trigger summary update path." });
    mockGenerate.mockResolvedValue("# Updated\nNew summary.");
    const engine3 = new GnosysDreamEngine(db, baseConfig(), cfg);
    const third = await engine3.dream();
    expect(third.summariesUpdated).toBe(1);
  });

  it("summarizeCategory swallows provider errors without crashing", async () => {
    for (let i = 0; i < 3; i++) {
      insertMemory(db, { id: `fail-sum-${i}`, category: "decisions", content: "Memory for summarize failure path in dream coverage test." });
    }
    for (let i = 0; i < 3; i++) {
      insertMemory(db, { id: `fail-sum-b-${i}`, category: "concepts", content: "Memory for summarize failure path in dream coverage test." });
    }
    mockGenerate.mockRejectedValue(new Error("fail"));
    const engine = new GnosysDreamEngine(db, baseConfig(), {
      minMemories: 3,
      selfCritique: false,
      generateSummaries: true,
      discoverRelationships: false,
    });
    const report = await engine.dream();
    expect(report.summariesGenerated).toBe(0);
    expect(report.summariesUpdated).toBe(0);
    expect(report.errors.filter((e) => !e.includes("Provider unavailable"))).toEqual([]);
  });

  it("discoverRelationships filters self-ref, low confidence, and deduplicates", async () => {
    for (let i = 0; i < 6; i++) {
      insertMemory(db, { id: `rel-m${i}`, content: `Relationship memory ${i} with enough content for discovery.` });
    }
    mockGenerate.mockResolvedValueOnce(
      JSON.stringify([
        { source_id: "rel-m0", target_id: "rel-m1", rel_type: "references", label: "valid", confidence: 0.9 },
        { source_id: "rel-m0", target_id: "rel-m0", rel_type: "references", label: "self", confidence: 0.9 },
        { source_id: "rel-m0", target_id: "rel-m2", rel_type: "references", label: "low", confidence: 0.5 },
      ]),
    );
    const engine = new GnosysDreamEngine(db, baseConfig(), {
      minMemories: 3,
      selfCritique: false,
      generateSummaries: false,
      discoverRelationships: true,
    });
    const report = await engine.dream();
    expect(report.relationshipsDiscovered).toBe(1);
    expect(db.getRelationshipsFrom("rel-m0").length).toBe(1);

    mockGenerate.mockResolvedValueOnce(
      JSON.stringify([
        { source_id: "rel-m0", target_id: "rel-m1", rel_type: "references", label: "dup", confidence: 0.9 },
      ]),
    );
    const engine2 = new GnosysDreamEngine(db, baseConfig(), {
      minMemories: 3,
      selfCritique: false,
      generateSummaries: false,
      discoverRelationships: true,
    });
    const second = await engine2.dream();
    expect(second.relationshipsDiscovered).toBe(0);
  });

  it("findRelationships returns empty array on malformed JSON", async () => {
    for (let i = 0; i < 4; i++) {
      insertMemory(db, { id: `mal-rel-${i}`, content: "Memory for malformed relationship JSON test in dream coverage." });
    }
    mockGenerate.mockResolvedValueOnce("not json at all");
    const engine = new GnosysDreamEngine(db, baseConfig(), {
      minMemories: 3,
      selfCritique: false,
      generateSummaries: false,
      discoverRelationships: true,
    });
    const report = await engine.dream();
    expect(report.relationshipsDiscovered).toBe(0);
  });
});

describe("formatDreamReport", () => {
  it("formats happy path with suggestions and errors", () => {
    const report: DreamReport = {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      durationMs: 60000,
      decayUpdated: 3,
      summariesGenerated: 2,
      summariesUpdated: 0,
      reviewSuggestions: [
        {
          memoryId: "x",
          title: "T",
          reason: "r",
          currentConfidence: 0.4,
          suggestedAction: "review",
        },
      ],
      relationshipsDiscovered: 1,
      duplicatesFound: 0,
      errors: ["e1"],
      aborted: false,
    };
    const text = formatDreamReport(report);
    expect(text).toContain("Gnosys Dream Report");
    expect(text).toContain("Confidence decay updates: 3");
    expect(text).toContain("Review Suggestions (1):");
    expect(text).toContain("[review]");
    expect(text).toContain("Errors (1):");
    expect(text).toContain("e1");
  });

  it("formats aborted report", () => {
    const report: DreamReport = {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      decayUpdated: 0,
      summariesGenerated: 0,
      summariesUpdated: 0,
      reviewSuggestions: [],
      relationshipsDiscovered: 0,
      duplicatesFound: 0,
      errors: [],
      aborted: true,
      abortReason: "halt",
    };
    const text = formatDreamReport(report);
    expect(text).toContain("Aborted: halt");
  });

  it("formats empty report without suggestion or error headers", () => {
    const report: DreamReport = {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      decayUpdated: 0,
      summariesGenerated: 0,
      summariesUpdated: 0,
      reviewSuggestions: [],
      relationshipsDiscovered: 0,
      duplicatesFound: 0,
      errors: [],
      aborted: false,
    };
    const text = formatDreamReport(report);
    expect(text).not.toContain("Review Suggestions");
    expect(text).not.toContain("Errors (");
    expect(text).toContain("Duration:");
  });
});

describe("DreamScheduler", () => {
  function makeEngine(): GnosysDreamEngine {
    for (let i = 0; i < 5; i++) insertMemory(db, { id: `sched-${i}` });
    return new GnosysDreamEngine(db, baseConfig(), decayOnlyDream);
  }

  it("constructor ignores prototype pollution keys", () => {
    const engine = makeEngine();
    const polluted = { ...DEFAULT_DREAM_CONFIG, ["__proto__" as string]: { polluted: true } };
    const scheduler = new DreamScheduler(engine, polluted as Partial<typeof DEFAULT_DREAM_CONFIG>);
    expect((scheduler as unknown as { config: { polluted?: unknown } }).config.polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("start is no-op when disabled", () => {
    const engine = makeEngine();
    const scheduler = new DreamScheduler(engine, { enabled: false });
    scheduler.start();
    expect((scheduler as unknown as { checkInterval: unknown }).checkInterval).toBeNull();
  });

  it("start is no-op when machine is not designated", () => {
    const engine = makeEngine();
    const scheduler = new DreamScheduler(engine, { enabled: true });
    scheduler.start();
    expect((scheduler as unknown as { checkInterval: unknown }).checkInterval).toBeNull();
  });

  it("start arms interval and triggers dream when designated and idle", async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const localId = "test-m1";
    db.setMeta("machine_id", localId);
    db.setDreamMachineId(localId);
    const fakeReport: DreamReport = {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      decayUpdated: 0,
      summariesGenerated: 0,
      summariesUpdated: 0,
      reviewSuggestions: [],
      relationshipsDiscovered: 0,
      duplicatesFound: 0,
      errors: [],
      aborted: false,
    };
    const dreamSpy = vi.spyOn(engine, "dream").mockResolvedValue(fakeReport);
    const scheduler = new DreamScheduler(engine, { enabled: true, idleMinutes: 0.001 });
    (scheduler as unknown as { lastActivity: number }).lastActivity = Date.now() - 120;
    scheduler.start();
    expect((scheduler as unknown as { checkInterval: unknown }).checkInterval).not.toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(dreamSpy).toHaveBeenCalled();
    scheduler.stop();
  });

  it("recordActivity aborts running engine", () => {
    const engine = makeEngine();
    const abortSpy = vi.spyOn(engine, "abort");
    const scheduler = new DreamScheduler(engine, DEFAULT_DREAM_CONFIG);
    (scheduler as unknown as { running: boolean }).running = true;
    const before = (scheduler as unknown as { lastActivity: number }).lastActivity;
    scheduler.recordActivity();
    expect(abortSpy).toHaveBeenCalled();
    expect((scheduler as unknown as { lastActivity: number }).lastActivity).toBeGreaterThanOrEqual(before);
  });

  it("stop clears interval and aborts running engine", () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const localId = "stop-m1";
    db.setMeta("machine_id", localId);
    db.setDreamMachineId(localId);
    const abortSpy = vi.spyOn(engine, "abort");
    const scheduler = new DreamScheduler(engine, { enabled: true, idleMinutes: 10 });
    scheduler.start();
    (scheduler as unknown as { running: boolean }).running = true;
    scheduler.stop();
    expect((scheduler as unknown as { checkInterval: unknown }).checkInterval).toBeNull();
    expect(abortSpy).toHaveBeenCalled();
  });

  it("isDesignatedMachine returns false when getDb throws", () => {
    const engine = makeEngine();
    vi.spyOn(engine, "getDb").mockImplementation(() => {
      throw new Error("db fail");
    });
    const scheduler = new DreamScheduler(engine, DEFAULT_DREAM_CONFIG);
    expect((scheduler as unknown as { isDesignatedMachine: () => boolean }).isDesignatedMachine()).toBe(false);
  });

  it("getLocalMachineId uses hostname fallback and caches meta", () => {
    const engine = makeEngine();
    const scheduler = new DreamScheduler(engine, DEFAULT_DREAM_CONFIG);
    db.deleteMeta("machine_id");
    const savedHost = process.env.HOSTNAME;
    const savedComp = process.env.COMPUTERNAME;
    delete process.env.HOSTNAME;
    delete process.env.COMPUTERNAME;
    const id1 = (scheduler as unknown as { getLocalMachineId: (d: GnosysDB) => string }).getLocalMachineId(db);
    const id2 = (scheduler as unknown as { getLocalMachineId: (d: GnosysDB) => string }).getLocalMachineId(db);
    if (savedHost !== undefined) process.env.HOSTNAME = savedHost;
    if (savedComp !== undefined) process.env.COMPUTERNAME = savedComp;
    expect(typeof id1).toBe("string");
    expect(id1.length).toBeGreaterThan(0);
    expect(id2).toBe(id1);
    expect(db.getMeta("machine_id")).toBe(id1);
  });

  it("isDreaming reflects running state", () => {
    const engine = makeEngine();
    const scheduler = new DreamScheduler(engine, DEFAULT_DREAM_CONFIG);
    expect(scheduler.isDreaming()).toBe(false);
    (scheduler as unknown as { running: boolean }).running = true;
    expect(scheduler.isDreaming()).toBe(true);
  });

  it("checkIdle swallows engine rejection and resets running", async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const localId = "err-m1";
    db.setMeta("machine_id", localId);
    db.setDreamMachineId(localId);
    vi.spyOn(engine, "dream").mockRejectedValue(new Error("dream-failure"));
    const scheduler = new DreamScheduler(engine, { enabled: true, idleMinutes: 0.001 });
    (scheduler as unknown as { lastActivity: number }).lastActivity = Date.now() - 120;
    scheduler.start();
    await vi.advanceTimersByTimeAsync(61_000);
    await Promise.resolve();
    await Promise.resolve();
    expect((scheduler as unknown as { running: boolean }).running).toBe(false);
    scheduler.stop();
  });
});

describe("DEFAULT_DREAM_CONFIG", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_DREAM_CONFIG.enabled).toBe(false);
    expect(DEFAULT_DREAM_CONFIG.minMemories).toBe(10);
    expect(DEFAULT_DREAM_CONFIG.selfCritique).toBe(true);
  });
});
