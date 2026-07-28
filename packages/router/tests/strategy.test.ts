import { describe, expect, test, beforeEach } from "bun:test";
import {
  route,
  resolveGroupConfig,
  setStrategyConfig,
} from "../src/strategy.ts";
import type { DaemonInfo, RouteContext } from "../src/types.ts";

/**
 * strategy.ts holds module-level state: `strategyConfig` and `roundRobinIndex`.
 * `setStrategyConfig()` resets BOTH, so beforeEach uses it to keep tests
 * order-independent. The strategy consts are not exported, so we drive them
 * through the public `route()` by switching the active strategy.
 */

function mkDaemon(id: number, opts: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    id,
    displayName: opts.displayName ?? `daemon-${id}`,
    endpoint: opts.endpoint ?? `http://127.0.0.1:${3000 + id}`,
    capacity: opts.capacity ?? 10,
    lastHeartbeat: opts.lastHeartbeat ?? "2025-01-01T00:00:00.000Z",
    status: opts.status ?? "active",
    activeSessions: opts.activeSessions ?? 0,
  };
}

const baseCtx: RouteContext = {
  eventType: "issue.opened",
  raw: {},
};

// route() only reads cfg.ROUTER_STRATEGY as a fallback when strategyConfig.strategy
// is falsy; every test sets it explicitly, so a stub cast is safe.
const cfg = { ROUTER_STRATEGY: "least-loaded" } as unknown as Parameters<
  typeof route
>[2];

const widgetsCtx: RouteContext = {
  eventType: "issue.opened",
  repository: { owner: "acme", name: "widgets" },
  raw: {},
};

beforeEach(() => {
  setStrategyConfig({ strategy: "least-loaded" });
});

describe("least-loaded strategy", () => {
  test("picks the daemon with the lower active/capacity load ratio", () => {
    setStrategyConfig({ strategy: "least-loaded" });
    const busy = mkDaemon(1, { capacity: 10, activeSessions: 8 });
    const idle = mkDaemon(2, { capacity: 10, activeSessions: 2 });

    const decision = route([busy, idle], baseCtx, cfg);

    expect(decision.daemon?.id).toBe(2);
    expect(decision.reason).toBe("least-loaded");
    expect(decision.candidates.map((d) => d.id)).toEqual([2, 1]);
  });

  test("on a load tie, the lower daemon id wins", () => {
    setStrategyConfig({ strategy: "least-loaded" });
    const high = mkDaemon(5, { capacity: 10, activeSessions: 5 });
    const low = mkDaemon(2, { capacity: 10, activeSessions: 5 });

    const decision = route([high, low], baseCtx, cfg);

    expect(decision.daemon?.id).toBe(2);
  });

  test("empty daemon list returns null daemon", () => {
    setStrategyConfig({ strategy: "least-loaded" });
    const decision = route([], baseCtx, cfg);

    expect(decision.daemon).toBeNull();
    expect(decision.reason).toBe("no active daemons");
    expect(decision.candidates).toEqual([]);
  });
});

describe("round-robin strategy", () => {
  test("three sequential calls over two daemons advance the index and wrap", () => {
    setStrategyConfig({ strategy: "round-robin" });
    const daemons = [mkDaemon(1), mkDaemon(2)];

    const r1 = route(daemons, baseCtx, cfg);
    const r2 = route(daemons, baseCtx, cfg);
    const r3 = route(daemons, baseCtx, cfg);

    expect(r1.daemon?.id).toBe(1);
    expect(r1.reason).toBe("round-robin #0");

    expect(r2.daemon?.id).toBe(2);
    expect(r2.reason).toBe("round-robin #1");

    expect(r3.daemon?.id).toBe(1);
    expect(r3.reason).toBe("round-robin #0");

    expect(r1.candidates.map((d) => d.id)).toEqual([1, 2]);
  });
});

describe("first-available strategy", () => {
  test("returns the first daemon in the input list regardless of load", () => {
    setStrategyConfig({ strategy: "first-available" });
    const first = mkDaemon(1, { capacity: 10, activeSessions: 10 });
    const second = mkDaemon(2, { capacity: 10, activeSessions: 0 });

    const decision = route([first, second], baseCtx, cfg);

    expect(decision.daemon?.id).toBe(1);
    expect(decision.reason).toBe("first-available");
    expect(decision.candidates.map((d) => d.id)).toEqual([1, 2]);
  });

  test("empty daemon list returns null daemon", () => {
    setStrategyConfig({ strategy: "first-available" });
    const decision = route([], baseCtx, cfg);

    expect(decision.daemon).toBeNull();
    expect(decision.reason).toBe("no active daemons");
  });
});

