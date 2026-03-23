/**
 * Gnosys Sandbox Manager
 *
 * Manages the lifecycle of the background sandbox server process.
 * Handles start, stop, status, and auto-start on helper import.
 */

import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getSandboxDir, getPidPath, getSocketPath } from "./server.js";
import { SandboxClient } from "./client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SandboxStatus {
  running: boolean;
  pid?: number;
  socketPath?: string;
  uptime?: string;
  dbPath?: string;
}

/**
 * Get the path to the compiled server entry point.
 * Falls back to ts-node / tsx for development.
 */
function getServerScript(): string {
  // In production (dist/), look for the compiled JS
  const distServer = path.resolve(__dirname, "..", "sandbox", "server.js");
  if (fs.existsSync(distServer)) return distServer;

  // In development (src/), look for the TS source
  const srcServer = path.resolve(__dirname, "..", "..", "src", "sandbox", "server.ts");
  if (fs.existsSync(srcServer)) return srcServer;

  // Fallback: relative to this file
  return path.resolve(__dirname, "server.js");
}

/**
 * Read the PID from the PID file, if it exists.
 */
function readPid(): number | null {
  const pidPath = getPidPath();
  try {
    const content = fs.readFileSync(pidPath, "utf8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check if a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = just check existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up stale PID and socket files when the process is no longer running.
 */
function cleanupStale(): void {
  const pidPath = getPidPath();
  const socketPath = getSocketPath();

  try { if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath); } catch { /* best effort */ }
  try {
    if (process.platform !== "win32" && fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch { /* best effort */ }
}

/**
 * Start the sandbox server as a detached background process.
 * Returns the PID of the spawned process.
 */
export async function startSandbox(opts?: {
  persistent?: boolean;
  dbPath?: string;
  wait?: boolean;
}): Promise<number> {
  // Check if already running
  const client = new SandboxClient();
  if (await client.isRunning()) {
    const status = await client.ping();
    return status.pid;
  }

  // Clean up stale files
  cleanupStale();

  const serverScript = getServerScript();
  const args: string[] = [serverScript];
  if (opts?.dbPath) args.push(`--db-path=${opts.dbPath}`);

  // Determine how to run the script
  let command: string;
  let spawnArgs: string[];

  if (serverScript.endsWith(".ts")) {
    // Development mode — use tsx or ts-node
    command = "npx";
    spawnArgs = ["tsx", ...args];
  } else {
    command = process.execPath; // node
    spawnArgs = args;
  }

  const logPath = path.join(getSandboxDir(), "sandbox.log");
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(command, spawnArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    throw new Error("Failed to spawn sandbox process");
  }

  // Wait for the socket to become available (up to 5 seconds)
  if (opts?.wait !== false) {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (await client.isRunning()) {
        return child.pid;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // Even if we timeout, the process may still be starting
    // Check the PID file as fallback
    const pid = readPid();
    if (pid && isProcessAlive(pid)) return pid;
    throw new Error("Sandbox started but failed to respond within 5 seconds. Check ~/.gnosys/sandbox/sandbox.log");
  }

  return child.pid;
}

/**
 * Stop the sandbox server gracefully.
 * First tries the shutdown command, then falls back to SIGTERM.
 */
export async function stopSandbox(): Promise<boolean> {
  const pid = readPid();

  if (!pid || !isProcessAlive(pid)) {
    cleanupStale();
    return false; // wasn't running
  }

  // Try graceful shutdown via the protocol
  try {
    const client = new SandboxClient();
    await client.shutdown();
    // Give it a moment to clean up
    await new Promise((r) => setTimeout(r, 500));
    if (!isProcessAlive(pid)) {
      cleanupStale();
      return true;
    }
  } catch {
    // Socket may be unavailable — fall back to signal
  }

  // SIGTERM
  try {
    process.kill(pid, "SIGTERM");
    // Wait up to 3 seconds
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (!isProcessAlive(pid)) {
        cleanupStale();
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // Force kill
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may have already exited
  }

  cleanupStale();
  return true;
}

/**
 * Get the current status of the sandbox.
 */
export async function sandboxStatus(): Promise<SandboxStatus> {
  const pid = readPid();
  const socketPath = getSocketPath();

  if (!pid || !isProcessAlive(pid)) {
    cleanupStale();
    return { running: false };
  }

  // Verify by actually pinging
  const client = new SandboxClient();
  try {
    await client.ping();
    return {
      running: true,
      pid,
      socketPath,
    };
  } catch {
    // Process exists but socket is unresponsive
    return {
      running: false,
      pid,
    };
  }
}

/**
 * Ensure the sandbox is running (auto-start if needed).
 * Used by the helper library to transparently start the sandbox.
 */
export async function ensureSandbox(opts?: { dbPath?: string }): Promise<SandboxClient> {
  const client = new SandboxClient();

  if (await client.isRunning()) {
    return client;
  }

  // Auto-start
  await startSandbox({ dbPath: opts?.dbPath, wait: true });
  return client;
}
