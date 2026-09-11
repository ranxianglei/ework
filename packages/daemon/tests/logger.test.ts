import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { log, uptimeSeconds, version } from "../src/logger"

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
  delete process.env.WORK_LOG_LEVEL
})

describe("log routing", () => {
  test("info/debug to stdout, warn/error to stderr", () => {
    process.env.WORK_LOG_LEVEL = "debug"
    log.info("i")
    log.debug("d")
    log.warn("w")
    log.error("e")
    expect(stdoutLines.length).toBe(2)
    expect(stderrLines.length).toBe(2)
  })

  test("default level info suppresses debug", () => {
    log.info("yes")
    log.debug("no")
    expect(stdoutLines.some(l => l.includes('"msg":"yes"'))).toBe(true)
    expect(stdoutLines.some(l => l.includes('"msg":"no"'))).toBe(false)
  })
})

describe("calling conventions", () => {
  test("log.info(string) → {msg: string}", () => {
    log.info("hello")
    expect(stdoutLines[0]).toContain('"msg":"hello"')
  })

  test("log.info(msg, fields) → merged fields", () => {
    log.info("hello", { k: "v", n: 5 })
    const parsed = JSON.parse(stdoutLines[0]!)
    expect(parsed.msg).toBe("hello")
    expect(parsed.k).toBe("v")
    expect(parsed.n).toBe(5)
  })

  test("log.info(template literal) → formatted msg", () => {
    const k = "issue#5"
    log.info(`engine: started for ${k}`)
    expect(stdoutLines[0]).toContain('"msg":"engine: started for issue#5"')
  })

  test("log.info(string, error) → util.format inlines error", () => {
    const e = new Error("boom")
    log.info("caught:", e)
    expect(stdoutLines[0]).toContain("Error: boom")
  })

  test("log.error(msg, {err}) → err serialized as {name, message, stack}", () => {
    const e = new Error("boom")
    log.error("failed", { err: e })
    const parsed = JSON.parse(stderrLines[0]!)
    expect(parsed.msg).toBe("failed")
    expect(parsed.err.name).toBe("Error")
    expect(parsed.err.message).toBe("boom")
    expect(typeof parsed.err.stack).toBe("string")
  })

  test("log.info() with no args → empty msg", () => {
    log.info()
    const parsed = JSON.parse(stdoutLines[0]!)
    expect(parsed.msg).toBe("")
  })

  test("log.info(error) alone → msg='error', err field set", () => {
    const e = new Error("solo")
    log.info(e)
    const parsed = JSON.parse(stdoutLines[0]!)
    expect(parsed.msg).toBe("error")
    expect(parsed.err.message).toBe("solo")
  })

  test("printf-style %s interpolation works", () => {
    log.info("count: %d, name: %s", 5, "alice")
    expect(stdoutLines[0]).toContain('"msg":"count: 5, name: alice"')
  })

  test("undefined fields are dropped from {msg, fields}", () => {
    log.info("m", { a: undefined, b: 1 })
    expect(stdoutLines[0]).not.toContain('"a"')
    expect(stdoutLines[0]).toContain('"b":1')
  })

  test("non-plain-object last arg is treated as format arg, not fields", () => {
    log.info("ids:", [1, 2, 3])
    expect(stdoutLines[0]).toContain("[ 1, 2, 3 ]")
  })

  test("every line includes ISO timestamp under 't'", () => {
    log.info("x")
    const parsed = JSON.parse(stdoutLines[0]!)
    expect(parsed.t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe("WORK_LOG_LEVEL", () => {
  test("=error suppresses info and warn", () => {
    process.env.WORK_LOG_LEVEL = "error"
    log.info("nope")
    log.warn("nope")
    log.error("yes")
    expect(stdoutLines.length).toBe(0)
    expect(stderrLines.length).toBe(1)
  })

  test("=debug emits debug too", () => {
    process.env.WORK_LOG_LEVEL = "debug"
    log.debug("dbg")
    expect(stdoutLines.some(l => l.includes('"level":"debug"'))).toBe(true)
  })

  test("invalid value falls back to info", () => {
    process.env.WORK_LOG_LEVEL = "chatty"
    log.info("yes")
    log.debug("no")
    expect(stdoutLines.some(l => l.includes('"msg":"yes"'))).toBe(true)
    expect(stdoutLines.some(l => l.includes('"msg":"no"'))).toBe(false)
  })
})

describe("uptimeSeconds + version", () => {
  test("uptimeSeconds returns non-negative integer", () => {
    const u = uptimeSeconds()
    expect(Number.isInteger(u)).toBe(true)
    expect(u).toBeGreaterThanOrEqual(0)
  })

  test("version returns semver", () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
