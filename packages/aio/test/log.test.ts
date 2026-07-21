import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Logger } from "../src/log.ts";

// Capture stream that records everything written to it. isTTY=true so
// colorEnabled's fallback branch (stream.isTTY) returns true, letting us
// observe whether color was actually emitted.
function captureStream(tty = true) {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    },
    isTTY: tty,
  };
  return { stream, chunks: () => chunks.join("") };
}

describe("Logger: color output", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Strip both vars so each test sets its own.
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("emits ANSI color codes when isTTY=true and no NO_COLOR", () => {
    const out = captureStream(true);
    const logger = new Logger({ stdout: out.stream, stderr: out.stream });
    logger.ok("hello");
    expect(out.chunks()).toMatch(/\x1b\[32m/); // green
  });

  it("strips color when NO_COLOR=1 (truthy, original behavior)", () => {
    process.env.NO_COLOR = "1";
    const out = captureStream(true);
    const logger = new Logger({ stdout: out.stream, stderr: out.stream });
    logger.ok("hello");
    expect(out.chunks()).not.toMatch(/\x1b\[/);
  });

  // Per no-color.org spec: ANY presence of NO_COLOR (including the empty
  // string) disables color. The naive `if (process.env.NO_COLOR)` truthy
  // check treated NO_COLOR= as "not set" — violating the spec.
  it("strips color when NO_COLOR= (empty string, spec compliance)", () => {
    process.env.NO_COLOR = "";
    const out = captureStream(true);
    const logger = new Logger({ stdout: out.stream, stderr: out.stream });
    logger.ok("hello");
    expect(out.chunks()).not.toMatch(/\x1b\[/);
  });

  it("FORCE_COLOR=1 overrides NO_COLOR absence and emits color even when not a TTY", () => {
    process.env.FORCE_COLOR = "1";
    const out = captureStream(false);
    const logger = new Logger({ stdout: out.stream, stderr: out.stream });
    logger.ok("hello");
    expect(out.chunks()).toMatch(/\x1b\[32m/);
  });

  it("NO_COLOR takes precedence over FORCE_COLOR (spec: NO_COLOR wins)", () => {
    process.env.NO_COLOR = "";
    process.env.FORCE_COLOR = "1";
    const out = captureStream(true);
    const logger = new Logger({ stdout: out.stream, stderr: out.stream });
    logger.ok("hello");
    expect(out.chunks()).not.toMatch(/\x1b\[/);
  });

  it("no color when not a TTY and neither env var set", () => {
    const out = captureStream(false);
    const logger = new Logger({ stdout: out.stream, stderr: out.stream });
    logger.ok("hello");
    expect(out.chunks()).not.toMatch(/\x1b\[/);
  });
});
