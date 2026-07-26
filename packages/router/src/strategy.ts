import type { Config } from "./config.ts";
import type { DaemonInfo, RouteContext, RouteDecision } from "./types.ts";

export interface RouteStrategy {
  name: string;
  decide(daemons: DaemonInfo[], ctx: RouteContext, cfg: Config): RouteDecision;
}

export interface RouteStrategyConfig {
  strategy: "least-loaded" | "round-robin" | "first-available" | "group";
  groupBindings?: Record<string, string>;
  daemonGroups?: Record<number, string[]>;
  weights?: Record<number, number>;
}

let strategyConfig: RouteStrategyConfig = { strategy: "least-loaded" };
let roundRobinIndex = 0;

export function setStrategyConfig(cfg: RouteStrategyConfig): void {
  strategyConfig = cfg;
  roundRobinIndex = 0;
}

export function getStrategyConfig(): RouteStrategyConfig {
  return strategyConfig;
}

export function resolveStrategy(name: string): RouteStrategy {
  switch (name) {
    case "least-loaded":
      return leastLoaded;
    case "round-robin":
      return roundRobin;
    case "first-available":
      return firstAvailable;
    case "group":
      return groupStrategy;
    default:
      return leastLoaded;
  }
}

const leastLoaded: RouteStrategy = {
  name: "least-loaded",
  decide(daemons: DaemonInfo[], _ctx: RouteContext, _cfg: Config): RouteDecision {
    if (daemons.length === 0) {
      return { daemon: null, reason: "no active daemons", candidates: [] };
    }
    const sorted = [...daemons].sort((a, b) => {
      const loadA = a.activeSessions / Math.max(a.capacity, 1);
      const loadB = b.activeSessions / Math.max(b.capacity, 1);
      if (loadA !== loadB) return loadA - loadB;
      return a.id - b.id;
    });
    return { daemon: sorted[0] ?? null, reason: "least-loaded", candidates: sorted };
  },
};

const roundRobin: RouteStrategy = {
  name: "round-robin",
  decide(daemons: DaemonInfo[], _ctx: RouteContext, _cfg: Config): RouteDecision {
    if (daemons.length === 0) {
      return { daemon: null, reason: "no active daemons", candidates: [] };
    }
    const idx = roundRobinIndex % daemons.length;
    roundRobinIndex++;
    return { daemon: daemons[idx] ?? null, reason: `round-robin #${idx}`, candidates: daemons };
  },
};

const firstAvailable: RouteStrategy = {
  name: "first-available",
  decide(daemons: DaemonInfo[], _ctx: RouteContext, _cfg: Config): RouteDecision {
    if (daemons.length === 0) {
      return { daemon: null, reason: "no active daemons", candidates: [] };
    }
    return { daemon: daemons[0] ?? null, reason: "first-available", candidates: daemons };
  },
};

const groupStrategy: RouteStrategy = {
  name: "group",
  decide(daemons: DaemonInfo[], ctx: RouteContext, _cfg: Config): RouteDecision {
    if (daemons.length === 0) {
      return { daemon: null, reason: "no active daemons", candidates: [] };
    }

    const repoKey = ctx.repository
      ? `${ctx.repository.owner ?? ""}/${ctx.repository.name ?? ""}`
      : "";
    const targetGroup = strategyConfig.groupBindings?.[repoKey];

    if (!targetGroup) {
      const sorted = [...daemons].sort((a, b) => {
        const loadA = a.activeSessions / Math.max(a.capacity, 1);
        const loadB = b.activeSessions / Math.max(b.capacity, 1);
        return loadA - loadB;
      });
      return { daemon: sorted[0] ?? null, reason: `no group binding for ${repoKey}, fallback least-loaded`, candidates: sorted };
    }

    const filtered = daemons.filter((d) =>
      strategyConfig.daemonGroups?.[d.id]?.includes(targetGroup)
    );

    if (filtered.length === 0) {
      return { daemon: null, reason: `no daemons in group "${targetGroup}"`, candidates: [] };
    }

    const sorted = [...filtered].sort((a, b) => {
      const loadA = a.activeSessions / Math.max(a.capacity, 1);
      const loadB = b.activeSessions / Math.max(b.capacity, 1);
      return loadA - loadB;
    });
    return { daemon: sorted[0] ?? null, reason: `group:${targetGroup}`, candidates: sorted };
  },
};

export function route(daemons: DaemonInfo[], ctx: RouteContext, cfg: Config): RouteDecision {
  const strategyName = strategyConfig.strategy || cfg.ROUTER_STRATEGY;
  const strategy = resolveStrategy(strategyName);
  return strategy.decide(daemons, ctx, cfg);
}
