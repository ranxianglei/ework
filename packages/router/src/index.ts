import { loadConfig, type Config } from "./config.ts";
import { initDB, closeDB, getActiveDaemons } from "./db.ts";
import { route, setStrategyConfig, getStrategyConfig } from "./strategy.ts";
import type { RouteContext, RouteDecision } from "./types.ts";

function log(level: string, msg: string, fields?: Record<string, unknown>): void {
  const entry = { t: new Date().toISOString(), level, msg, ...fields };
  console.log(JSON.stringify(entry));
}

function parseWebhookEvent(body: unknown): RouteContext {
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const action = String(obj.action ?? "unknown");
  const issue = obj.issue as Record<string, unknown> | undefined;
  const comment = obj.comment as Record<string, unknown> | undefined;
  const repo = obj.repository as Record<string, unknown> | undefined;
  const owner = repo?.owner as Record<string, unknown> | undefined;
  return {
    eventType: action,
    repository: {
      owner: owner?.login ? String(owner.login) : undefined,
      name: repo?.name ? String(repo.name) : undefined,
    },
    issue: {
      number: typeof issue?.number === "number" ? issue.number : undefined,
      title: issue?.title ? String(issue.title) : undefined,
    },
    comment: {
      id: typeof comment?.id === "number" ? comment.id : undefined,
      body: comment?.body ? String(comment.body) : undefined,
    },
    raw: body,
  };
}

async function forwardToDaemon(
  endpoint: string,
  payload: unknown,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = endpoint.replace(/\/$/, "") + "/webhook/gitea";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const fwdHeaders: Record<string, string> = { "Content-Type": "application/json", ...headers };
    const res = await fetch(url, {
      method: "POST",
      headers: fwdHeaders,
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

async function handleWebhook(req: Request, cfg: Config): Promise<Response> {
  const rawBody = await req.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sig = req.headers.get("x-gitea-signature") ?? "";
  const fwdHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (sig) fwdHeaders["x-gitea-signature"] = sig;

  const ctx = parseWebhookEvent(body);
  log("info", "webhook received", { action: ctx.eventType, repo: ctx.repository, issue: ctx.issue?.number });

  const daemons = await getActiveDaemons(cfg);
  if (daemons.length === 0) {
    if (cfg.ROUTER_FALLBACK_ENDPOINT) {
      log("info", "no active daemons, using fallback", { fallback: cfg.ROUTER_FALLBACK_ENDPOINT });
      const result = await forwardToDaemon(cfg.ROUTER_FALLBACK_ENDPOINT, rawBody, cfg.ROUTER_FORWARD_TIMEOUT_MS, fwdHeaders);
      return new Response(JSON.stringify({
        ok: result.ok,
        routed: true,
        daemon: { id: 0, endpoint: cfg.ROUTER_FALLBACK_ENDPOINT },
        reason: "fallback",
        forwardStatus: result.status,
        forwardBody: result.body.slice(0, 500),
      }), {
        status: result.ok ? 200 : 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    log("warn", "no active daemons available");
    return new Response(JSON.stringify({ ok: false, error: "no active daemons", routed: false }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const decision: RouteDecision = route(daemons, ctx, cfg);
  if (!decision.daemon) {
    log("warn", "routing failed", { reason: decision.reason, candidates: decision.candidates.length });
    return new Response(JSON.stringify({ ok: false, error: decision.reason, routed: false }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  log("info", "routing", {
    daemon: decision.daemon.id,
    endpoint: decision.daemon.endpoint,
    reason: decision.reason,
    load: `${decision.daemon.activeSessions}/${decision.daemon.capacity}`,
  });

  const result = await forwardToDaemon(decision.daemon.endpoint, rawBody, cfg.ROUTER_FORWARD_TIMEOUT_MS, fwdHeaders);
  log(result.ok ? "info" : "warn", "forward result", {
    daemon: decision.daemon.id,
    status: result.status,
    ok: result.ok,
  });

  return new Response(JSON.stringify({
    ok: result.ok,
    routed: true,
    daemon: { id: decision.daemon.id, endpoint: decision.daemon.endpoint },
    reason: decision.reason,
    forwardStatus: result.status,
    forwardBody: result.body.slice(0, 500),
  }), {
    status: result.ok ? 200 : 502,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleReply(req: Request, _cfg: Config): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const obj = body as Record<string, unknown>;
  const targetEndpoint = typeof obj.targetEndpoint === "string" ? obj.targetEndpoint : "";
  const replyBody = typeof obj.body === "string" ? obj.body : "";
  const issueNumber = typeof obj.issueNumber === "number" ? obj.issueNumber : undefined;
  const repo = obj.repository as Record<string, unknown> | undefined;

  if (!targetEndpoint) {
    return new Response(JSON.stringify({ ok: false, error: "targetEndpoint required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  log("info", "reply received", { target: targetEndpoint, issue: issueNumber, repo });

  const payload = {
    action: "router_reply",
    issue: { number: issueNumber },
    repository: repo,
    comment: { body: replyBody },
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(targetEndpoint.replace(/\/$/, "") + "/api/router/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const respBody = await res.text();
    log(res.ok ? "info" : "warn", "reply forwarded", { target: targetEndpoint, status: res.status });
    return new Response(JSON.stringify({ ok: res.ok, status: res.status, body: respBody.slice(0, 500) }), {
      status: res.ok ? 200 : 502,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log("error", "reply forward failed", { target: targetEndpoint, error: err });
    return new Response(JSON.stringify({ ok: false, error: err }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function handleStrategy(req: Request): Promise<Response> {
  if (req.method === "GET") {
    return new Response(JSON.stringify(getStrategyConfig()), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (req.method === "POST") {
    try {
      const body = await req.json() as RouteStrategyConfig;
      setStrategyConfig(body);
      log("info", "strategy config updated", { strategy: body.strategy });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  return new Response("Method Not Allowed", { status: 405 });
}

async function handleHealth(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true, service: "ework-router" }), {
    headers: { "Content-Type": "application/json" },
  });
}

import type { RouteStrategyConfig } from "./strategy.ts";

export async function runServer(): Promise<void> {
  const cfg = loadConfig();
  log("info", "ework-router starting", { env: cfg.ROUTER_ENV, port: cfg.ROUTER_PORT });

  await initDB(cfg);
  log("info", "db connected", { driver: cfg.WORK_DB_DRIVER });

  const server = Bun.serve({
    port: cfg.ROUTER_PORT,
    hostname: cfg.ROUTER_HOST,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/webhook/gitea") {
        return handleWebhook(req, cfg);
      }
      if (req.method === "POST" && url.pathname === "/reply") {
        return handleReply(req, cfg);
      }
      if (url.pathname === "/api/strategy") {
        return handleStrategy(req);
      }
      if (url.pathname === "/api/health") {
        return handleHealth();
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  log("info", "ework-router listening", { host: server.hostname, port: server.port });

  process.on("SIGINT", async () => {
    log("info", "shutting down...");
    await closeDB();
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await closeDB();
    server.stop();
    process.exit(0);
  });
}
