/**
 * Phase 5 — free-text intent detection.
 *
 * The pattern matcher is offline-pure; tests here cover regex behavior,
 * imperative-signal heuristic, and the per-session auto-accept counter.
 * The LLM classifier path is unit-tested only via its early-return when no
 * config is provided; the LLM-call branch is exercised in integration.
 */

import { describe, it, expect } from "vitest";
import {
  matchPattern,
  hasImperativeSignal,
  inferIntent,
  describeIntent,
  isDestructive,
  shouldAutoAccept,
  recordAcceptance,
  newAcceptanceLog,
} from "../lib/chat/intent.js";

describe("matchPattern", () => {
  it("recognizes 'remember' as /remember", () => {
    const m = matchPattern("remember that the build flag is OFF by default");
    expect(m?.command).toBe("/remember");
    expect(m?.args[0]).toBe("the build flag is OFF by default");
  });

  it("recognizes 'note that ...'", () => {
    const m = matchPattern("note that we use ULID over UUIDv7");
    expect(m?.command).toBe("/remember");
    expect(m?.args[0]).toBe("we use ULID over UUIDv7");
  });

  it("recognizes 'save that exchange' as /save-turn", () => {
    expect(matchPattern("save that exchange")?.command).toBe("/save-turn");
    expect(matchPattern("let's save that turn")?.command).toBe("/save-turn");
  });

  it("recognizes 'what did we decide about X' as /recall", () => {
    const m = matchPattern("what did we decide about ULID encoding?");
    expect(m?.command).toBe("/recall");
    expect(m?.args[0]).toBe("ULID encoding");
  });

  it("recognizes 'pin <id>'", () => {
    const m = matchPattern("pin deci-037");
    expect(m?.command).toBe("/pin");
    expect(m?.args[0]).toBe("deci-037");
  });

  it("recognizes 'unpin <id>'", () => {
    expect(matchPattern("unpin deci-037")?.command).toBe("/unpin");
  });

  it("recognizes positive-feedback as /reinforce", () => {
    expect(matchPattern("that was helpful")?.command).toBe("/reinforce");
    expect(matchPattern("perfect.")?.command).toBe("/reinforce");
    expect(matchPattern("exactly")?.command).toBe("/reinforce");
  });

  it("recognizes 'attach <path>'", () => {
    const m = matchPattern("attach /tmp/spec.pdf");
    expect(m?.command).toBe("/attach");
    expect(m?.args[0]).toBe("/tmp/spec.pdf");
  });

  it("recognizes goodbye phrases as /quit", () => {
    expect(matchPattern("goodbye")?.command).toBe("/quit");
    expect(matchPattern("thanks, that's all")?.command).toBe("/quit");
    expect(matchPattern("I'm done")?.command).toBe("/quit");
  });

  it("returns null on a normal chat turn", () => {
    expect(matchPattern("how does the maintenance loop work?")).toBeNull();
    expect(matchPattern("explain the architecture")).toBeNull();
  });

  it("returns matched pattern source for downstream learning", () => {
    const m = matchPattern("remember that fact");
    expect(m?.matchedPattern).toBeDefined();
    expect(m?.matchedPattern).toContain("remember|note|save");
  });
});

describe("hasImperativeSignal", () => {
  it("flags 'let's ...'", () => {
    expect(hasImperativeSignal("let's use postgres")).toBe(true);
    expect(hasImperativeSignal("Let's go with that")).toBe(true);
  });

  it("flags 'should we ...'", () => {
    expect(hasImperativeSignal("should we add caching here?")).toBe(true);
  });

  it("flags 'please ...'", () => {
    expect(hasImperativeSignal("please summarize the last turn")).toBe(true);
  });

  it("doesn't flag normal questions", () => {
    expect(hasImperativeSignal("how does X work?")).toBe(false);
    expect(hasImperativeSignal("what does this mean?")).toBe(false);
  });
});

describe("inferIntent (no LLM config)", () => {
  it("returns the pattern match when one fires", async () => {
    const result = await inferIntent("remember that flag default is OFF", null);
    expect(result?.command).toBe("/remember");
  });

  it("returns null when no pattern fires and no LLM is available", async () => {
    expect(await inferIntent("just a casual message", null)).toBeNull();
  });

  it("returns null even with imperative signal when no LLM config", async () => {
    expect(await inferIntent("let's discuss the design tradeoffs", null)).toBeNull();
  });
});

describe("describeIntent", () => {
  it("formats the inferred command + args", () => {
    expect(
      describeIntent({ command: "/pin", args: ["deci-037"], confidence: "high" }),
    ).toBe("/pin deci-037");
  });

  it("emits just the command when there are no args", () => {
    expect(
      describeIntent({ command: "/save-turn", args: [], confidence: "high" }),
    ).toBe("/save-turn");
  });
});

describe("isDestructive", () => {
  it("flags /quit as destructive", () => {
    expect(isDestructive("/quit")).toBe(true);
  });

  it("does not flag /pin or /remember", () => {
    expect(isDestructive("/pin")).toBe(false);
    expect(isDestructive("/remember")).toBe(false);
  });
});

describe("acceptance log", () => {
  it("starts empty — auto-accept is false", () => {
    const log = newAcceptanceLog();
    expect(shouldAutoAccept(log, "any-pattern")).toBe(false);
  });

  it("auto-accepts after 5 confirmations of the same pattern", () => {
    const log = newAcceptanceLog();
    for (let i = 0; i < 4; i++) recordAcceptance(log, "pat-A");
    expect(shouldAutoAccept(log, "pat-A")).toBe(false); // 4 confirms, not yet
    recordAcceptance(log, "pat-A");
    expect(shouldAutoAccept(log, "pat-A")).toBe(true);  // 5 confirms → auto
  });

  it("counts each pattern independently", () => {
    const log = newAcceptanceLog();
    for (let i = 0; i < 6; i++) recordAcceptance(log, "pat-A");
    expect(shouldAutoAccept(log, "pat-A")).toBe(true);
    expect(shouldAutoAccept(log, "pat-B")).toBe(false);
  });

  it("ignores undefined pattern keys", () => {
    const log = newAcceptanceLog();
    recordAcceptance(log, undefined);
    expect(shouldAutoAccept(log, undefined)).toBe(false);
  });
});
