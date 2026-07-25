import type { Config } from "./config";
import type { Store } from "./op";
import type { Engine } from "./opencode";
import type { IssueTracker, TrackerEvent } from "./trackers/types";
import { OpencodeReader, OpencodeReaderError } from "./opencode-reader";
import { log, uptimeSeconds, version } from "./logger";

type TrackerMap = Map<string, IssueTracker>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createServer(
  cfg: Config,
  store: Store,
  engine: Engine,
  trackers: TrackerMap
) {
  const reader = new OpencodeReader(cfg.opencode.binary, cfg.opencode.dbPath);
  async function handleWebhook(req: Request, tracker: IssueTracker): Promise<Response> {
    const rawBody = await req.text();
    const headers: Record<string, string | null> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });

    if (!tracker.verifyWebhookSignature(rawBody, headers)) {
      log.warn("webhook: invalid signature");
      return new Response("invalid signature", { status: 403 });
    }

    const event = tracker.parseWebhookEvent(rawBody);
    if (!event) {
      return new Response("unrecognized event", { status: 400 });
    }

    log.info(
      `webhook: type=${event.type} ref=${event.ref.trackerType}:${event.ref.scope.owner ?? ""}/${event.ref.scope.repo ?? ""}#${event.ref.issueId}`
    );

    engine.handleEvent(event).catch((err) => {
      log.error("webhook: handler error:", err);
    });

    return new Response("ok", { status: 200 });
  }

  async function handleApi(req: Request, pathname: string): Promise<Response> {
    if (pathname === "/api/status") {
      const status = await engine.getStatus();
      return json({
        env: cfg.env,
        daemon: { host: cfg.daemon.host, port: cfg.daemon.port },
        db: cfg.db.path,
        running: status.runningCount,
        pending: status.pendingCount,
        processes: status.processCount,
        observedIssues: status.observedIssues,
        issues: (await store.listAllIssues()).length,
        sessions: (await store.listAllSessions()).length,
      });
    }

    if (pathname === "/api/issues") {
      return json(await store.listAllIssues());
    }

    if (pathname === "/api/sessions") {
      return json(await store.listAllSessions());
    }

    const issueIdMatch = pathname.match(/^\/api\/issues\/([0-9a-f-]+)$/);
    if (issueIdMatch) {
      const issue = await store.getIssue(issueIdMatch[1]!);
      if (!issue) return json({ error: "not found" }, 404);
      const sessions = await store.getSessionsForIssue(issue.id);
      return json({ ...issue, sessions });
    }

    const sessionIdMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)$/);
    if (sessionIdMatch) {
      const session = await store.getSession(sessionIdMatch[1]!);
      if (!session) return json({ error: "not found" }, 404);
      return json(session);
    }

    if (pathname === "/api/queue") {
      return json(await engine.getQueue());
    }

    if (pathname === "/api/processes") {
      return json(engine.getProcesses());
    }

    const sessionMsgsMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/messages$/);
    if (sessionMsgsMatch) {
      const session = await store.getSession(sessionMsgsMatch[1]!);
      if (!session) return json({ error: "not found" }, 404);
      return json(await store.getMessagesForSession(session.id));
    }

    const msgRetryMatch = pathname.match(/^\/api\/messages\/([0-9a-f-]+)\/retry$/);
    if (msgRetryMatch && req.method === "PATCH") {
      const result = await engine.retryMessage(msgRetryMatch[1]!);
      if (!result) {
        const msg = await store.getMessage(msgRetryMatch[1]!);
        if (!msg) return json({ error: "not found" }, 404);
        if (msg.status !== "failed") return json({ error: "only failed messages can be retried" }, 400);
      }
      return json({ ok: true, id: msgRetryMatch[1] });
    }

    const forceStopMatch = pathname.match(/^\/api\/processes\/(.+)$/);
    if (forceStopMatch && req.method === "DELETE") {
      const key = decodeURIComponent(forceStopMatch[1]!);
      log.warn(`api: DELETE /api/processes/${key} (force-stop request)`);
      const wasKilled = await engine.forceStop(key);
      return json({ ok: true, stopped: wasKilled });
    }

    if (pathname === "/api/opencode/sessions") {
      const url = new URL(req.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50"), 1), 500);
      const sessions = await reader.listSessions(limit);
      return json(sessions);
    }

    const ocExportMatch = pathname.match(/^\/api\/opencode\/sessions\/([A-Za-z0-9_-]+)\/export$/);
    if (ocExportMatch) {
      try {
        const data = await reader.exportSession(ocExportMatch[1]!);
        return json(data);
      } catch (e) {
        if (e instanceof OpencodeReaderError) return json({ error: e.message }, e.status);
        return json({ error: "export failed" }, 502);
      }
    }

    const ocRawMatch = pathname.match(/^\/api\/opencode\/sessions\/([A-Za-z0-9_-]+)\/raw$/);
    if (ocRawMatch) {
      try {
        const raw = await reader.exportSessionRaw(ocRawMatch[1]!);
        return json({ raw });
      } catch (e) {
        if (e instanceof OpencodeReaderError) return json({ error: e.message }, e.status);
        return json({ error: "export failed" }, 502);
      }
    }

    return json({ error: "not found" }, 404);
  }

  const server = Bun.serve({
    port: cfg.daemon.port,
    hostname: cfg.daemon.host,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === "/healthz") {
        return new Response(
          JSON.stringify({ ok: true, version: version(), uptime: uptimeSeconds() }),
          { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
        );
      }

      if (req.method === "POST") {
        if (pathname === "/webhook/gitea" || pathname === "/webhook") {
          const tracker = trackers.get("gitea");
          if (!tracker) return json({ error: "gitea tracker not configured" }, 500);
          return handleWebhook(req, tracker);
        }
        if (pathname === "/webhook/plane") {
          const tracker = trackers.get("plane");
          if (!tracker) return json({ error: "plane tracker not configured" }, 500);
          return handleWebhook(req, tracker);
        }
      }

      if (pathname.startsWith("/api/")) {
        return handleApi(req, pathname);
      }

      return new Response("not found", { status: 404 });
    },
  });

  return server;
}
