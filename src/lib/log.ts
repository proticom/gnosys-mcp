import fs from "fs";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const raw = (process.env.GNOSYS_LOG_LEVEL || "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel()];
}

function normalizeError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function buildRecord(level: LogLevel, message: string, err?: Error, ctx?: object): Record<string, unknown> {
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(ctx ?? {}),
  };
  if (err) {
    record.error = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return record;
}

function formatText(level: LogLevel, message: string, err?: Error): string {
  const prefix =
    level === "error"
      ? message.startsWith("gnosys:")
        ? message
        : `gnosys: ${message}`
      : `gnosys: ${level}: ${message}`;
  if (err?.stack && level === "error") {
    return `${prefix}\n${err.stack}\n`;
  }
  return `${prefix}\n`;
}

function writeJsonLine(line: string): void {
  const logFile = process.env.GNOSYS_LOG_FILE;
  if (logFile) {
    fs.appendFileSync(logFile, line, "utf8");
  }
}

function emit(level: LogLevel, message: string, err?: Error, ctx?: object): void {
  if (!shouldEmit(level)) return;

  try {
    const jsonLine = `${JSON.stringify(buildRecord(level, message, err, ctx))}\n`;
    const useJson = process.env.GNOSYS_LOG_FORMAT === "json";

    if (useJson) {
      process.stderr.write(jsonLine);
    } else {
      process.stderr.write(formatText(level, message, err));
    }

    if (process.env.GNOSYS_LOG_FILE) {
      writeJsonLine(jsonLine);
    }
  } catch {
    // Best-effort logging must never throw.
  }
}

export function logError(err: unknown, ctx?: object): void {
  const error = normalizeError(err);
  emit("error", error.message, error, ctx);
}

export function logWarn(message: string, ctx?: object): void {
  emit("warn", message, undefined, ctx);
}

export function logInfo(message: string, ctx?: object): void {
  emit("info", message, undefined, ctx);
}

export function logDebug(message: string, ctx?: object): void {
  emit("debug", message, undefined, ctx);
}
