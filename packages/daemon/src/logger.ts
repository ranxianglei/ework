import { format } from "node:util"

type Level = "debug" | "info" | "warn" | "error"

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function threshold(): number {
  const configured = (process.env.WORK_LOG_LEVEL || "info").toLowerCase()
  return LEVELS[configured as Level] ?? LEVELS.info
}

function encode(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
  return v
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false
  if (Array.isArray(v) || v instanceof Error) return false
  return Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null
}

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold()) return
  const payload: Record<string, unknown> = { t: new Date().toISOString(), level }
  if (args.length === 0) {
    payload.msg = ""
  } else if (args.length === 1 && args[0] instanceof Error) {
    payload.msg = "error"
    payload.err = encode(args[0])
  } else {
    const last = args[args.length - 1]
    if (args.length >= 2 && typeof args[0] === "string" && isPlainObject(last)) {
      const fields = args.pop() as Record<string, unknown>
      payload.msg = args.length === 1 ? (args[0] as string) : format(...args)
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) payload[k] = encode(v)
      }
    } else {
      payload.msg = format(...args)
    }
  }
  const line = JSON.stringify(payload)
  if (level === "error" || level === "warn") process.stderr.write(line + "\n")
  else process.stdout.write(line + "\n")
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
}

export const startTime = Date.now()

export function uptimeSeconds(): number {
  return Math.floor((Date.now() - startTime) / 1000)
}

const VERSION = "0.1.0"
export function version(): string {
  return VERSION
}
