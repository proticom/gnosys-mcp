/**
 * v5.9.4 Bug 12 tests — Grok Build IDE integration.
 *
 * Verifies:
 *   - `setupIDE("grok-build", ...)` writes a `[mcp_servers.gnosys]` block to
 *     ~/.grok/config.toml without clobbering unrelated content.
 *   - `upsertGrokMcpBlock` is idempotent (rerunning produces the same file).
 *   - Existing `[mcp_servers.gnosys]` blocks are replaced, not duplicated.
 *   - Legacy `[mcp.gnosys]` blocks are removed when migrating.
 *   - Untouched `[mcp_servers.<other>]` blocks survive a rewrite.
 */

import { describe, it, expect } from "vitest";
import { upsertGrokMcpBlock } from "../lib/setup.js";

describe("upsertGrokMcpBlock — v5.9.4 Bug 12", () => {
  const entry = { command: "gnosys-mcp", args: [] as string[], startup_timeout_sec: 90 };

  it("appends a fresh block to empty input", () => {
    const out = upsertGrokMcpBlock("", "gnosys", entry);
    expect(out).toBe(
      `[mcp_servers.gnosys]
command = "gnosys-mcp"
args = []
startup_timeout_sec = 90
`,
    );
  });

  it("appends a block to existing content separated by a blank line", () => {
    const before = `[settings]
theme = "dark"
`;
    const out = upsertGrokMcpBlock(before, "gnosys", entry);
    expect(out).toContain(`[settings]`);
    expect(out).toContain(`[mcp_servers.gnosys]`);
    expect(out.indexOf(`[settings]`)).toBeLessThan(out.indexOf(`[mcp_servers.gnosys]`));
  });

  it("replaces an existing [mcp_servers.gnosys] block instead of duplicating it", () => {
    const before = `[settings]
theme = "dark"

[mcp_servers.gnosys]
command = "old-binary"
args = []

[mcp_servers.other]
command = "other"
`;
    const out = upsertGrokMcpBlock(before, "gnosys", entry);
    // No duplicate headers.
    expect(out.match(/\[mcp_servers\.gnosys\]/g)?.length).toBe(1);
    // New values landed.
    expect(out).toContain(`command = "gnosys-mcp"`);
    expect(out).toContain(`args = []`);
    expect(out).toContain(`startup_timeout_sec = 90`);
    // Other section preserved.
    expect(out).toContain(`[mcp_servers.other]`);
    expect(out).toContain(`command = "other"`);
    // Settings block preserved.
    expect(out).toContain(`theme = "dark"`);
    // Old binary line is gone.
    expect(out).not.toContain(`old-binary`);
  });

  it("is idempotent — second run produces identical bytes", () => {
    const once = upsertGrokMcpBlock("", "gnosys", entry);
    const twice = upsertGrokMcpBlock(once, "gnosys", entry);
    expect(twice).toBe(once);
  });

  it("removes legacy [mcp.gnosys] and writes [mcp_servers.gnosys]", () => {
    const before = `[mcp.gnosys]
command = "stale"
args = []
`;
    const out = upsertGrokMcpBlock(before, "gnosys", entry);
    expect(out).not.toContain(`[mcp.gnosys]`);
    expect(out).toContain(`[mcp_servers.gnosys]`);
    expect(out).toContain(`command = "gnosys-mcp"`);
  });

  it("preserves the [mcp_servers.other] block when replacing [mcp_servers.gnosys]", () => {
    const before = `[mcp_servers.gnosys]
command = "stale"
args = []

[mcp_servers.other]
command = "still here"
args = ["arg1"]
`;
    const out = upsertGrokMcpBlock(before, "gnosys", entry);
    expect(out).toContain(`[mcp_servers.other]`);
    expect(out).toContain(`command = "still here"`);
    expect(out).toContain(`args = ["arg1"]`);
    // New gnosys values landed.
    expect(out).toContain(`startup_timeout_sec = 90`);
  });
});
