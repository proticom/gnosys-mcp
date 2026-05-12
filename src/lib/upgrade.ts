/**
 * Upgrade — marker file coordination between `gnosys upgrade` and running MCP servers.
 *
 * v5.7.1 (#15, #12).
 *
 * Problem: an MCP server spawned by Claude Code / Cursor / VS Code keeps
 * running the binary it was spawned with. After `npm install -g gnosys@latest`
 * the global CLI is new, but the host's MCP process still serves the old
 * version until the host restarts it. Memories get stamped with old-format
 * IDs, sync collisions appear, etc.
 *
 * Fix: leave a marker file on disk that names the new version. Running MCP
 * servers stat the marker periodically (single FS call, cheap). When the
 * marker version differs from the running binary's pkg.version, the MCP
 * exits cleanly — the host then auto-respawns it against the new global
 * binary.
 *
 * Marker path: `~/.gnosys/last-upgrade-at`. JSON shape:
 *   { "version": "5.7.1", "timestamp": "2026-05-12T...", "upgradedBy": "Mac-Studio" }
 *
 * Marker is per-machine — multi-machine sync of upgrades is handled by the
 * central DB's `app_version` + `machines` meta keys (see #16).
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface UpgradeMarker {
  version: string;
  timestamp: string;
  upgradedBy?: string;
}

export function getMarkerPath(): string {
  const home = process.env.HOME || os.homedir() || "/tmp";
  return path.join(home, ".gnosys", "last-upgrade-at");
}

export function writeUpgradeMarker(version: string): void {
  const markerPath = getMarkerPath();
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const marker: UpgradeMarker = {
    version,
    timestamp: new Date().toISOString(),
    upgradedBy: os.hostname(),
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf8");
}

export function readUpgradeMarker(): UpgradeMarker | null {
  try {
    const raw = fs.readFileSync(getMarkerPath(), "utf8");
    return JSON.parse(raw) as UpgradeMarker;
  } catch {
    return null;
  }
}

/**
 * Returns true when the on-disk marker names a different version than the
 * currently running binary. The caller (an MCP server) should exit cleanly
 * so the host respawns it against the upgraded global binary.
 */
export function shouldRestartMcp(currentVersion: string): boolean {
  const marker = readUpgradeMarker();
  if (!marker) return false;
  return marker.version !== currentVersion;
}
