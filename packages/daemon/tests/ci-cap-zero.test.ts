import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

// Regression (2026-10-31): the owner kill-switch WORK_CI_FIX_MAX_ATTEMPTS=0
// was clamped twice over — Math.max(1, …) at parse time AND zod .positive()
// at validation — so "0 = lane fully disabled" silently became 1 and CI
// auto-lanes kept dispatching once per PR per day. Both layers must accept 0.

const KEYS = [
  "DAEMON_ENV",
  "GITEA_URL",
  "GITEA_TOKEN",
  "BOT_USERNAME",
  "BOT_TOKEN",
  "WORK_CI_FIX_MAX_ATTEMPTS",
  "WORK_CONFLICT_FIX_MAX_ATTEMPTS",
  "WORK_MERGE_GUARD_MAX_ATTEMPTS",
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

describe("auto-lane cap kill-switch (0 = disabled)", () => {
  test("production load accepts WORK_CI_FIX_MAX_ATTEMPTS=0 without zod failure", () => {
    process.env.DAEMON_ENV = "production";
    process.env.GITEA_URL = "http://127.0.0.1:3000";
    process.env.GITEA_TOKEN = "x";
    process.env.BOT_USERNAME = "bot";
    process.env.BOT_TOKEN = "x";
    process.env.WORK_CI_FIX_MAX_ATTEMPTS = "0";
    process.env.WORK_CONFLICT_FIX_MAX_ATTEMPTS = "0";
    const cfg = loadConfig();
    expect(cfg.work.ciFixMaxAttempts).toBe(0);
    expect(cfg.work.conflictFixMaxAttempts).toBe(0);
    expect(cfg.work.mergeGuardMaxAttempts).toBe(3); // unset here stays default
  });

  test("production load accepts WORK_MERGE_GUARD_MAX_ATTEMPTS=0 (guard-lane kill-switch, 2026-10-31)", () => {
    process.env.DAEMON_ENV = "production";
    process.env.GITEA_URL = "http://127.0.0.1:3000";
    process.env.GITEA_TOKEN = "x";
    process.env.BOT_USERNAME = "bot";
    process.env.BOT_TOKEN = "x";
    process.env.WORK_MERGE_GUARD_MAX_ATTEMPTS = "0";
    const cfg = loadConfig();
    expect(cfg.work.mergeGuardMaxAttempts).toBe(0);
  });

  test("unset values fall back to the default budget of 3", () => {
    process.env.DAEMON_ENV = "production";
    process.env.GITEA_URL = "http://127.0.0.1:3000";
    process.env.GITEA_TOKEN = "x";
    process.env.BOT_USERNAME = "bot";
    process.env.BOT_TOKEN = "x";
    const cfg = loadConfig();
    expect(cfg.work.ciFixMaxAttempts).toBe(3);
    expect(cfg.work.conflictFixMaxAttempts).toBe(3);
  });
});