describe("group strategy", () => {
  test("with a group binding, only daemons in the bound group are candidates", () => {
    setStrategyConfig({
      strategy: "group",
      groupBindings: { "acme/widgets": "gpu" },
      daemonGroups: {
        1: ["default"],
        2: ["gpu"],
        3: ["gpu", "default"],
      },
    });
    const outsider = mkDaemon(1, { capacity: 10, activeSessions: 0 });
    const midLoad = mkDaemon(2, { capacity: 10, activeSessions: 5 });
    const lowLoad = mkDaemon(3, { capacity: 10, activeSessions: 1 });

    const decision = route([outsider, midLoad, lowLoad], widgetsCtx, cfg);

    expect(decision.daemon?.id).toBe(3);
    expect(decision.candidates.map((d) => d.id)).toEqual([3, 2]);
    expect(decision.reason).toBe("group:gpu");
  });

  test("without a binding, falls back to least-loaded across all daemons", () => {
    setStrategyConfig({ strategy: "group" });
    const busy = mkDaemon(1, { capacity: 10, activeSessions: 9 });
    const idle = mkDaemon(2, { capacity: 10, activeSessions: 1 });

    const decision = route([busy, idle], widgetsCtx, cfg);

    expect(decision.daemon?.id).toBe(2);
    expect(decision.reason).toBe(
      "no group binding for acme/widgets, fallback least-loaded",
    );
  });

  test("binding pointing at an empty group returns daemon: null", () => {
    setStrategyConfig({
      strategy: "group",
      groupBindings: { "acme/widgets": "ghost" },
      daemonGroups: { 1: ["default"] },
    });
    const d1 = mkDaemon(1);

    const decision = route([d1], widgetsCtx, cfg);

    expect(decision.daemon).toBeNull();
    expect(decision.candidates).toEqual([]);
    expect(decision.reason).toBe('no daemons in group "ghost"');
  });
});

describe("resolveGroupConfig", () => {
  test("returns the GroupConfig when binding and groupConfigs entry both exist", () => {
    setStrategyConfig({
      strategy: "least-loaded",
      groupBindings: { "acme/widgets": "gpu" },
      groupConfigs: {
        gpu: {
          workdirTemplate: "/tmp/gpu/{repo}",
          initScript: "init.sh",
          destroyScript: "destroy.sh",
        },
      },
    });

    const gc = resolveGroupConfig("acme/widgets");
    expect(gc).toBeDefined();
    expect(gc?.workdirTemplate).toBe("/tmp/gpu/{repo}");
    expect(gc?.initScript).toBe("init.sh");
    expect(gc?.destroyScript).toBe("destroy.sh");
  });

  test("returns undefined when no binding exists for the repo key", () => {
    setStrategyConfig({ strategy: "least-loaded" });
    expect(resolveGroupConfig("acme/widgets")).toBeUndefined();
  });

  test("returns undefined when binding exists but groupConfigs has no entry", () => {
    setStrategyConfig({
      strategy: "least-loaded",
      groupBindings: { "acme/widgets": "gpu" },
    });
    expect(resolveGroupConfig("acme/widgets")).toBeUndefined();
  });
});

describe("route() attaches groupConfig to the decision", () => {
  test("sets decision.groupConfig when binding + groupConfig exist", () => {
    setStrategyConfig({
      strategy: "least-loaded",
      groupBindings: { "acme/widgets": "gpu" },
      groupConfigs: {
        gpu: { workdirTemplate: "/tmp/gpu/{repo}", initScript: "init.sh" },
      },
    });
    const d1 = mkDaemon(1);

    const decision = route([d1], widgetsCtx, cfg);

    expect(decision.daemon?.id).toBe(1);
    expect(decision.groupConfig).toBeDefined();
    expect(decision.groupConfig?.workdirTemplate).toBe("/tmp/gpu/{repo}");
    expect(decision.groupConfig?.initScript).toBe("init.sh");
  });

  test("groupConfig is undefined when repo has no binding", () => {
    setStrategyConfig({ strategy: "least-loaded" });
    const d1 = mkDaemon(1);

    const decision = route([d1], widgetsCtx, cfg);

    expect(decision.daemon?.id).toBe(1);
    expect(decision.groupConfig).toBeUndefined();
  });
});
