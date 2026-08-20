import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { PiBackend } from "../src/runtime/pi-backend";

// PiBackend session bookkeeping against a synthetic ~/.pi/agent/sessions tree.
// Real layout (verified against pi-stable 0.83.5): sessions/<project-dir>/<ts>_<uuid>.jsonl
// where each line is an AgentSessionEvent; assistant tokens live in
// message.usage.output of {type:"message"} events.

let root: string;
let savedSessionDir: string | undefined;
let savedAgentDir: string | undefined;

beforeEach(() => {
  root = `/tmp/ework-pi-backend-test-${process.pid}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "sessions", "--proj-a--"), { recursive: true });
  savedSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = savedSessionDir;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

const SID = "0aaa1111-2222-3333-4444-555566667777";

function writeSession(lines: unknown[]) {
  const file = join(root, "sessions", "--proj-a--", `2026-08-20T00-00-00-000Z_${SID}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("PiBackend session file lookup", () => {
  test("sessionExists finds sessions nested in project dirs", async () => {
    writeSession([{ type: "session", id: SID }]);
    const be = new PiBackend("pi", "vllm", undefined);
    expect(await be.sessionExists(SID)).toBe(true);
  });

  test("sessionExists is false for unknown ids and empty input", async () => {
    writeSession([{ type: "session", id: SID }]);
    const be = new PiBackend("pi", "vllm", undefined);
    expect(await be.sessionExists("ffffffff-0000-0000-0000-000000000000")).toBe(false);
    expect(await be.sessionExists("")).toBe(false);
  });

  test("sessionExists tolerates a missing sessions dir", async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "nope");
    const be = new PiBackend("pi", "vllm", undefined);
    expect(await be.sessionExists(SID)).toBe(false);
  });
});

describe("PiBackend getSessionOutputTokens", () => {
  test("sums usage.output across assistant messages", async () => {
    writeSession([
      { type: "session", id: SID },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", message: { role: "assistant", usage: { input: 10, output: 7 }, content: [{ type: "thinking" }, { type: "toolCall" }] } },
      { type: "message", message: { role: "assistant", usage: { input: 20, output: 5 }, content: [{ type: "text", text: "done" }] } },
    ]);
    const be = new PiBackend("pi", "vllm", undefined);
    const r = await be.getSessionOutputTokens(SID);
    expect(r.hasOutput).toBe(true);
    expect(r.tokenCount).toBe(12);
  });

  test("assistant with zero output tokens reports no output", async () => {
    writeSession([
      { type: "session", id: SID },
      { type: "message", message: { role: "assistant", usage: { input: 10, output: 0 }, content: [] } },
    ]);
    const be = new PiBackend("pi", "vllm", undefined);
    const r = await be.getSessionOutputTokens(SID);
    expect(r.hasOutput).toBe(false);
    expect(r.tokenCount).toBe(0);
  });

  test("undefined session id counts as having output", async () => {
    const be = new PiBackend("pi", "vllm", undefined);
    expect(await be.getSessionOutputTokens(undefined)).toEqual({ hasOutput: true, tokenCount: 0 });
  });

  test("unknown session file counts as having output (fail-open)", async () => {
    writeSession([{ type: "session", id: SID }]);
    const be = new PiBackend("pi", "vllm", undefined);
    const r = await be.getSessionOutputTokens("00000000-0000-0000-0000-000000000000");
    expect(r.hasOutput).toBe(true);
  });
});
