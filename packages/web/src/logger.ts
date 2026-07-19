type Level = "debug" | "info" | "warn" | "error"

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const configured = (process.env.WORK_LOG_LEVEL || "info").toLowerCase()
  return LEVELS[configured as Level] ?? LEVELS.info
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return
  const payload: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  }
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v instanceof Error) payload[k] = { name: v.name, message: v.message, stack: v.stack }
      else if (v !== undefined) payload[k] = v
    }
  }
  const line = JSON.stringify(payload)
  if (level === "error" || level === "warn") process.stderr.write(line + "\n")
  else process.stdout.write(line + "\n")
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
}

export const startTime = Date.now()

export function uptimeSeconds(): number {
  return Math.floor((Date.now() - startTime) / 1000)
}

const VERSION = "0.1.0"
export function version(): string {
  return VERSION
}
