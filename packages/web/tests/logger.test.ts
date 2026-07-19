import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { log, uptimeSeconds, version } from "../src/logger"

const ORIGINAL_LEVEL = process.env.WORK_LOG_LEVEL
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout)
const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr)

let stdoutLines: string[] = []
let stderrLines: string[] = []

beforeEach(() => {
  stdoutLines = []
  stderrLines = []
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdoutLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  }
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  }
})

afterEach(() => {
  process.stdout.write = ORIGINAL_STDOUT_WRITE
  process.stderr.write = ORIGINAL_STDERR_WRITE
})

describe("log levels", () => {
  test("default level info emits info/warn/error to expected streams", () => {
    delete process.env.WORK_LOG_LEVEL
    log.info("hello", { k: "v" })
    log.warn("warn-here")
    log.error("err-here")
    log.debug("should-not-emit")

    expect(stdoutLines.length).toBe(1)
    expect(stderrLines.length).toBe(2)
    expect(stdoutLines[0]).toContain('"level":"info"')
    expect(stdoutLines[0]).toContain('"msg":"hello"')
    expect(stdoutLines[0]).toContain('"k":"v"')
    expect(stderrLines.some(l => l.includes('"level":"warn"'))).toBe(true)
    expect(stderrLines.some(l => l.includes('"level":"error"'))).toBe(true)
  })

  test("WORK_LOG_LEVEL=debug emits debug too", () => {
    process.env.WORK_LOG_LEVEL = "debug"
    log.debug("dbg")
    expect(stdoutLines.some(l => l.includes('"level":"debug"'))).toBe(true)
  })

  test("WORK_LOG_LEVEL=error suppresses info and warn", () => {
    process.env.WORK_LOG_LEVEL = "error"
    log.info("nope")
    log.warn("nope")
    log.error("yes")
    expect(stdoutLines.length).toBe(0)
    expect(stderrLines.length).toBe(1)
    expect(stderrLines[0]).toContain('"level":"error"')
  })

  test("invalid level falls back to info", () => {
    process.env.WORK_LOG_LEVEL = "chatty"
    log.info("yes")
    log.debug("no")
    expect(stdoutLines.some(l => l.includes('"level":"info"'))).toBe(true)
    expect(stdoutLines.some(l => l.includes('"level":"debug"'))).toBe(false)
  })

  test("Error objects are serialized as {name, message, stack}", () => {
    const e = new Error("boom")
    log.error("failed", { err: e })
    const line = stderrLines[0]!
    expect(line).toContain('"name":"Error"')
    expect(line).toContain('"message":"boom"')
    expect(line).toContain('"stack"')
  })

  test("undefined fields are dropped", () => {
    log.info("m", { a: undefined, b: 1 })
    expect(stdoutLines[0]).not.toContain('"a"')
    expect(stdoutLines[0]).toContain('"b":1')
  })

  test("each line includes ISO timestamp under 't'", () => {
    log.info("x")
    const parsed = JSON.parse(stdoutLines[0]!)
    expect(parsed.t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe("uptimeSeconds", () => {
  test("returns a non-negative integer", () => {
    const u = uptimeSeconds()
    expect(Number.isInteger(u)).toBe(true)
    expect(u).toBeGreaterThanOrEqual(0)
  })
})

describe("version", () => {
  test("returns semver string", () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

void ORIGINAL_LEVEL
