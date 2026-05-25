/**
 * Package manager detection for gnosys upgrade.
 */

import { describe, it, expect } from "vitest";
import { detectPackageManager, upgradeCommand } from "../lib/packageManager.js";

describe("detectPackageManager", () => {
  it("detects npx from install path", () => {
    expect(detectPackageManager("/Users/x/.npm/_npx/abc123/node_modules/gnosys/dist/cli.js", {})).toBe("npx");
    expect(detectPackageManager("/tmp/_npx/gnosys/cli.js", {})).toBe("npx");
  });

  it("detects pnpm from install path and PNPM_HOME", () => {
    expect(detectPackageManager("/Users/x/Library/pnpm/gnosys", {})).toBe("pnpm");
    expect(
      detectPackageManager("/opt/pnpm/global/5/node_modules/gnosys/dist/cli.js", {
        PNPM_HOME: "/opt/pnpm/global/5",
      }),
    ).toBe("pnpm");
  });

  it("detects yarn from install path", () => {
    expect(detectPackageManager("/Users/x/.config/yarn/global/node_modules/gnosys/dist/cli.js", {})).toBe("yarn");
    expect(detectPackageManager("/Users/x/.yarn/bin/gnosys", {})).toBe("yarn");
  });

  it("detects npm from typical global path", () => {
    expect(detectPackageManager("/usr/local/lib/node_modules/gnosys/dist/cli.js", {})).toBe("npm");
  });

  it("falls back to npm_config_user_agent", () => {
    expect(detectPackageManager("/unknown/path/cli.js", { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v20" })).toBe("pnpm");
    expect(detectPackageManager("/unknown/path/cli.js", { npm_config_user_agent: "yarn/1.22.0 npm/? node/v20" })).toBe("yarn");
  });
});

describe("upgradeCommand", () => {
  it("maps managers to upgrade commands", () => {
    expect(upgradeCommand("npm")).toBe("npm install -g gnosys@latest");
    expect(upgradeCommand("pnpm")).toBe("pnpm add -g gnosys@latest");
    expect(upgradeCommand("yarn")).toBe("yarn global add gnosys@latest");
    expect(upgradeCommand("npx")).toBeNull();
  });
});
