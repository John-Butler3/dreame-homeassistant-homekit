export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function createLogger(scope: string) {
  const emit = (level: LogLevel, message: string, ...rest: unknown[]) => {
    if (ORDER[level] < ORDER[threshold]) {
      return;
    }
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (level === "error") {
      console.error(line, ...rest);
    } else if (level === "warn") {
      console.warn(line, ...rest);
    } else {
      console.log(line, ...rest);
    }
  };
  return {
    debug: (m: string, ...r: unknown[]) => emit("debug", m, ...r),
    info: (m: string, ...r: unknown[]) => emit("info", m, ...r),
    warn: (m: string, ...r: unknown[]) => emit("warn", m, ...r),
    error: (m: string, ...r: unknown[]) => emit("error", m, ...r),
  };
}

export type Logger = ReturnType<typeof createLogger>;
