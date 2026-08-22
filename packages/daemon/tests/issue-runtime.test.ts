import { describe, test, expect } from "bun:test";
import { Engine } from "../src/opencode";
import { configSchema } from "../src/config";
import type { Config } from "../src/config";
import { OpencodeBackend } from "../src/runtime/opencode-backend";
import { PiBackend } from "../src/runtime/pi-backend";

function makeConfig(runtime: "opencode" | "pi"): Config {
  const parsed = configSchema.safeParse({
    env: "test",
    gitea: { url: "http://127.0.0.1:3300", token: "t" },
    bot: { username: "ework-daemon", token: "t" },
    daemon: {},
    opencode: {},
    work: {},
    db: { path: "/tmp/ework-runtime-test.db" },
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  const cfg = parsed.data as Config;
  cfg.runtime = runtime;
  cfg.pi = { binary: "pi", provider: "bailian", defaultModel: "" };
  return cfg;
}

function makeEngine(runtime: "opencode" | "pi"): Engine {
  const stubStore = { listOwnedSessions: async () => [], getOwnedPendingOrRunningMessages: async () => [] } as never;
  return new Engine(makeConfig(runtime), stubStore, { get: () => undefined } as never, { daemonId: 1 });
}

const SESSION_KEY = "gitea:dog/test1#8@ework-daemon";
const ISSUE_KEY = "gitea:dog/test1#8";

type Guts = { issueRuntimes: Map<string, string>; backendFor: (k: string, s?: string) => unknown };

function guts(e: Engine): Guts {
  return e as unknown as Guts;
}

describe("Engine.backendFor — per-issue runtime", () => {
  test("default daemon (opencode) + issue runtime=pi → PiBackend", () => {
    const e = guts(makeEngine("opencode"));
    e.issueRuntimes.set(ISSUE_KEY, "pi");
    expect(e.backendFor(SESSION_KEY)).toBeInstanceOf(PiBackend);
  });

  test("default daemon (opencode) + no override → default backend", () => {
    const e = guts(makeEngine("opencode"));
    expect(e.backendFor(SESSION_KEY)).toBeInstanceOf(OpencodeBackend);
  });

  test("override matching daemon runtime → default backend", () => {
    const e = guts(makeEngine("opencode"));
    e.issueRuntimes.set(ISSUE_KEY, "opencode");
    expect(e.backendFor(SESSION_KEY)).toBeInstanceOf(OpencodeBackend);
  });

  test("pi daemon + issue runtime=opencode → OpencodeBackend", () => {
    const e = guts(makeEngine("pi"));
    e.issueRuntimes.set(ISSUE_KEY, "opencode");
    expect(e.backendFor(SESSION_KEY)).toBeInstanceOf(OpencodeBackend);
  });

  test("existing ses_ session pins opencode even when issue says pi", () => {
    const e = guts(makeEngine("opencode"));
    e.issueRuntimes.set(ISSUE_KEY, "pi");
    expect(e.backendFor(SESSION_KEY, "ses_abc123")).toBeInstanceOf(OpencodeBackend);
  });

  test("existing bare-uuid session pins pi even when issue says opencode", () => {
    const e = guts(makeEngine("opencode"));
    e.issueRuntimes.set(ISSUE_KEY, "opencode");
    expect(e.backendFor(SESSION_KEY, "1b0e6c8a-1234-4def-9876-aabbccddeeff")).toBeInstanceOf(PiBackend);
  });
});
