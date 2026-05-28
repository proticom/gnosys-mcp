import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys chat command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/chatCommand.ts"),
    "utf-8",
  );

  it("wires top-level chat to runChatCommand via dynamic import", () => {
    expect(cli).toContain("Interactive memory-aware terminal chat (TUI)");
    expect(cli).toContain("--resume <sessionId>");
    expect(cli).toContain("--list");
    expect(cli).toContain("--search <query>");
    expect(cli).toContain("--provider <name>");
    expect(cli).toContain("--model <name>");
    expect(cli).toContain(
      'const { runChatCommand } = await import("./lib/chatCommand.js")',
    );
    expect(cli).toContain("await runChatCommand(getResolver, opts)");
  });

  it("exports runChatCommand with list/search shortcuts and fail-fast markers", () => {
    expect(handler).toContain("export async function runChatCommand");
    expect(handler).toContain("chat.printSessionList(limit)");
    expect(handler).toContain("chat.printSearchResults(opts.search, limit)");
    expect(handler).toContain("loadConfig(storePath)");
    expect(handler).toContain("DEFAULT_CONFIG");
    expect(handler).toContain("resolveTaskModel");
    expect(handler).toContain("getApiKeyForProvider");
    expect(handler).toContain('Status("fail"');
    expect(handler).toContain("chat.startChat");
    expect(handler).toContain('await import("./chat/index.js")');
    expect(handler).not.toContain('await import("./lib/chat/index.js")');
  });
});
