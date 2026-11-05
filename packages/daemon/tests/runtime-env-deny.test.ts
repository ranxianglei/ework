import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OpencodeBackend } from "../src/runtime/opencode-backend";
import { PiBackend } from "../src/runtime/pi-backend";
import { ENV_DENY_ALWAYS, stripDeniedEnv } from "../src/runtime/env-deny";

// Regression tests for ranxianglei/ework#7: agent-spawned processes must never
// inherit the daemon's engine-DB pointers (they once wiped the production DB
// when a workdir test harness ran with inherited env).

const DANGEROUS = {
  DAEMON_DB_PATH: "/prod/daemon.db",
  WORK_DB_PATH: "/prod/work.db",
  OPENCODE_DB_PATH: "/prod/opencode.db",
  DAEMON_ENV: "production",
};

let TMP = "";
let FAKE_BIN = "";

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "ework-daemon-envdeny-"));
  FAKE_BIN = join(TMP, "fakebin");
  writeFileSync(FAKE_BIN, "#!/bin/sh\nprintenv >&2\nexit 0\n");
  chmodSync(FAKE_BIN, 0o755);
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

async function spawnChildEnv(opts: { model?: string; backend?: "opencode" | "pi" }): Promise<Record<string, string>> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    EWORK_ISSUE: "7",
    ...DANGEROUS,
    OPENCODE_PID: "4242",
    OPENCODE_MODEL: "inherited-model",
  };
  const backend = opts.backend === "pi"
    ? new PiBackend(FAKE_BIN, "test-provider", "test-model")
    : new OpencodeBackend(FAKE_BIN, join(TMP, "opencode.db"));
  const handle = await backend.spawn(
    { workdir: TMP, prompt: "hi", model: opts.model, env },
    { onOutput: () => {}, onSessionId: () => {} },
  );
  await handle.exited;
  return parseEnv(await handle.stderrText);
}

describe("runtime env isolation (ranxianglei/ework#7)", () => {
  it("ENV_DENY_ALWAYS covers the four incident variables", () => {
    const incidentKeys = ["DAEMON_DB_PATH", "WORK_DB_PATH", "OPENCODE_DB_PATH", "DAEMON_ENV"] as const;
    for (const key of incidentKeys) {
      expect(ENV_DENY_ALWAYS).toContain(key);
    }
  });

  it("opencode spawn strips inherited DB-path/mode vars from the child env", async () => {
    const child = await spawnChildEnv({});
    for (const key of Object.keys(DANGEROUS)) expect(child[key]).toBeUndefined();
    expect(child.OPENCODE_PID).toBeUndefined();
    expect(child.EWORK_ISSUE).toBe("7");
    expect(child.HOME).toBeTruthy();
  });

  it("opencode spawn without a model also strips OPENCODE_MODEL", async () => {
    const child = await spawnChildEnv({});
    expect(child.OPENCODE_MODEL).toBeUndefined();
  });

  it("opencode spawn with an explicit model keeps OPENCODE_MODEL", async () => {
    const child = await spawnChildEnv({ model: "test-provider/model-x" });
    expect(child.OPENCODE_MODEL).toBe("inherited-model");
  });

  it("pi spawn strips the same vars", async () => {
    const child = await spawnChildEnv({ backend: "pi" });
    for (const key of Object.keys(DANGEROUS)) expect(child[key]).toBeUndefined();
    expect(child.EWORK_ISSUE).toBe("7");
  });

  it("stripDeniedEnv removes extraDeny keys and never mutates its input", () => {
    const input = { A: "1", B: "2", WORK_DB_PATH: "x" };
    const out = stripDeniedEnv(input, ["A"]);
    expect(out.A).toBeUndefined();
    expect(out.WORK_DB_PATH).toBeUndefined();
    expect(out.B).toBe("2");
    expect(input.A).toBe("1");
  });
});
