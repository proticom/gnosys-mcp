import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys pref command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/prefCommand.ts"),
    "utf-8",
  );

  it("wires pref subcommands to handlers via dynamic import", () => {
    expect(cli).toContain('.command("pref")');
    expect(cli).toContain('.command("set <key> <value>")');
    expect(cli).toContain('.command("get [key]")');
    expect(cli).toContain('.command("delete <key>")');
    expect(cli).toContain("-t, --title <title>");
    expect(cli).toContain("--tags <tags>");
    expect(cli).toContain("--json");
    expect(cli).toContain(
      'const { runPrefSetCommand } = await import("./lib/prefCommand.js")',
    );
    expect(cli).toContain(
      'const { runPrefGetCommand } = await import("./lib/prefCommand.js")',
    );
    expect(cli).toContain(
      'const { runPrefDeleteCommand } = await import("./lib/prefCommand.js")',
    );
    expect(cli).toContain("await runPrefSetCommand(key, value, opts)");
    expect(cli).toContain("await runPrefGetCommand(key, opts)");
    expect(cli).toContain("await runPrefDeleteCommand(key)");
  });

  it("exports pref handlers with preference markers", () => {
    expect(handler).toContain("export async function runPrefSetCommand");
    expect(handler).toContain("export async function runPrefGetCommand");
    expect(handler).toContain("export async function runPrefDeleteCommand");
    expect(handler).toContain("GnosysDB.openCentral()");
    expect(handler).toContain("Central DB not available (better-sqlite3 missing).");
    expect(handler).toContain("KNOWN_PREFERENCE_KEYS");
    expect(handler).toContain("suggestPreferenceKey");
    expect(handler).toContain("setPreference");
    expect(handler).toContain("getPreference");
    expect(handler).toContain("getAllPreferences");
    expect(handler).toContain("deletePreference");
    expect(handler).toContain("Run 'gnosys sync' to update agent rules files.");
    expect(handler).toContain("JSON.stringify");
    expect(handler).toContain("process.exitCode = 1");
    expect(handler).not.toContain("process.exit(1)");
    expect(handler).toContain("centralDb?.close()");
  });
});
