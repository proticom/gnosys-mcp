import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("gnosys ingest command wiring", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf-8");
  const handler = readFileSync(
    join(process.cwd(), "src/lib/ingestCommand.ts"),
    "utf-8",
  );

  it("wires ingest to runIngestCommand via dynamic import", () => {
    expect(cli).toContain('.command("ingest <fileOrGlob>")');
    expect(cli).toContain("--mode <mode>");
    expect(cli).toContain("--list-attachments");
    expect(cli).toContain("--dry-run");
    expect(cli).toContain("-d, --directory <dir>");
    expect(cli).toContain(
      'const { runIngestCommand } = await import("./lib/ingestCommand.js")',
    );
    expect(cli).toContain("await runIngestCommand(getResolver, fileOrGlob, opts)");
  });

  it("exports runIngestCommand with list-attachments and file branches", () => {
    expect(handler).toContain("export async function runIngestCommand");
    expect(handler).toContain('await import("./attachments.js")');
    expect(handler).toContain("listAttachments");
    expect(handler).toContain('await import("./multimodalIngest.js")');
    expect(handler).toContain("ingestFile");
    expect(handler).toContain("fs.access(resolvedPath)");
    expect(handler).toContain("File not found:");
    expect(handler).not.toContain('await import("./lib/attachments.js")');
    expect(handler).not.toContain('await import("./lib/multimodalIngest.js")');
  });
});
