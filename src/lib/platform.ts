/**
 * Cross-platform paths and user-facing hints (macOS, Linux, Windows).
 */

import os from "os";
import path from "path";

export type OsFamily = "macos" | "linux" | "windows";

/** Current OS family for CLI messages and help text. */
export function getOsFamily(): OsFamily {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

/** Primary secure credential store name on this machine. */
export function getSecureStorageLabel(): string {
  switch (getOsFamily()) {
    case "macos":
      return "macOS Keychain";
    case "linux":
      return "GNOME Keyring";
    case "windows":
      return "Windows Credential Manager";
  }
}

/** Short phrase for error messages (setup may still be required on Windows). */
export function getSecureStorageSetupHint(): string {
  switch (getOsFamily()) {
    case "macos":
      return "the macOS Keychain (via gnosys setup)";
    case "linux":
      return "GNOME Keyring (via gnosys setup, when secret-tool is available)";
    case "windows":
      return "your user environment or ~/.config/gnosys/.env (via gnosys setup)";
  }
}

/** Order of API key resolution for user-facing help on the current OS. */
export function getApiKeyResolutionOrderText(): string {
  switch (getOsFamily()) {
    case "macos":
      return "macOS Keychain, environment variable, then ~/.config/gnosys/.env";
    case "linux":
      return "GNOME Keyring (when available), environment variable, then ~/.config/gnosys/.env";
    case "windows":
      return "environment variable, then ~/.config/gnosys/.env";
  }
}

/** Claude Desktop MCP config file path for the current platform. */
export function getClaudeDesktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** Display path with ~ for home (for logs and help). */
export function displayClaudeDesktopConfigPath(): string {
  const home = os.homedir();
  const p = getClaudeDesktopConfigPath();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** Shell profile file(s) suggested for env vars on this OS. */
export function getShellProfileHint(): string {
  switch (getOsFamily()) {
    case "macos": {
      const shell = path.basename(process.env.SHELL ?? "zsh");
      return shell === "bash" ? "~/.bash_profile or ~/.bashrc" : "~/.zshrc";
    }
    case "linux": {
      const shell = path.basename(process.env.SHELL ?? "bash");
      return shell === "zsh" ? "~/.zshrc" : "~/.bashrc";
    }
    case "windows":
      return "%USERPROFILE%\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1 (or System Properties → Environment Variables)";
  }
}

/** Lines shown when user skips API key setup in gnosys setup. */
export function getApiKeySkipHints(envVarName: string, provider: string): string[] {
  const hints: string[] = [];
  const profile = getShellProfileHint();
  if (getOsFamily() === "macos") {
    hints.push(
      `macOS Keychain: security add-generic-password -a "$USER" -s "${envVarName}" -w "key" -U`,
    );
  }
  if (getOsFamily() === "linux") {
    hints.push(
      `GNOME Keyring: printf '%s' 'key' | secret-tool store --label="Gnosys ${provider}" service gnosys account ${envVarName}`,
    );
  }
  if (getOsFamily() === "windows") {
    hints.push(
      `PowerShell profile: [Environment]::SetEnvironmentVariable("${envVarName}", "key", "User")`,
    );
  }
  hints.push(`Shell profile:  echo 'export ${envVarName}=key' >> ${profile}`);
  hints.push(`Dotenv file:    echo '${envVarName}=key' >> ~/.config/gnosys/.env`);
  return hints;
}

/** ffmpeg install instructions (all platforms, for errors). */
export function formatFfmpegInstallHint(): string {
  return (
    "Install it with:\n" +
    "  macOS:   brew install ffmpeg\n" +
    "  Linux:   sudo apt install ffmpeg   (Debian/Ubuntu) or your distro package manager\n" +
    "  Windows: winget install FFmpeg    (or choco install ffmpeg)"
  );
}

/** Ingest / LLM missing-key helper bullet for gnosys setup. */
export function getSetupStorageBullet(): string {
  switch (getOsFamily()) {
    case "macos":
      return "  • gnosys setup       — interactive (recommended; stores in macOS Keychain)";
    case "linux":
      return "  • gnosys setup       — interactive (recommended; stores in GNOME Keyring when available)";
    case "windows":
      return "  • gnosys setup       — interactive (recommended; env var or ~/.config/gnosys/.env)";
  }
}
