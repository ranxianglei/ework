import type { Config } from "./config";
import type { Store } from "./op";
import type { Engine } from "./opencode";
import type { GroupConfig } from "./opencode";
import type { IssueTracker, TrackerEvent } from "./trackers/types";
import { OpencodeReader, OpencodeReaderError } from "./opencode-reader";
import { listDir, readFile, readFileSince, FileApiError } from "./file-api";
import { log, uptimeSeconds, version } from "./logger";

type TrackerMap = Map<string, IssueTracker>;

export function parseGroupConfigHeader(raw: string | null): GroupConfig | undefined {
  if (!raw) return undefined;
  if (raw.length > 16_384) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const gc = parsed as Record<string, unknown>;
    if (gc.workdirTemplate !== undefined && typeof gc.workdirTemplate !== "string") return undefined;
    if (gc.initScript !== undefined && typeof gc.initScript !== "string") return undefined;
    if (gc.destroyScript !== undefined && typeof gc.destroyScript !== "string") return undefined;
    if (gc.envInitScript !== undefined && typeof gc.envInitScript !== "string") return undefined;
    return gc as GroupConfig;
  } catch {
  }
  return undefined;
}

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

    const groupConfig = parseGroupConfigHeader(req.headers.get("x-ework-group-config"));

    engine.handleEvent(event, groupConfig).catch((err) => {
      log.error("webhook: handler error:", err);
    });

    return new Response("ok", { status: 200 });
  }

  async function handleApi(req: Request, pathname: string): Promise<Response> {
    const url = new URL(req.url);
    if (pathname === "/api/status") {
      const status = await engine.getStatus();
      return json({
        env: cfg.env,
        daemon: { host: cfg.daemon.host, port: cfg.daemon.port },
        db: cfg.db.driver === "mysql" ? `${cfg.db.host}:${cfg.db.port}/${cfg.db.name}` : cfg.db.path,
        driver: cfg.db.driver,
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

    if (pathname === "/api/files/list") {
      const filePath = url.searchParams.get("path") ?? "";
      try {
        return json(listDir(cfg, filePath));
      } catch (e) {
        if (e instanceof FileApiError) return json({ error: e.message }, e.status);
        return json({ error: "list failed" }, 500);
      }
    }

    if (pathname === "/api/files/read") {
      const filePath = url.searchParams.get("path") ?? "";
      const mode = (url.searchParams.get("mode") === "head" ? "head" : "tail") as "head" | "tail";
      const order = (url.searchParams.get("order") === "asc" ? "asc" : "desc") as "asc" | "desc";
      try {
        return json(readFile(cfg, filePath, mode, order));
      } catch (e) {
        if (e instanceof FileApiError) return json({ error: e.message }, e.status);
        return json({ error: "read failed" }, 500);
      }
    }

    if (pathname === "/api/files/since") {
      const filePath = url.searchParams.get("path") ?? "";
      const after = Number(url.searchParams.get("after") ?? "0");
      try {
        return json(readFileSince(cfg, filePath, after));
      } catch (e) {
        if (e instanceof FileApiError) return json({ error: e.message }, e.status);
        return json({ error: "read failed" }, 500);
      }
    }

    if (pathname === "/api/admin/pause" && req.method === "POST") {
      await engine.pause();
      return json({ ok: true, paused: true });
    }
    if (pathname === "/api/admin/resume" && req.method === "POST") {
      await engine.resume();
      return json({ ok: true, paused: false });
    }
    if (pathname === "/api/admin/max-concurrent" && req.method === "POST") {
      const body = await req.json().catch(() => ({} as unknown));
      const value = (body as { value?: unknown })?.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
        return json({ error: "value must be a positive number" }, 400);
      }
      engine.setMaxConcurrent(Math.floor(value));
      return json({ ok: true, maxConcurrent: engine.getMaxConcurrent() });
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
