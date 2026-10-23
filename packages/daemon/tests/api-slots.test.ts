import { describe, expect, test } from "bun:test";

describe("API-slot accounting (owner policy 2026-10-23)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeSelf(opts: { maxConcurrent?: number; graceMs?: number } = {}): any {
    const self = Object.create(Engine.prototype) as Record<string, unknown>;
    self.maxConcurrent = opts.maxConcurrent ?? 8;
    self.apiIdleGraceMs = opts.graceMs ?? 180_000;
    self.running = new Map();
    self.lastOutputAt = new Map();
    self.startedAt = new Map();
    self.pendingInfraCount = 0;
    self.infraNightBoost = false;
    return self as any;
  }

  test("sessions with recent output occupy a slot; silent ones release it", () => {
    const self = makeSelf();
    const now = Date.now();
    self.running.set("a", {});
    self.running.set("b", {});
    self.running.set("c", {});
    self.lastOutputAt.set("a", now - 10_000);
    self.lastOutputAt.set("b", now - 179_000);
    self.lastOutputAt.set("c", now - 181_000);
    expect(Engine.prototype.activeRunningCount.call(self, now)).toBe(2);
  });

  test("missing output map falls back to startedAt, then to active", () => {
    const self = makeSelf();
    const now = Date.now();
    self.running.set("fresh", {});
    self.startedAt.set("fresh", now - 5_000);
    self.running.set("no-history", {});
    expect(Engine.prototype.activeRunningCount.call(self, now)).toBe(2);
  });

  test("slot frees when an agent goes silent past grace (process still alive)", () => {
    const self = makeSelf({ maxConcurrent: 2 });
    const now = Date.now();
    self.running.set("a", {});
    self.running.set("b", {});
    self.lastOutputAt.set("a", now - 1_000);
    self.lastOutputAt.set("b", now - 500_000);
    expect(Engine.prototype.slotAvailable.call(self)).toBe(true);
  });

  test("slot blocked when API-active sessions fill the cap", () => {
    const self = makeSelf({ maxConcurrent: 2 });
    const now = Date.now();
    self.running.set("a", {});
    self.running.set("b", {});
    self.lastOutputAt.set("a", now - 1_000);
    self.lastOutputAt.set("b", now - 2_000);
    expect(Engine.prototype.slotAvailable.call(self)).toBe(false);
  });

  test("hard process ceiling blocks spawns even when all sessions are silent", () => {
    const self = makeSelf({ maxConcurrent: 2 });
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      self.running.set(`k${i}`, {});
      self.lastOutputAt.set(`k${i}`, now - 1_000_000);
    }
    expect(Engine.prototype.activeRunningCount.call(self, now)).toBe(0);
    expect(Engine.prototype.slotAvailable.call(self)).toBe(false);
  });
});
