export type PkgManager = "npm" | "pnpm" | "yarn" | "npx";

/** Detect how the running global gnosys was installed, from its path + env. */
export function detectPackageManager(
  execPath = process.argv[1] || "",
  env: NodeJS.ProcessEnv = process.env,
): PkgManager {
  const p = execPath.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/_npx/") || p.includes("/.npm/_npx/")) return "npx";
  if (p.includes("/pnpm/") || (env.PNPM_HOME && p.startsWith(env.PNPM_HOME.replace(/\\/g, "/").toLowerCase()))) {
    return "pnpm";
  }
  if (p.includes("/.yarn/") || p.includes("/yarn/global/") || p.includes("/.config/yarn/")) return "yarn";

  const ua = (env.npm_config_user_agent || "").toLowerCase();
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  return "npm";
}

/** The upgrade command for a manager, or null when there's nothing to install (npx). */
export function upgradeCommand(pm: PkgManager): string | null {
  switch (pm) {
    case "pnpm":
      return "pnpm add -g gnosys@latest";
    case "yarn":
      return "yarn global add gnosys@latest";
    case "npx":
      return null;
    default:
      return "npm install -g gnosys@latest";
  }
}
