import { describe, expect, it } from "bun:test";

describe("infra night boost (00:00-08:00 CST)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Engine } = require("../src/opencode") as { Engine: any };

  function makeSelf(hour: number, boost = true, maxConcurrent = 8) {
    const self = Object.create(Engine.prototype) as Record<string, any>;
    self.infraNightBoost = boost;
    self.maxConcurrent = maxConcurrent;
    self.now = () => Date.UTC(2026, 9, 20, hour, 0, 0);
    self.infraNightActive = function (this: any) {
      if (!this.infraNightBoost) return false;
      const cstHour = (new Date(this.now()).getUTCHours() + 8) % 24;
      return cstHour < 8;
    };
    return self;
  }

  it("UTC 15:59 (CST 23:59) is day; UTC 16:00 (CST 00:00) through UTC 23:59 (CST 07:59) is night", () => {
    expect(makeSelf(15).infraNightActive()).toBe(false);
    expect(makeSelf(16).infraNightActive()).toBe(true);
    expect(makeSelf(23).infraNightActive()).toBe(true);
    expect(makeSelf(0).infraNightActive()).toBe(false);
  });

  it("kill switch disables the window", () => {
    expect(makeSelf(16, false).infraNightActive()).toBe(false);
  });

  it("issue lanes halve at night only when infra work demands slots; infra keys keep the full cap", () => {
    const day = makeSelf(10);
    expect(day.effectiveGlobalCap(undefined)).toBe(8);
    const quietNight = makeSelf(17);
    quietNight.pendingInfraCount = 0;
    quietNight.running = new Map([["k1", { pid: 1 }]]);
    quietNight.lastOutputAt = new Map();
    quietNight.apiIdleGraceMs = 180_000;
    quietNight.startedAt = new Map();
    expect(quietNight.effectiveGlobalCap(undefined)).toBe(8);
    const busyNight = makeSelf(17);
    busyNight.pendingInfraCount = 2;
    busyNight.running = new Map();
    busyNight.lastOutputAt = new Map();
    busyNight.apiIdleGraceMs = 180_000;
    busyNight.startedAt = new Map();
    expect(busyNight.effectiveGlobalCap(undefined)).toBe(4);
    expect(busyNight.effectiveGlobalCap("merge-conflict-123-1")).toBe(8);
    expect(busyNight.effectiveGlobalCap("ci-fail-9-abc")).toBe(8);
    const runningInfra = makeSelf(17);
    runningInfra.pendingInfraCount = 0;
    runningInfra.running = new Map([["x@conflict-worker", { pid: 1 }]]);
    runningInfra.lastOutputAt = new Map();
    runningInfra.apiIdleGraceMs = 180_000;
    runningInfra.startedAt = new Map();
    expect(runningInfra.effectiveGlobalCap(undefined)).toBe(4);
  });
});
