// Top-level env MUST come before any ework import — Bun honors source order
// for module-level statements. Tests that mutate env restore it afterEach.
import { afterEach, describe, expect, test } from "bun:test";

const KEYS = [
  "WORK_PORT",
  "WORK_HOST",
  "WORK_TOKEN",
  "WORK_COOKIE_SECRET",
  "WORK_LOG_LEVEL",
  "WORK_DAEMON_BOT_LOGIN",
  "WORK_DAEMON_WEBHOOK_URL",
  "WORK_DAEMON_WEBHOOK_SECRET",
  "WORK_AUTOWIRE_ACTIVE",
  "WORK_WEBHOOK_MAX_CONCURRENT",
] as const;

const saved: Record<string, string | undefined> = {};
beforeEachSave();

function beforeEachSave() {
  for (const k of KEYS) saved[k] = process.env[k];
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// loadConfig validates env at import time, so each test re-imports the module
// dynamically with the env configured for that case. Module cache is busted
// by adding a cache-bust query — Bun keyed-imports by URL.
async function loadConfigFresh() {
  const bust = `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mod = await import(`../src/config${bust}`);
  return mod.loadConfig();
}

describe("config: WORK_AUTOWIRE_ACTIVE", () => {
  test("default true when env unset", async () => {
    delete process.env.WORK_AUTOWIRE_ACTIVE;
    const cfg = await loadConfigFresh();
    expect(cfg.autowireActive).toBe(true);
  });

  test("'false' string → false", async () => {
    process.env.WORK_AUTOWIRE_ACTIVE = "false";
    const cfg = await loadConfigFresh();
    expect(cfg.autowireActive).toBe(false);
  });

  test("'true' / '1' / anything-non-false → true", async () => {
    for (const v of ["true", "1", "yes", "0", "off", ""]) {
      process.env.WORK_AUTOWIRE_ACTIVE = v;
      const cfg = await loadConfigFresh();
      if (v === "false") expect(cfg.autowireActive).toBe(false);
      else expect(cfg.autowireActive).toBe(true);
    }
  });
});

describe("config: WORK_WEBHOOK_MAX_CONCURRENT", () => {
  test("default 6 when env unset", async () => {
    delete process.env.WORK_WEBHOOK_MAX_CONCURRENT;
    const cfg = await loadConfigFresh();
    expect(cfg.webhookMaxConcurrent).toBe(6);
  });

  test("parses valid integer in range", async () => {
    for (const v of ["1", "12", "64"]) {
      process.env.WORK_WEBHOOK_MAX_CONCURRENT = v;
      const cfg = await loadConfigFresh();
      expect(cfg.webhookMaxConcurrent).toBe(Number(v));
    }
  });

  test("out-of-range falls back to 6", async () => {
    for (const v of ["0", "-1", "65", "100"]) {
      process.env.WORK_WEBHOOK_MAX_CONCURRENT = v;
      const cfg = await loadConfigFresh();
      expect(cfg.webhookMaxConcurrent).toBe(6);
    }
  });

  test("garbage falls back to 6", async () => {
    for (const v of ["abc", "", "NaN"]) {
      process.env.WORK_WEBHOOK_MAX_CONCURRENT = v;
      const cfg = await loadConfigFresh();
      expect(cfg.webhookMaxConcurrent).toBe(6);
    }
  });
});
