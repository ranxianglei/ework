import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

// Regression: the production branch of loadConfig() used to omit the wake
// policy env vars (WORK_WAKE_KINDS / WORK_WAKE_LOGINS / WORK_NO_WAKE_LOGINS /
// WORK_NON_WAKING_AUTHORS), so they were silently ignored outside test mode
// and zod defaults (wakeKinds=["human"]) always won.

const KEYS = [
  "DAEMON_ENV",
  "GITEA_URL",
  "GITEA_TOKEN",
  "BOT_USERNAME",
  "BOT_TOKEN",
  "OPENCODE_BASE_WORKDIR",
  "WORK_WAKE_KINDS",
  "WORK_WAKE_LOGINS",
  "WORK_NO_WAKE_LOGINS",
  "WORK_NON_WAKING_AUTHORS",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setProductionBasics() {
  process.env.DAEMON_ENV = "production";
  process.env.GITEA_URL = "http://127.0.0.1:1";
  process.env.GITEA_TOKEN = "gitea-token";
  process.env.BOT_USERNAME = "ework-daemon";
  process.env.BOT_TOKEN = "bot-token";
  process.env.OPENCODE_BASE_WORKDIR = "/tmp/ework-prod-cfg";
}

describe("production config env mapping (wake policy)", () => {
  test("maps wake policy env vars in production mode", () => {
    setProductionBasics();
    process.env.WORK_WAKE_KINDS = "human,bot";
    process.env.WORK_WAKE_LOGINS = "alice, bob";
    process.env.WORK_NO_WAKE_LOGINS = "carol";
    process.env.WORK_NON_WAKING_AUTHORS = "legacy-bot";

    const cfg = loadConfig();

    expect(cfg.env).toBe("production");
    expect(cfg.daemon.wakeKinds).toEqual(["human", "bot"]);
    expect(cfg.daemon.wakeLogins).toEqual(["alice", "bob"]);
    expect(cfg.daemon.noWakeLogins).toEqual(["carol"]);
    expect(cfg.daemon.nonWakingAuthors).toEqual(["legacy-bot"]);
  });

  test("defaults to human-only wake kinds when unset in production mode", () => {
    setProductionBasics();

    const cfg = loadConfig();

    expect(cfg.daemon.wakeKinds).toEqual(["human"]);
    expect(cfg.daemon.wakeLogins).toEqual([]);
    expect(cfg.daemon.noWakeLogins).toEqual([]);
    expect(cfg.daemon.nonWakingAuthors).toEqual([]);
  });

  test("test-mode mapping still works (no regression in the test branch)", () => {
    process.env.WORK_WAKE_KINDS = "human,bot";

    const cfg = loadConfig();

    expect(cfg.env).toBe("test");
    expect(cfg.daemon.wakeKinds).toEqual(["human", "bot"]);
  });
});
