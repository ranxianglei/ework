import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, appendFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { loadConfig, DB_OVERRIDABLE, parseOverride, resolveTtsBackend } from "./config";
import type { Config } from "./config";
import { setConfig, initDB, getDB } from "./db";
import { getActiveDaemons, listAllDaemons, getSessionDaemonMap, resolveDaemonEndpoint } from "./coordination";
import { testMysqlConnection, migrateSqliteToMysql, writeMysqlEnv, migrateMysqlToSqlite, writeSqliteEnv, migrateDaemonSqliteToMysql, generateMysqlDDL } from "./db-admin";
import type { MysqlTargetOpts } from "./db-admin";
import { checkAuth, makeAuthCookieHeader, clearAuthCookieHeader, loginHTML, sanitizeNext, ensureBootstrapAdmin, ensureBootstrapSystem, isReservedSystemLogin } from "./auth";
import { runAuthHook } from "./auth-hook";
import { OpencodeError, createOpencodeClient, MultiDaemonOpencodeClient, RemoteOpencodeClient, isLocalhost, type OpencodeClientInterface } from "./opencode";
import { renderMarkdown } from "./render/markdown";
import { log, uptimeSeconds, version } from "./logger";
import { buildIssueThread, fetchIssuePage, fetchIssueSince, errorPage } from "./views/issueThread";
import { buildIssueList } from "./views/issueList";
import { buildHome, handleCreateProject } from "./views/home";
import { buildIssuesFeed } from "./views/issues";
import { buildIssueNew } from "./views/issueNew";
import { buildSettingsPage } from "./views/settings";
import { buildTtsBackendsPage } from "./views/ttsBackends";
import { buildMePage, buildAdminUsersPage } from "./views/users";
import { buildTokensPage, buildTokenCreatedPage } from "./views/tokens";
import { buildAdminTokensPage } from "./views/adminTokens";
import { buildSessionList, buildSessionView, renderNewMessages, renderBatchHTML } from "./views/sessionLog";
import { buildFileView, FileViewError, readFileSince, serveRawFile } from "./fileview";
import { translateText, translateTextStream, TranslateError } from "./translate";
import { rateLimit } from "./ratelimit";
import {
  StoreError,
  getProject,
  getProjectById,
  getIssueWithMeta,
  createIssue,
  createProject,
  postComment,
  setIssueState,
  createAttachment,
  getAttachment,
  verifyUserPassword,
  updateUser,
  countAdmins,
  createUser,
  getUserByLogin,
  setUserPassword,
  listUsers,
  createPat,
  listPatsForUser,
  revokePat,
  revokePatAsAdmin,
  listAllPatsWithUsers,
  canWriteProject,
  canAdminProject,
  canReadProject,
  updateProjectVisibility,
  ensureProjectBootstrapAdmin,
  addProjectMember,
  setProjectMemberRole,
  removeProjectMember,
  countProjectAdmins,
  getProjectMembership,
  setProjectModel,
  listCachedModels,
  replaceCachedModels,
  listLabels,
  listLabelsForIssue,
  createLabel,
  updateLabel,
  archiveLabel,
  deleteLabel,
  setIssueLabels,
  listAllProjectIds,
  type ProjectRole,
  type UserRow,
} from "./store";
import {
  newAttachmentUUID,
  saveAttachmentBlob,
  readAttachmentStream,
  sniffImageContentType,
  isImageContentType,
  MAX_ATTACHMENT_BYTES,
} from "./attachments";
import {
  emitIssueEvent,
  emitCommentEvent,
  emitPingEvent,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  setWebhookActive,
  getWebhook,
  listDeliveries,
  listAllRecentDeliveries,
  type WebhookEventName,
} from "./webhooks";
import { classifyActor, type CommentView } from "./render/components";
import { buildWebhooksPage } from "./views/webhooks";
import { buildWebhookDeliveriesPage } from "./views/webhookDeliveries";
import { browseRemoteFile, proxyFileSince, RemoteFileError } from "./remote-file";
import { buildProjectMembersPage } from "./views/projectMembers";
import { buildProjectUpstreamsPage, trySetUpstreamUrls } from "./views/projectUpstreams";
import { buildProjectLabelsPage } from "./views/projectLabels";
import { buildProjectModelPage } from "./views/projectModel";
import { handleGiteaApi } from "./giteaApi";
import { deployRemoteDaemon, deployBatch, type DeployTarget } from "./daemon-deploy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "static");

await initDB();
const cfg: Config = await loadConfig();
let opencode: OpencodeClientInterface = createOpencodeClient(cfg, cfg.daemonWebhookUrl);

async function refreshOpencodeClient(): Promise<void> {
  const daemons = await getActiveDaemons();
  const remote = daemons.filter((d) => !isLocalhost(d.endpoint));
  if (remote.length > 1) {
    opencode = new MultiDaemonOpencodeClient(remote.map((d) => d.endpoint));
    log.info(`opencode client: multi-daemon (${remote.length} remotes)`);
  } else if (remote.length === 1) {
    opencode = new RemoteOpencodeClient(remote[0]!.endpoint);
    log.info(`opencode client: single remote (${remote[0]!.endpoint})`);
  } else {
    opencode = createOpencodeClient(cfg, cfg.daemonWebhookUrl);
  }
}

await refreshOpencodeClient();
setInterval(refreshOpencodeClient, 10_000);

async function autoWireDaemon(projectId: number, origin: string): Promise<void> {
  if (!cfg.autowireActive) {
    log.info("autoWireDaemon: skipped (WORK_AUTOWIRE_ACTIVE=false)", { projectId });
    return;
  }
  const botLogin = cfg.daemonBotLogin.trim();
  const hookUrl = cfg.daemonWebhookUrl.trim();
  if (botLogin) {
    try {
      await addProjectMember(projectId, botLogin, "writer");
    } catch (e) {
      log.warn("autoWireDaemon: addProjectMember failed", { botLogin, err: e as Error });
    }
  }
  if (hookUrl) {
    try {
      const target = hookUrl.replace(/\/$/, "") + "/webhook/gitea";
      const exists = (await listWebhooks(projectId)).some((w) => w.url === target);
      if (!exists) {
        await createWebhook({
          project_id: projectId,
          url: target,
          secret: cfg.daemonWebhookSecret,
          events: ["issues", "issue_comment"],
        });
        void emitPingEvent(projectId, origin);
      }
    } catch (e) {
      log.warn("autoWireDaemon: createWebhook failed", { hookUrl, err: e as Error });
    }
  }
}

let backfillStarted = false;
async function autoWireAllProjects(origin: string): Promise<void> {
  if (backfillStarted) return;
  backfillStarted = true;
  if (!cfg.autowireActive || (!cfg.daemonBotLogin.trim() && !cfg.daemonWebhookUrl.trim())) return;
  try {
    const ids = await listAllProjectIds();
    let wired = 0;
    for (const id of ids) {
      await autoWireDaemon(id, origin);
      wired++;
    }
    if (wired > 0) log.info("autoWireAllProjects: backfilled", { count: wired });
  } catch (e) {
    log.warn("autoWireAllProjects failed", { err: e as Error });
  }
}

void autoWireAllProjects(`http://${cfg.host}:${cfg.port}`);

const SEC_HEADERS: Record<string, string> = {
  "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "()",
};

const hlCss = loadHighlightCss();

function loadHighlightCss(): string {
  const light = readFileSafe(join(__dirname, "..", "node_modules", "highlight.js", "styles", "github.css"));
  const dark = readFileSafe(join(__dirname, "..", "node_modules", "highlight.js", "styles", "github-dark.css"));
  if (!light && !dark) return "";
  const darkRule = dark
    ? `@media (prefers-color-scheme:dark){${stripAtMedia(dark)}}`
    : "";
  return `${light}${darkRule}`;
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function stripAtMedia(css: string): string {
  return css.replace(/@media[^{]*\{([\s\S]*)\}\s*$/, "$1");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SEC_HEADERS },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...SEC_HEADERS },
  });
}

// The prefix regex below must match db.ts:WORK_DB_PREFIX exactly — if the API
// accepts a prefix that boot rejects, the wizard writes a .env that restarts
// into a crash. Any change here must be mirrored in db.ts + db-admin.ts.
type ParsedDbTarget = MysqlTargetOpts & { daemonPrefix?: string };

function parseDbTargetOpts(payload: unknown): ParsedDbTarget | { error: string } {
  if (typeof payload !== "object" || payload === null) return { error: "invalid body" };
  const p = payload as Record<string, unknown>;
  const host = typeof p.host === "string" ? p.host.trim() : "";
  const portNum = Number(p.port);
  const user = typeof p.user === "string" ? p.user.trim() : "";
  const password = typeof p.password === "string" ? p.password : "";
  const database = typeof p.database === "string" ? p.database.trim() : "";
  const prefix = typeof p.prefix === "string" ? p.prefix.trim() : "";
  const daemonPrefix = typeof p.daemonPrefix === "string" ? p.daemonPrefix.trim() : "";
  if (!host) return { error: "host required" };
  if (!user) return { error: "user required" };
  if (!database) return { error: "database required" };
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { error: "port must be an integer 1-65535" };
  }
  const prefixRe = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
  if (prefix && !prefixRe.test(prefix)) {
    return { error: "prefix must match ^[A-Za-z_][A-Za-z0-9_]{0,31}$" };
  }
  if (daemonPrefix && !prefixRe.test(daemonPrefix)) {
    return { error: "daemonPrefix must match ^[A-Za-z_][A-Za-z0-9_]{0,31}$" };
  }
  const opts: ParsedDbTarget = { host, port: portNum, user, password, database };
  if (prefix) opts.prefix = prefix;
  if (daemonPrefix) opts.daemonPrefix = daemonPrefix;
  return opts;
}

// Two restart paths depending on how this process was launched. Both run
// AFTER the HTTP response is sent (caller schedules this last):
//   systemd (INVOCATION_ID set): exit → the unit's Restart=always brings us back
//   PID-file mode (ework-aio start): spawn `ework-aio restart web`, then exit.
//     The restart child reads our PID file, finds a dead PID (stale), cleans
//     up, and starts fresh. Always exiting avoids the race where the child
//     SIGTERMs us while we're still serving the old config.
function scheduleRestart(): void {
  if (process.env.INVOCATION_ID) {
    setTimeout(() => process.exit(0), 750);
    return;
  }
  spawn("ework-aio", ["restart", "web"], {
    detached: true,
    stdio: "ignore",
  }).unref();
  setTimeout(() => process.exit(0), 1500);
}

// The daemon's `issues` table (thin ref) collides with the web's `issues`
// table (full content) if they share a database. The daemon MUST use a
// different prefix. We append "d_" to whatever the web uses so both can
// coexist in one database without the operator having to plan prefixes.
function daemonPrefix(webPrefix: string): string {
  return webPrefix + "d_";
}

function daemonEnvPath(): string | null {
  const dataDir = process.env.WORK_DAEMON_DATA_DIR;
  if (dataDir) {
    const p = join(dataDir, ".env");
    return existsSync(p) ? p : null;
  }
  // Sibling layout (ework-aio managed): web's cwd is <dataDir>/ework-web/,
  // daemon is at <dataDir>/ework-daemon/.env. Checked first because it works
  // regardless of where --data-dir points (Docker, custom paths, etc.).
  const candidates = [
    join(process.cwd(), "..", "ework-daemon", ".env"),
    join(homedir(), ".local", "share", "ework-daemon", ".env"),
    join(homedir(), ".local", "share", "ework-aio", "ework-daemon", ".env"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function readDaemonSqlitePath(envPath: string): string | null {
  try {
    const content = readFileSync(envPath, "utf8");
    const m = content.match(/^(?:WORK_DB_PATH|DAEMON_DB_PATH)\s*=\s*(.+)$/m);
    if (m?.[1]) return m[1].trim();
    // Neither key in .env — replicate the daemon's PRODUCTION_DB_DEFAULT
    // (config.ts:61) so we can find its SQLite DB for migration.
    const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    return join(xdg, "ework-daemon", "ework-daemon.db");
  } catch {
    return null;
  }
}

function spawnDaemonRestart(): void {
  try {
    const child = spawn("ework-aio", ["restart", "daemon"], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best-effort — the manual fallback path covers this
  }
}

function daemonManualInstructions(opts: MysqlTargetOpts): string {
  return [
    "将以下内容追加到 daemon 的 .env，然后运行 ework-aio restart daemon：",
    "",
    `WORK_DB_DRIVER=mysql`,
    `WORK_DB_HOST=${opts.host}`,
    `WORK_DB_PORT=${opts.port}`,
    `WORK_DB_USER=${opts.user}`,
    "WORK_DB_PASSWORD=<daemon密码>",
    `WORK_DB_NAME=${opts.database}`,
    `WORK_DB_PREFIX=${opts.prefix ?? ""}`,
  ].join("\n");
}

const REPO_ISSUE_RE = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;
const REPO_LIST_RE = /^\/([^/]+)\/([^/]+)\/issues$/;
const REPO_NEW_RE = /^\/([^/]+)\/([^/]+)\/issues\/new$/;
const REPO_RE = /^\/([^/]+)\/([^/]+)$/;
const API_RE = /^\/api\/([^/]+)\/([^/]+)\/issues\/(\d+)\/(page|since)$/;
const COMMENT_POST_RE = /^\/api\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comment$/;
const UPLOAD_RE = /^\/api\/([^/]+)\/([^/]+)\/issues\/(\d+)\/upload$/;
const ATTACHMENT_RE = /^\/attachments\/([0-9a-fA-F-]+)$/;
const REPO_WEBHOOKS_RE = /^\/([^/]+)\/([^/]+)\/settings\/webhooks$/;
const REPO_MEMBERS_RE = /^\/([^/]+)\/([^/]+)\/settings\/members$/;
const REPO_MEMBER_ACTION_RE = /^\/([^/]+)\/([^/]+)\/settings\/members\/([^/]+)\/(role|remove)$/;
const REPO_MEMBER_ADD_RE = /^\/([^/]+)\/([^/]+)\/settings\/members\/add$/;
const REPO_VISIBILITY_RE = /^\/([^/]+)\/([^/]+)\/settings\/visibility$/;
const REPO_UPSTREAMS_RE = /^\/([^/]+)\/([^/]+)\/settings\/upstreams$/;
const REPO_MODEL_RE = /^\/([^/]+)\/([^/]+)\/settings\/model$/;
const REPO_LABELS_RE = /^\/([^/]+)\/([^/]+)\/settings\/labels$/;
const REPO_LABEL_ADD_RE = /^\/([^/]+)\/([^/]+)\/settings\/labels\/add$/;
const REPO_LABEL_ACTION_RE = /^\/([^/]+)\/([^/]+)\/settings\/labels\/(\d+)\/(update|archive|unarchive|delete)$/;
const API_ISSUE_LABELS_RE = /^\/api\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/;
const WH_ACTION_RE = /^\/__wh\/(\d+)\/(delete|toggle|test)$/;
const SESSIONS_RE = /^\/sessions$/;
const SESSION_VIEW_RE = /^\/sessions\/([A-Za-z0-9_-]+)$/;
const SESSION_SINCE_RE = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/since$/;
const SESSION_BATCH_RE = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/batch$/;

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.host,
  async fetch(req, server) {
    const url = new URL(req.url);
    const ip = remoteAddr(req, server);
    const start = Date.now();
    const ctx = { authed: false, user: null as UserRow | null };
    let res: Response;
    try {
      res = await handle(req, url, ip, ctx);
    } catch (e) {
      res = html(errorPage("服务器错误", errMsg(e)), 500);
    }
    appendAccessLog(ip, req.method, url.pathname + url.search, res.status, ctx.authed, Date.now() - start);
    return res;
  },
});
void server;

function remoteAddr(
  req: Request,
  server: { requestIP(request: Request): { address: string } | null }
): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return (xff.split(",")[0] ?? "").trim();
  const info = server.requestIP(req);
  return info?.address ?? "unknown";
}

function appendAccessLog(ip: string, method: string, path: string, status: number, authed: boolean, ms: number): void {
  const line = `${new Date().toISOString()} ${ip} ${method} ${path} → ${status} authed=${authed ? "yes" : "no"} ${ms}ms\n`;
  log.debug("access", { ip, method, path, status, authed, ms });
  try {
    appendFileSync(cfg.accessLogPath, line);
  } catch (e) {
    log.warn("access-log write failed", { err: e as Error });
  }
}

function staticAsset(name: string, type: string, req: Request): Response {
  const f = Bun.file(join(STATIC_DIR, name));
  const etag = `"${f.size}-${f.lastModified}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
  return new Response(f, {
    headers: { "content-type": type, "cache-control": "no-cache", etag, ...SEC_HEADERS },
  });
}

const ttsStage = new Map<string, { text: string; url: string; voice: string; exp: number }>();
const TTS_STAGE_TTL = 600000;
const TTS_CHUNK_TIMEOUT = 60000;

function chunkTextTTS(text: string, max = 120): string[] {
  text = text.replace(/\r/g, "").replace(/\n+/g, "。");
  const out: string[] = [];
  let buf = "";
  const push = (s: string) => { const t = s.trim(); if (t) out.push(t); };
  const hardCut = (s: string): string => {
    while (s.length > max) {
      let cut = 0;
      for (const d of ["，", ",", "；", ";", " ", "　"]) {
        const i = s.lastIndexOf(d, max);
        if (i > cut) cut = i;
      }
      if (cut === 0) cut = max;
      push(s.slice(0, cut));
      s = s.slice(cut);
    }
    return s;
  };
  for (const s of text.replace(/\r/g, "").split(/(?<=[。！？\n.!?])/)) {
    if ((buf + s).length > max) { push(buf); buf = ""; }
    buf += hardCut(s);
    if (buf.length > max) { push(buf); buf = ""; }
  }
  push(buf);
  return out;
}

async function handle(req: Request, url: URL, ip: string, ctx: { authed: boolean; user: UserRow | null }): Promise<Response> {
  if (url.pathname === "/static/app.js") return staticAsset("app.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/db-wizard.js") return staticAsset("db-wizard.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/daemon-mgr.js") return staticAsset("daemon-mgr.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/daemon-groups.js") return staticAsset("daemon-groups.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/label-picker.js") return staticAsset("label-picker.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/session.js") return staticAsset("session.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/file.js") return staticAsset("file.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/tts.js") return staticAsset("tts.js", "text/javascript; charset=utf-8", req);
  if (url.pathname === "/static/highlight.css") {
    return new Response(hlCss, {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache", ...SEC_HEADERS },
    });
  }
  if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
    return staticAsset("favicon.svg", "image/svg+xml", req);
  }

  if (url.pathname === "/healthz") {
    return new Response(
      JSON.stringify({ ok: true, version: version(), uptime: uptimeSeconds() }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }

  if (url.pathname === "/login") {
    if (req.method === "POST") {
      const form = await req.formData().catch(() => new FormData());
      const next = sanitizeNext(String(form.get("next") ?? "/"));
      if (!rateLimit(`login:${ip}`, 5, 5 / (15 * 60))) {
        return html(loginHTML(next, "尝试过多，15 分钟后再试", cfg), 429);
      }
      const login = String(form.get("login") ?? "").trim();
      const password = String(form.get("password") ?? "");
      const token = String(form.get("token") ?? "").trim();

      // Token wins over login/password if both supplied (migration path).
      let resolvedLogin: string | null = null;
      if (token && token === cfg.authToken) {
        resolvedLogin = cfg.operatorLogin;
      } else if (login && password) {
        const u = await verifyUserPassword(login, password);
        if (u) resolvedLogin = u.login;
      }

      if (!resolvedLogin && token && cfg.userAuthHook) {
        const hookReq = new Request(url, {
          headers: { authorization: `Bearer ${token}` },
        });
        const user = await runAuthHook(cfg.userAuthHook, hookReq);
        if (user) resolvedLogin = user.login;
      }

      if (resolvedLogin) {
        const setCookie = await makeAuthCookieHeader(cfg, resolvedLogin);
        return new Response(null, {
          status: 302,
          headers: { location: next, "set-cookie": setCookie },
        });
      }
      const err = token
        ? "token 不对"
        : login || password
          ? "用户名或密码错误"
          : "请填写用户名密码或共享 token";
      return html(loginHTML(next, err, cfg), 401);
    }
    const next = sanitizeNext(url.searchParams.get("next") ?? "/");
    return html(loginHTML(next, undefined, cfg));
  }

  if (url.pathname === "/logout" && req.method === "POST") {
    return new Response(null, {
      status: 302,
      headers: { location: "/login", "set-cookie": clearAuthCookieHeader(cfg) },
    });
  }

  const auth = await checkAuth(req, cfg, ip);
  if (!auth.ok) {
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "authentication required" }, 401);
    }
    const next = sanitizeNext(url.pathname + url.search);
    return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(next)}`, 302);
  }
  ctx.user = auth.user;
  ctx.authed = true;

  if (url.pathname.startsWith("/api/") && ctx.user?.kind !== "bot" && !rateLimit(`api:${ip}`, 60, 1)) {
    return json({ error: "rate limited" }, 429);
  }

  // Gitea-compatible REST shim (/api/v1/*). Must be checked BEFORE the legacy
  // /api/* routes since those would 404 on /api/v1/* paths. The shim reuses
  // the existing ctx.user (cookie or PAT auth already resolved above).
  if (url.pathname.startsWith("/api/v1/")) {
    const result = await handleGiteaApi(req, url, { user: ctx.user });
    if (result) {
      if (result.body === null) {
        return new Response(null, { status: result.status, headers: SEC_HEADERS });
      }
      return json(result.body, result.status);
    }
    // fall through to 404 below if shim didn't match
  }

  const att = url.pathname.match(ATTACHMENT_RE);
  if (att) {
    const [, uuid] = att;
    if (!uuid) return new Response(null, { status: 400, headers: SEC_HEADERS });
    const row = await getAttachment(uuid);
    if (!row) return new Response(null, { status: 404, headers: SEC_HEADERS });
    const stream = readAttachmentStream(uuid);
    if (!stream) return new Response(null, { status: 404, headers: SEC_HEADERS });
    const headers = new Headers(SEC_HEADERS);
    // Force download for non-image content types so uploaded .svg/.html can't execute
    // in-origin (stored XSS). Images render inline; everything else is attachment.
    headers.set(
      "content-type",
      isImageContentType(row.content_type) ? row.content_type : "application/octet-stream"
    );
    headers.set(
      "content-disposition",
      isImageContentType(row.content_type)
        ? `inline; filename="${row.filename.replace(/["\\]/g, "")}"`
        : `attachment; filename="${row.filename.replace(/["\\]/g, "")}"`
    );
    headers.set("cache-control", "private, max-age=3600");
    return new Response(stream.file, { status: 200, headers });
  }

  if (url.pathname === "/") {
    return Response.redirect(`${url.origin}/projects`, 302);
  }

  if (url.pathname === "/projects") {
    if (req.method === "POST") {
      if (!cfg.writesEnabled) return html(errorPage("只读模式", "WORK_WRITES_ENABLED=false"), 403);
      const form = await req.formData().catch(() => new FormData());
      const f: Record<string, string | undefined> = {};
      for (const [k, v] of form.entries()) f[k] = typeof v === "string" ? v : undefined;
      const r = await handleCreateProject(f, cfg.defaultModel);
      if (r.projectId) {
        await ensureProjectBootstrapAdmin(r.projectId, ctx.user!.login);
        await autoWireDaemon(r.projectId, url.origin);
        const q = new URLSearchParams({ created: "1" });
        return Response.redirect(`${url.origin}${r.location}?${q}`, 303);
      }
      const q = new URLSearchParams({ err: r.error ?? "创建失败" });
      return Response.redirect(`${url.origin}${r.location}?${q}`, 303);
    }
    const flashErr = url.searchParams.get("err");
    const flash = flashErr ? { kind: "err" as const, msg: flashErr } : null;
    return html(await buildHome(ctx.user, flash));
  }

  if (url.pathname === "/issues") {
    const state = parseState(url.searchParams.get("state"));
    const q = url.searchParams.get("q")?.trim() ?? "";
    const label = url.searchParams.get("label")?.trim() ?? "";
    try {
      return html(await buildIssuesFeed(state, q, label, ctx.user));
    } catch (e) {
      return html(errorPage("加载失败", errMsg(e)), e instanceof StoreError ? e.status : 500);
    }
  }

  if (url.pathname.match(SESSIONS_RE)) {
    const q = url.searchParams.get("q")?.trim() ?? "";
    try {
      const daemonMap = await getSessionDaemonMap();
      const { html: body } = await buildSessionList(opencode, q, daemonMap);
      return html(body);
    } catch (e) {
      return html(errorPage("加载失败", errMsg(e)), e instanceof OpencodeError ? e.status : 502);
    }
  }

  const sessionView = url.pathname.match(SESSION_VIEW_RE);
  if (sessionView) {
    const [, sid] = sessionView;
    if (!sid) return html(errorPage("404", "bad session path"), 404);
    const desc = url.searchParams.get("asc") !== "1";
    const all = url.searchParams.get("all") === "1";
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit")) || 30));
    const daemonEp = url.searchParams.get("daemon");
    const daemonIdParam = url.searchParams.get("daemon_id");
    if (!daemonEp && daemonIdParam) {
      const id = Number(daemonIdParam);
      if (Number.isFinite(id) && id > 0) {
        const sessionMap = await getSessionDaemonMap();
        const mapped = sessionMap.get(sid);
        const effectiveId = mapped && mapped.daemonId !== id ? mapped.daemonId : id;
        if (mapped && mapped.daemonId !== id) {
          log.info(`session ${sid}: URL daemon_id=${id} but DB says daemon ${mapped.daemonId}, redirecting`);
        }
        const ep = await resolveDaemonEndpoint(effectiveId);
        if (ep) {
          const client = new RemoteOpencodeClient(ep);
          try {
            const { html: body } = await buildSessionView(client, sid, desc, cfg.collapseLines, limit, all);
            return html(body);
          } catch (e) {
            const status = e instanceof OpencodeError ? e.status : 500;
            if (status === 404) {
              return html(errorPage(
                "会话不在该 daemon 上",
                `会话 ${sid} 在 daemon ${effectiveId} (${ep}) 上找不到 (HTTP ${status})。\n\n` +
                `URL 指定的 daemon_id=${id}，数据库映射的 daemon=${mapped?.daemonId ?? "无"}。\n` +
                `可能原因：daemon 重启后 ID 变化，或会话在另一个 daemon 上创建。\n\n` +
                `可用 daemon 列表见 /sessions 页面。`,
              ), 404);
            }
            throw e;
          }
        }
      }
    }
    const client = daemonEp ? new RemoteOpencodeClient(daemonEp) : opencode;
    try {
      const { html: body } = await buildSessionView(client, sid, desc, cfg.collapseLines, limit, all);
      return html(body);
    } catch (e) {
      const status = e instanceof OpencodeError ? e.status : 500;
      if (status === 404 && /^ses_[0-9A-Za-z]{8,}/.test(sid)) {
        return html(errorPage(
          "会话尚未写入数据库",
          `会话 ID ${sid} 在 opencode.db 里找不到。\n\n` +
          `常见原因：daemon 把尚未完成的 opencode run 的 session ID 写进了评论（早期捕获），\n` +
          `但 opencode 进程因 LLM 鉴权失败 / git clone 失败 / 其他错误退出前没把这条 session\n` +
          `持久化到 DB。\n\n` +
          `排查：docker logs ework-aio 看 opencode 子进程的报错；确认 OPENCODE_AI_API_KEY 已配置\n` +
          `或 ~/.config/opencode/auth.json 存在。`
        ), 404);
      }
      return html(errorPage(status === 404 ? "找不到会话" : "加载失败", errMsg(e)), status);
    }
  }

  if (url.pathname === "/file") {
    const rawPath = url.searchParams.get("path") ?? "";
    let daemonParam = url.searchParams.get("daemon");
    const daemonIdParam = url.searchParams.get("daemon_id");
    if (!daemonParam && daemonIdParam) {
      const id = Number(daemonIdParam);
      if (Number.isFinite(id) && id > 0) {
        const ep = await resolveDaemonEndpoint(id);
        if (ep) daemonParam = ep;
      }
    }
    // daemon_id explicit → always browse via daemon API (multi-daemon localhost setup would 404 on local FS)
    const daemonIdExplicit = url.searchParams.has("daemon_id");
    if (daemonParam && (!isLocalhost(daemonParam) || daemonIdExplicit)) {
      try {
        const mode = url.searchParams.get("mode") ?? "tail";
        const order = url.searchParams.get("order") ?? "desc";
        const { html: body } = await browseRemoteFile(daemonParam, rawPath, mode, order, ctx.user?.login);
        return html(body);
      } catch (e) {
        const status = e instanceof RemoteFileError ? e.status : 500;
        return html(errorPage(status === 404 ? "文件不存在" : "远程访问失败", errMsg(e)), status);
      }
    }
    const mode = url.searchParams.get("mode") ?? undefined;
    const order = url.searchParams.get("order") ?? undefined;
    try {
      const view = url.searchParams.get("view") || undefined;
      const sort = url.searchParams.get("sort") || undefined;
      const tdir = url.searchParams.get("tdir") || undefined;
      const { html: body } = buildFileView(cfg, rawPath, mode, order, view, sort, tdir);
      return html(body);
    } catch (e) {
      const status = e instanceof FileViewError ? e.status : 500;
      return html(errorPage(status === 404 ? "文件不存在" : "无法查看", errMsg(e)), status);
    }
  }

  if (url.pathname === "/file/raw" || url.pathname === "/file/dl") {
    const rawPath = url.searchParams.get("path") ?? "";
    const disp = url.pathname === "/file/dl" ? "attachment" : "inline";
    try {
      return serveRawFile(cfg, rawPath, disp);
    } catch (e) {
      const status = e instanceof FileViewError ? e.status : 500;
      return html(errorPage(status === 404 ? "文件不存在" : "无法查看", errMsg(e)), status);
    }
  }

  if (url.pathname === "/api/file/since") {
    const rawPath = url.searchParams.get("path") ?? "";
    const after = Number(url.searchParams.get("after") ?? "0");
    if (!Number.isFinite(after) || after < 0) return json({ error: "bad after" }, 400);
    const daemonParam = url.searchParams.get("daemon");
    if (daemonParam && !isLocalhost(daemonParam)) {
      try {
        return json(await proxyFileSince(daemonParam, rawPath, after));
      } catch (e) {
        const status = e instanceof RemoteFileError ? e.status : 500;
        return json({ error: errMsg(e) }, status);
      }
    }
    try {
      const delta = readFileSince(cfg, rawPath, after);
      return json(delta);
    } catch (e) {
      const status = e instanceof FileViewError ? e.status : 500;
      return json({ error: errMsg(e) }, status);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/translate") {
    if (!rateLimit(`translate:${ip}`, 10, 10 / 60)) return json({ error: "rate limited" }, 429);
    try {
      const payload = (await req.json().catch(() => ({}))) as { text?: unknown };
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) return json({ error: "text required" }, 400);
      const translation = await translateText(cfg, text);
      return json({ translation, html: renderMarkdown(translation) });
    } catch (e) {
      const status = e instanceof TranslateError ? e.status : 502;
      return json({ error: errMsg(e) }, status);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/translate/stream") {
    if (!rateLimit(`translate:${ip}`, 10, 10 / 60)) return json({ error: "rate limited" }, 429);
    const payload = (await req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) return json({ error: "text required" }, 400);
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        try {
          let full = "";
          for await (const chunk of translateTextStream(cfg, text)) {
            full += chunk;
            send({ d: chunk });
          }
          send({ h: renderMarkdown(full) });
        } catch (e) {
          send({ e: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", ...SEC_HEADERS },
    });
  }

  if (req.method === "GET" && url.pathname === "/api/tts/backends") {
    return json(cfg.ttsBackends.filter((b) => b.url.trim() !== "").map((b) => ({ id: b.id, label: b.label, voice: b.voice })));
  }

  if (req.method === "POST" && url.pathname === "/api/tts") {
    if (!rateLimit(`tts:${ip}`, 30, 30 / 60)) return json({ error: "rate limited" }, 429);
    const payload = (await req.json().catch(() => ({}))) as { text?: unknown; backend?: unknown };
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim()) return json({ error: "text required" }, 400);
    if (text.length > 8000) return json({ error: "text too long" }, 413);
    const backend = resolveTtsBackend(cfg, typeof payload.backend === "string" ? payload.backend : undefined);
    if (!backend) return json({ error: "tts disabled" }, 503);
    const id = crypto.randomUUID();
    const now = Date.now();
    if (ttsStage.size > 50) for (const [k, v] of ttsStage) if (v.exp < now) ttsStage.delete(k);
    ttsStage.set(id, { text, url: backend.url, voice: backend.voice, exp: now + TTS_STAGE_TTL });
    return json({ id });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/tts/stream/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/tts/stream/".length));
    const entry = id && ttsStage.get(id);
    if (!entry) return json({ error: "not found or expired" }, 404);
    const segs = chunkTextTTS(entry.text);
    if (segs.length === 0) return json({ error: "empty text" }, 400);
    const upstream = `${entry.url.replace(/\/$/, "")}/audio/speech`;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const seg of segs) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), TTS_CHUNK_TIMEOUT);
            try {
              const upRes = await fetch(upstream, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ input: seg, voice: entry.voice, response_format: "mp3", speed: cfg.ttsSpeed }),
                signal: ctrl.signal,
              });
              if (!upRes.ok || !upRes.body) { controller.error(new Error(`tts upstream ${upRes.status}`)); return; }
              const reader = upRes.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } finally {
              clearTimeout(timer);
            }
          }
          controller.close();
        } catch (e) {
          controller.error(e instanceof Error ? e : new Error(String(e)));
        }
      },
    });
    const headers = new Headers(SEC_HEADERS);
    headers.set("content-type", "audio/mpeg");
    headers.set("cache-control", "no-cache");
    return new Response(stream, { status: 200, headers });
  }

  if (req.method === "POST" && url.pathname === "/api/db/test") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    if (!rateLimit(`db-test:${ip}`, 5, 5 / 60)) return json({ error: "rate limited" }, 429);
    const payload = await req.json().catch(() => ({}));
    const parsed = parseDbTargetOpts(payload);
    if ("error" in parsed) return json(parsed, 400);
    const result = await testMysqlConnection(parsed);
    return json(result, result.ok ? 200 : 422);
  }

  if (req.method === "POST" && url.pathname === "/api/db/migrate") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    if (!rateLimit(`db-migrate:${ip}`, 2, 2 / 3600)) return json({ error: "rate limited" }, 429);
    const payload = await req.json().catch(() => ({}));
    const parsed = parseDbTargetOpts(payload);
    if ("error" in parsed) return json(parsed, 400);
    const result = await migrateSqliteToMysql(parsed);
    return json(result, result.ok ? 200 : 422);
  }

  if (req.method === "POST" && url.pathname === "/api/db/enable") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    if (!rateLimit(`db-enable:${ip}`, 3, 3 / 3600)) return json({ error: "rate limited" }, 429);
    const payload = await req.json().catch(() => ({}));
    const parsed = parseDbTargetOpts(payload);
    if ("error" in parsed) return json(parsed, 400);
    const envResult = await writeMysqlEnv(join(process.cwd(), ".env"), parsed);
    scheduleRestart();
    return json({ ok: true, ...envResult, restarting: true });
  }

  if (req.method === "POST" && url.pathname === "/api/db/daemon-config") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    if (!rateLimit(`db-daemon:${ip}`, 3, 3 / 3600)) return json({ error: "rate limited" }, 429);
    const rawPayload = await req.json().catch(() => ({}));
    const parsed = parseDbTargetOpts(rawPayload);
    if ("error" in parsed) return json(parsed, 400);
    const { daemonPrefix: _dp, ...mysqlFields } = parsed;
    const dPrefix = parsed.daemonPrefix ?? daemonPrefix(parsed.prefix ?? "");
    const daemonOpts: MysqlTargetOpts = { ...mysqlFields, prefix: dPrefix };
    const envPath = daemonEnvPath();
    if (!envPath) {
      return json({ ok: false, configured: false, manual: daemonManualInstructions(daemonOpts) });
    }
    try {
      const daemonDbPath = readDaemonSqlitePath(envPath);
      let daemonMigrated: { table: string; rows: number }[] | null = null;
      if (daemonDbPath) {
        const mig = await migrateDaemonSqliteToMysql(daemonDbPath, daemonOpts);
        if (mig.ok) daemonMigrated = mig.tables;
      }
      const written = await writeMysqlEnv(envPath, daemonOpts);
      spawnDaemonRestart();
      return json({ ok: true, configured: true, envPath, written: written.written, daemonMigrated });
    } catch (e) {
      return json({ ok: false, configured: false, error: errMsg(e), manual: daemonManualInstructions(daemonOpts) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/db/ddl") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    if (!rateLimit(`db-ddl:${ip}`, 10, 10 / 60)) return json({ error: "rate limited" }, 429);
    const payload = await req.json().catch(() => ({}));
    const parsed = parseDbTargetOpts(payload);
    if ("error" in parsed) return json(parsed, 400);
    const dPrefix = parsed.daemonPrefix ?? daemonPrefix(parsed.prefix ?? "");
    try {
      const result = generateMysqlDDL(parsed, dPrefix);
      return json(result);
    } catch (e) {
      return json({ ok: false, error: errMsg(e) }, 400);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/db/revert") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    if (!rateLimit(`db-revert:${ip}`, 2, 2 / 3600)) return json({ error: "rate limited" }, 429);
    const targetPath = join(process.cwd(), "ework.sqlite");
    const result = await migrateMysqlToSqlite(targetPath);
    if (!result.ok) return json(result, 422);
    await writeSqliteEnv(join(process.cwd(), ".env"), targetPath);
    scheduleRestart();
    return json({ ...result, targetPath, restarting: true });
  }

  if (req.method === "GET" && url.pathname === "/api/daemons") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    return json(await listAllDaemons());
  }

  if (req.method === "POST" && url.pathname === "/api/daemons") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    if (!rateLimit(`daemons-add:${ip}`, 5, 5 / 3600)) return json({ error: "rate limited" }, 429);
    const payload = await req.json().catch(() => ({} as unknown));
    const port = (payload && typeof payload === "object" && "port" in payload
      ? (payload as { port?: unknown }).port
      : undefined);
    const args = ["add-daemon"];
    const dataDir = process.env.WORK_DATA_DIR ?? process.env.AWORK_DATA_DIR;
    if (dataDir) {
      args.push("--data-dir", dataDir);
    }
    if (typeof port === "number" && Number.isFinite(port) && port > 0 && port < 65536) {
      args.push(String(Math.trunc(port)));
    } else if (port !== undefined && port !== null) {
      return json({ ok: false, error: "invalid port" }, 400);
    }
    let child: import("child_process").ChildProcessByStdio<null, import("stream").Readable, import("stream").Readable>;
    try {
      child = spawn("ework-aio", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return json({ ok: false, error: "ework-aio not found" });
    }
    const result = await new Promise<{ ok: boolean; output?: string; error?: string }>((resolve) => {
      const ac = new AbortController();
      const timer = setTimeout(() => {
        ac.abort();
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 30_000);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (r: { ok: boolean; output?: string; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf-8"); });
      child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
      child.once("error", () => finish({ ok: false, error: "ework-aio not found" }));
      child.once("exit", (code) => {
        if (code === 0) finish({ ok: true, output: stdout });
        else finish({ ok: false, error: stderr.trim() || `ework-aio add-daemon exited with code ${code}` });
      });
      ac.signal.addEventListener("abort", () => {
        finish({ ok: false, error: "timeout: ework-aio add-daemon did not exit within 30s" });
      });
    });
    return json(result, result.ok ? 200 : 422);
  }

  const daemonIdRe = /^\/api\/daemons\/(\d+)$/;
  const daemonRestartRe = /^\/api\/daemons\/(\d+)\/restart$/;
  const daemonRemoveRe = /^\/api\/daemons\/(\d+)\/remove$/;

  if (req.method === "POST" && daemonRestartRe.test(url.pathname)) {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    const match = url.pathname.match(daemonRestartRe);
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(id)) return json({ error: "invalid id" }, 400);
    const rows = await getDB().all<{ endpoint: string; status: string }>(
      `SELECT internal_endpoint AS endpoint, status FROM {{d_daemons}} WHERE id = ?`, [id]
    );
    if (rows.length === 0) return json({ ok: false, error: "daemon not found" }, 404);
    await getDB().run(`UPDATE {{d_daemons}} SET status = 'active', last_heartbeat = datetime('now') WHERE id = ?`, [id]);
    return json({ ok: true, note: "reactivated — daemon process will re-register via heartbeat" });
  }

  if (req.method === "DELETE" && daemonRemoveRe.test(url.pathname)) {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    const match = url.pathname.match(daemonRemoveRe);
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(id)) return json({ error: "invalid id" }, 400);
    const rows = await getDB().all<{ status: string }>(`SELECT status FROM {{d_daemons}} WHERE id = ?`, [id]);
    if (rows.length === 0) return json({ ok: false, error: "daemon not found" }, 404);
    const st = String(rows[0]?.status ?? "").toLowerCase();
    if (st === "active") return json({ ok: false, error: "stop (drain) the daemon first before removing" }, 400);
    await getDB().run(`DELETE FROM {{d_daemons}} WHERE id = ?`, [id]);
    return json({ ok: true });
  }

  if (req.method === "DELETE" && daemonIdRe.test(url.pathname)) {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    const match = url.pathname.match(daemonIdRe);
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(id)) return json({ error: "invalid id" }, 400);
    try {
      await getDB().run(`UPDATE {{d_daemons}} SET status = 'drained' WHERE id = ?`, [id]);
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
    return json({ ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/daemons/wire-all") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    if (!rateLimit(`daemons-wire:${ip}`, 5, 5 / 3600)) return json({ error: "rate limited" }, 429);
    try {
      const ids = await listAllProjectIds();
      for (const id of ids) await autoWireDaemon(id, url.origin);
      return json({ ok: true, count: ids.length });
    } catch (e) {
      return json({ ok: false, error: errMsg(e) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/daemons/deploy") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    if (!rateLimit(`daemons-deploy:${ip}`, 10, 10 / 3600)) return json({ error: "rate limited" }, 429);
    const payload = await req.json().catch(() => ({} as unknown));
    if (!payload || typeof payload !== "object") return json({ ok: false, error: "invalid body" }, 400);
    const obj = payload as Record<string, unknown>;
    const sshUser = typeof obj.sshUser === "string" ? obj.sshUser.trim() : "root";
    const mysqlHost = typeof obj.mysqlHost === "string" ? obj.mysqlHost.trim() : "";
    const sshPort = typeof obj.sshPort === "number" && Number.isFinite(obj.sshPort) && obj.sshPort > 0 && obj.sshPort < 65536
      ? Math.trunc(obj.sshPort)
      : 22;
    const sshKeyFile = typeof obj.sshKeyFile === "string" && obj.sshKeyFile.trim() ? obj.sshKeyFile.trim() : undefined;
    const timeoutMs = typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) && obj.timeoutMs >= 30_000 && obj.timeoutMs <= 600_000
      ? Math.trunc(obj.timeoutMs)
      : 180_000;

    const targets: DeployTarget[] = [];
    if (Array.isArray(obj.targets)) {
      for (const t of obj.targets) {
        if (!t || typeof t !== "object") continue;
        const r = t as Record<string, unknown>;
        const host = typeof r.host === "string" ? r.host.trim() : "";
        if (!host) continue;
        targets.push({
          sshHost: host, sshUser, sshPort, sshKeyFile, mysqlHost,
          daemonPort: typeof r.daemonPort === "number" ? Math.trunc(r.daemonPort) : undefined,
        });
      }
    } else {
      const sshHost = typeof obj.sshHost === "string" ? obj.sshHost.trim() : "";
      if (sshHost) {
        targets.push({
          sshHost, sshUser, sshPort, sshKeyFile, mysqlHost,
          daemonPort: typeof obj.daemonPort === "number" ? Math.trunc(obj.daemonPort) : undefined,
        });
      }
    }

    if (targets.length === 0 || !mysqlHost) {
      return json({ ok: false, error: "至少需要一个目标 + mysqlHost" }, 400);
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (s: string) => writer.write(enc.encode(`data: ${JSON.stringify(s)}\n\n`));

    if (targets.length === 1) {
      const [single] = targets;
      send(`▶ 部署到 ${single!.sshHost}:${single!.daemonPort ?? 3101}（超时 ${timeoutMs / 1000}s）...\n\n`);
      deployRemoteDaemon({ ...single!, timeoutMs, onOutput: (chunk) => send(chunk) })
        .then((result) => {
          send(`\n${result.ok ? "✓ 成功" : "✗ 失败"}: ${result.ok ? "daemon 已部署" : (result.error || "未知错误")}\n`);
          if (result.output) send(result.output);
        })
        .catch((e) => send(`\n✗ 异常: ${e instanceof Error ? e.message : String(e)}\n`))
        .finally(() => writer.close());
    } else {
      deployBatch(targets, timeoutMs, (label, chunk) => send(`[${label}] ${chunk}`))
        .then((results) => {
          const ok = [...results.values()].every((r) => r.ok);
          send(`\n${ok ? "ALL OK" : "SOME FAILED"}: ${[...results.entries()].map(([k, v]) => `${k}=${v.ok ? "✓" : "✗"}`).join(", ")}`);
        })
        .catch((e) => send(`ERROR: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => writer.close());
    }

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  if (url.pathname === "/api/router/daemons" && req.method === "GET") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    try {
      const routerUrl = cfg.daemonWebhookUrl.replace(/\/$/, "");
      const res = await fetch(`${routerUrl}/api/daemons`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return json(data);
    } catch (e) {
      return json({ daemons: [], error: errMsg(e) });
    }
  }

  if (url.pathname === "/api/router/strategy") {
    if (!ctx.user || ctx.user.is_admin !== 1) return json({ error: "admin required" }, 403);
    const routerUrl = cfg.daemonWebhookUrl.replace(/\/$/, "");
    const routerHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.routerAdminToken) routerHeaders["Authorization"] = `Bearer ${cfg.routerAdminToken}`;
    try {
      if (req.method === "GET") {
        const res = await fetch(`${routerUrl}/api/strategy`, { headers: routerHeaders, signal: AbortSignal.timeout(5000) });
        return json(await res.json());
      }
      if (req.method === "POST") {
        const body = await req.text();
        const res = await fetch(`${routerUrl}/api/strategy`, {
          method: "POST",
          headers: routerHeaders,
          body,
          signal: AbortSignal.timeout(5000),
        });
        return json(await res.json(), res.ok ? 200 : 400);
      }
    } catch (e) {
      return json({ error: errMsg(e) }, 502);
    }
  }

  if (url.pathname === "/settings") {
    if (req.method === "GET") {
      return html(buildSettingsPage(cfg, url.searchParams.get("saved") === "1", ctx.user!, await listCachedModels()).html);
    }
    if (req.method === "POST") {
      if (!rateLimit(`settings:${ip}`, 10, 10 / 60)) return html(errorPage("太快了", "请稍后再试"), 429);
      const form = await req.formData();
      let bad = "";
      for (const key of DB_OVERRIDABLE) {
        const v = form.get(String(key));
        if (typeof v !== "string") continue;
        if (parseOverride(key, v) === null) { bad = String(key); break; }
        await setConfig(String(key), v);
      }
      if (bad) return html(errorPage(`无效的字段: ${bad}`, "请检查输入后重试"), 400);
      Object.assign(cfg, await loadConfig());
      const rh = new Headers(SEC_HEADERS);
      rh.set("location", "/settings?saved=1");
      return new Response(null, { status: 303, headers: rh });
    }
  }

  if (url.pathname === "/settings/models/refresh" && req.method === "POST") {
    if (!ctx.user || ctx.user.is_admin !== 1) return html(errorPage("403", "需要管理员"), 403);
    const ids = await opencode.listModels();
    await replaceCachedModels(ids);
    // M-1: pin a default model so opencode never falls back to env vars. The
    // previous empty default meant the daemon omitted --model and opencode
    // picked the model from leaked env (e.g. OPENCODE_MODEL / a provider
    // default) — silent and wrong. Pick the first available model when none
    // is configured; the operator can change or clear it on /settings.
    if (!cfg.defaultModel) {
      const picked = ids.find((id) => typeof id === "string" && id.length > 0);
      if (picked) {
        await setConfig("defaultModel", picked);
        Object.assign(cfg, await loadConfig());
      }
    }
    const rh = new Headers(SEC_HEADERS);
    rh.set("location", "/settings?saved=1");
    return new Response(null, { status: 303, headers: rh });
  }

  if (url.pathname === "/me") {
    const me = ctx.user!;
    const flashKind = url.searchParams.get("ok") === "1" ? "ok" : url.searchParams.get("err") ? "err" : null;
    const flashMsg = url.searchParams.get("ok") === "1" ? url.searchParams.get("ok_msg")! : url.searchParams.get("err");
    const flash = flashKind ? { kind: flashKind as "ok" | "err", msg: flashMsg ?? "" } : null;
    return html(buildMePage(me, flash));
  }

  if (url.pathname === "/me/password" && req.method === "POST") {
    const me = ctx.user!;
    if (!rateLimit(`pw:${ip}`, 10, 10 / 60)) {
      return Response.redirect(`${url.origin}/me?err=${encodeURIComponent("太快了，稍后再试")}`, 303);
    }
    const form = await req.formData().catch(() => new FormData());
    const oldPw = String(form.get("old") ?? "");
    const newPw = String(form.get("new") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (me.password_hash) {
      const ok = await verifyUserPassword(me.login, oldPw);
      if (!ok) return Response.redirect(`${url.origin}/me?err=${encodeURIComponent("当前密码错误")}`, 303);
    }
    if (newPw !== confirm) {
      return Response.redirect(`${url.origin}/me?err=${encodeURIComponent("两次新密码不一致")}`, 303);
    }
    try {
      await setUserPassword(me.login, newPw);
    } catch (e) {
      return Response.redirect(`${url.origin}/me?err=${encodeURIComponent(errMsg(e))}`, 303);
    }
    return Response.redirect(`${url.origin}/me?ok=1&ok_msg=${encodeURIComponent("密码已更新")}`, 303);
  }

  if (url.pathname === "/me/tokens") {
    const me = ctx.user!;
    const flashKind = url.searchParams.get("ok") === "1" ? "ok" : url.searchParams.get("err") ? "err" : null;
    const flashMsg = url.searchParams.get("ok") === "1" ? url.searchParams.get("ok_msg")! : url.searchParams.get("err");
    const flash = flashKind ? { kind: flashKind as "ok" | "err", msg: flashMsg ?? "" } : null;
    return html(buildTokensPage(me, await listPatsForUser(me.login), flash));
  }

  if (url.pathname === "/me/tokens/create" && req.method === "POST") {
    const me = ctx.user!;
    if (!rateLimit(`pat-create:${ip}`, 10, 10 / 60)) {
      return Response.redirect(`${url.origin}/me/tokens?err=${encodeURIComponent("太快了，稍后再试")}`, 303);
    }
    const form = await req.formData().catch(() => new FormData());
    const name = String(form.get("name") ?? "").trim();
    const expiresAt = String(form.get("expires_at") ?? "").trim() || null;
    const ipAllowRaw = String(form.get("ip_allowlist") ?? "").trim();
    const ipAllowlist = ipAllowRaw ? ipAllowRaw.split(/[\s,]+/).filter(Boolean) : undefined;
    try {
      const result = await createPat({ user_login: me.login, name, expires_at: expiresAt, ip_allowlist: ipAllowlist });
      return html(buildTokenCreatedPage(me, result.plaintext, result.row.name));
    } catch (e) {
      return Response.redirect(`${url.origin}/me/tokens?err=${encodeURIComponent(errMsg(e))}`, 303);
    }
  }

  const patRevoke = url.pathname.match(/^\/me\/tokens\/(\d+)\/revoke$/);
  if (patRevoke && req.method === "POST") {
    const me = ctx.user!;
    const id = Number(patRevoke[1]);
    try {
      revokePat(id, me.login);
      return Response.redirect(`${url.origin}/me/tokens?ok=1&ok_msg=${encodeURIComponent("已吊销")}`, 303);
    } catch (e) {
      return Response.redirect(`${url.origin}/me/tokens?err=${encodeURIComponent(errMsg(e))}`, 303);
    }
  }

  if (url.pathname.startsWith("/admin/") && ctx.user!.is_admin !== 1) {
    return html(errorPage("无权限", "需要管理员账户"), 403);
  }
  if (url.pathname === "/admin/users") {
    if (req.method === "GET") {
      const flashKind = url.searchParams.get("ok") === "1" ? "ok" : url.searchParams.get("err") ? "err" : null;
      const flashMsg = url.searchParams.get("ok") === "1" ? url.searchParams.get("ok_msg")! : url.searchParams.get("err");
      const flash = flashKind ? { kind: flashKind as "ok" | "err", msg: flashMsg ?? "" } : null;
      return html(buildAdminUsersPage(ctx.user!, await listUsers(), flash));
    }
  }

  if (url.pathname === "/admin/tokens") {
    const flashKind = url.searchParams.get("ok") === "1" ? "ok" : url.searchParams.get("err") ? "err" : null;
    const flashMsg = url.searchParams.get("ok") === "1" ? url.searchParams.get("ok_msg")! : url.searchParams.get("err");
    const flash = flashKind ? { kind: flashKind as "ok" | "err", msg: flashMsg ?? "" } : null;
    return html(buildAdminTokensPage(ctx.user!, await listAllPatsWithUsers(), flash));
  }

  if (url.pathname === "/admin/deliveries") {
    const deliveries = await listAllRecentDeliveries(100);
    return html(buildWebhookDeliveriesPage(ctx.user!, deliveries));
  }

  const adminPatRevoke = url.pathname.match(/^\/admin\/tokens\/(\d+)\/revoke$/);
  if (adminPatRevoke && req.method === "POST") {
    const id = Number(adminPatRevoke[1]);
    try {
      revokePatAsAdmin(id);
      return Response.redirect(`${url.origin}/admin/tokens?ok=1&ok_msg=${encodeURIComponent("已吊销")}`, 303);
    } catch (e) {
      return Response.redirect(`${url.origin}/admin/tokens?err=${encodeURIComponent(errMsg(e))}`, 303);
    }
  }

  const ttsIdRe = /^[A-Za-z0-9_-]+$/;
  const ttsRedir = (kind: "ok" | "err", msg: string): Response =>
    Response.redirect(`${url.origin}/admin/tts-backends?${kind === "ok" ? "ok=1&ok_msg" : "err"}=${encodeURIComponent(msg)}`, 303);

  if (url.pathname === "/admin/tts-backends") {
    const flashKind = url.searchParams.get("ok") === "1" ? "ok" : url.searchParams.get("err") ? "err" : null;
    const flashMsg = flashKind === "ok" ? url.searchParams.get("ok_msg")! : url.searchParams.get("err");
    const flash = flashKind ? { kind: flashKind as "ok" | "err", msg: flashMsg ?? "" } : null;
    return html(buildTtsBackendsPage(ctx.user!, cfg.ttsBackends, cfg.ttsDefaultBackend, flash));
  }

  if (url.pathname === "/admin/tts-backends/add" && req.method === "POST") {
    if (!rateLimit(`admin:${ip}`, 20, 20 / 60)) return ttsRedir("err", "太快了");
    const form = await req.formData();
    const id = String(form.get("id") ?? "").trim();
    const label = String(form.get("label") ?? "").trim();
    const beUrl = String(form.get("url") ?? "").trim();
    const voice = String(form.get("voice") ?? "").trim();
    if (!ttsIdRe.test(id)) return ttsRedir("err", "ID 只能含字母数字 _ -");
    if (!label) return ttsRedir("err", "label 必填");
    if (cfg.ttsBackends.some((b) => b.id === id)) return ttsRedir("err", `ID '${id}' 已存在`);
    const list = [...cfg.ttsBackends, { id, label, url: beUrl, voice }];
    await setConfig("ttsBackends", JSON.stringify(list));
    Object.assign(cfg, await loadConfig());
    return ttsRedir("ok", `已添加 ${id}`);
  }

  const ttsUpdate = url.pathname.match(/^\/admin\/tts-backends\/([A-Za-z0-9_-]+)\/update$/);
  if (ttsUpdate && req.method === "POST") {
    if (!rateLimit(`admin:${ip}`, 20, 20 / 60)) return ttsRedir("err", "太快了");
    const oldId = ttsUpdate[1]!;
    const form = await req.formData();
    const newId = String(form.get("id") ?? "").trim();
    const label = String(form.get("label") ?? "").trim();
    const beUrl = String(form.get("url") ?? "").trim();
    const voice = String(form.get("voice") ?? "").trim();
    if (!ttsIdRe.test(newId)) return ttsRedir("err", "ID 只能含字母数字 _ -");
    if (!label) return ttsRedir("err", "label 必填");
    const list = cfg.ttsBackends;
    const idx = list.findIndex((b) => b.id === oldId);
    if (idx < 0) return ttsRedir("err", `后端 '${oldId}' 不存在`);
    if (newId !== oldId && list.some((b) => b.id === newId)) return ttsRedir("err", `ID '${newId}' 已被占用`);
    list[idx] = { id: newId, label, url: beUrl, voice };
    await setConfig("ttsBackends", JSON.stringify(list));
    if (cfg.ttsDefaultBackend === oldId && newId !== oldId) await setConfig("ttsDefaultBackend", newId);
    Object.assign(cfg, await loadConfig());
    return ttsRedir("ok", `已更新 ${newId}`);
  }

  const ttsDelete = url.pathname.match(/^\/admin\/tts-backends\/([A-Za-z0-9_-]+)\/delete$/);
  if (ttsDelete && req.method === "POST") {
    if (!rateLimit(`admin:${ip}`, 20, 20 / 60)) return ttsRedir("err", "太快了");
    const id = ttsDelete[1]!;
    if (cfg.ttsDefaultBackend === id) return ttsRedir("err", "不能删除默认后端，先在设置里改默认");
    const list = cfg.ttsBackends;
    const idx = list.findIndex((b) => b.id === id);
    if (idx < 0) return ttsRedir("err", `后端 '${id}' 不存在`);
    list.splice(idx, 1);
    await setConfig("ttsBackends", JSON.stringify(list));
    Object.assign(cfg, await loadConfig());
    return ttsRedir("ok", `已删除 ${id}`);
  }

  if (url.pathname === "/admin/users/create" && req.method === "POST") {
    if (!rateLimit(`admin:${ip}`, 20, 20 / 60)) {
      return Response.redirect(`${url.origin}/admin/users?err=${encodeURIComponent("太快了")}`, 303);
    }
    const form = await req.formData().catch(() => new FormData());
    const login = String(form.get("login") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const email = String(form.get("email") ?? "").trim() || undefined;
    const kind = (String(form.get("kind") ?? "human") as "human" | "bot" | "system") || "human";
    const isAdmin = form.get("is_admin") === "1";
    try {
      const u = await createUser({ login, password, email, kind, is_admin: isAdmin });
      return Response.redirect(`${url.origin}/admin/users?ok=1&ok_msg=${encodeURIComponent(`已创建用户 ${u.login}`)}`, 303);
    } catch (e) {
      return Response.redirect(`${url.origin}/admin/users?err=${encodeURIComponent(errMsg(e))}`, 303);
    }
  }

  const userActionRe = url.pathname.match(/^\/admin\/users\/([^/]+)\/(reset-password|toggle-admin|toggle-active)$/);
  if (userActionRe && req.method === "POST") {
    const [, targetLogin, action] = userActionRe;
    if (!(targetLogin && action)) return html(errorPage("bad path", ""), 400);
    if (isReservedSystemLogin(targetLogin, cfg)) {
      return Response.redirect(`${url.origin}/admin/users?err=${encodeURIComponent("系统保留账户不能修改")}`, 303);
    }
    try {
      if (action === "reset-password") {
        const form = await req.formData().catch(() => new FormData());
        const pw = String(form.get("password") ?? "");
        await setUserPassword(targetLogin, pw);
        return Response.redirect(`${url.origin}/admin/users?ok=1&ok_msg=${encodeURIComponent(`${targetLogin} 密码已重置`)}`, 303);
      }
      if (action === "toggle-admin") {
        if (targetLogin === ctx.user!.login) {
          return Response.redirect(`${url.origin}/admin/users?err=${encodeURIComponent("不能改自己的 admin 状态")}`, 303);
        }
        const u = await getUserByLogin(targetLogin);
        if (!u) throw new StoreError(404, "用户不存在");
        if (u.is_admin === 1 && (await countAdmins()) <= 1) {
          return Response.redirect(`${url.origin}/admin/users?err=${encodeURIComponent("系统至少要保留一个 admin")}`, 303);
        }
        const updated = await updateUser(targetLogin, { is_admin: u.is_admin !== 1 });
        return Response.redirect(`${url.origin}/admin/users?ok=1&ok_msg=${encodeURIComponent(`${updated.login} ${updated.is_admin ? "已设为 admin" : "已取消 admin"}`)}`, 303);
      }
      if (action === "toggle-active") {
        if (targetLogin === ctx.user!.login) {
          return Response.redirect(`${url.origin}/admin/users?err=${encodeURIComponent("不能禁用自己的账户")}`, 303);
        }
        const u = await getUserByLogin(targetLogin);
        if (!u) throw new StoreError(404, "用户不存在");
        if (u.is_active === 1 && u.is_admin === 1 && (await countAdmins()) <= 1) {
          return Response.redirect(`${url.origin}/admin/users?err=${encodeURIComponent("不能禁用最后一个 admin")}`, 303);
        }
        const updated = await updateUser(targetLogin, { is_active: u.is_active !== 1 });
        return Response.redirect(`${url.origin}/admin/users?ok=1&ok_msg=${encodeURIComponent(`${updated.login} ${updated.is_active ? "已启用" : "已禁用"}`)}`, 303);
      }
      return html(errorPage("bad action", ""), 400);
    } catch (e) {
      return Response.redirect(`${url.origin}/admin/users?err=${encodeURIComponent(errMsg(e))}`, 303);
    }
  }

  const sinceApi = url.pathname.match(SESSION_SINCE_RE);
  if (sinceApi) {
    const [, sid] = sinceApi;
    if (!sid) return json({ error: "bad session path" }, 400);
    const sinceNum = Number(url.searchParams.get("since") ?? "0");
    const since = Number.isFinite(sinceNum) ? sinceNum : 0;
    try {
      const data = await opencode.exportSession(sid);
      const { items, lastCreated } = renderNewMessages(data, since, cfg.collapseLines);
      return json({ items, lastCreated });
    } catch (e) {
      return json({ error: errMsg(e) }, e instanceof OpencodeError ? e.status : 502);
    }
  }

  const batchApi = url.pathname.match(SESSION_BATCH_RE);
  if (batchApi) {
    const [, sid] = batchApi;
    if (!sid) return json({ error: "bad session path" }, 400);
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 30));
    const desc = url.searchParams.get("asc") !== "1";
    try {
      const data = await opencode.exportSession(sid);
      const batch = renderBatchHTML(data, offset, limit, desc, cfg.collapseLines);
      return json(batch);
    } catch (e) {
      return json({ error: errMsg(e) }, e instanceof OpencodeError ? e.status : 502);
    }
  }

  const issueLabelsApi = url.pathname.match(API_ISSUE_LABELS_RE);
  if (issueLabelsApi) {
    const [, owner, repo, numStr] = issueLabelsApi;
    if (!(owner && repo && numStr)) return html(errorPage("404", "bad path"), 404);
    const project = await getProject(owner, repo);
    if (!project) return json({ error: "project not found" }, 404);
    const issue = await getIssueWithMeta(project.id, Number(numStr));
    if (!issue) return json({ error: "issue not found" }, 404);
    if (req.method === "GET") {
      const [current, available] = await Promise.all([
        listLabelsForIssue(issue.id),
        listLabels(project.id),
      ]);
      return json({ current, available });
    }
    if (req.method === "POST") {
      if (!ctx.user || !(await canWriteProject(project.id, ctx.user))) {
        return json({ error: "forbidden: needs writer role on project" }, 403);
      }
      const body = await req.json().catch(() => ({}));
      const labelIds = Array.isArray(body.labelIds) ? body.labelIds.map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0) : [];
      try {
        await setIssueLabels(issue.id, labelIds);
        const current = await listLabelsForIssue(issue.id);
        return json({ current });
      } catch (e) {
        return json({ error: errMsg(e) }, e instanceof StoreError ? e.status : 500);
      }
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (req.method === "POST") {
    if (!cfg.writesEnabled) return json({ error: "writes disabled" }, 403);
    const up = url.pathname.match(UPLOAD_RE);
    if (up) {
      const [, owner, repo, numStr] = up;
      if (!(owner && repo && numStr)) return json({ error: "bad path" }, 400);
      const cl = Number(req.headers.get("content-length") ?? "0");
      if (cl > MAX_ATTACHMENT_BYTES) return json({ error: "file too large (max 20MB)" }, 413);
      const number = Number(numStr);
      try {
        const project = await getProject(owner, repo);
        if (!project) return json({ error: "project not found" }, 404);
        if (!(await canWriteProject(project.id, ctx.user))) return json({ error: "forbidden: needs writer role on project" }, 403);
        const issue = await getIssueWithMeta(project.id, number);
        if (!issue) return json({ error: "issue not found" }, 404);
        const form = await req.formData().catch(() => null);
        const file = form?.get("attachment");
        if (!(file instanceof File)) return json({ error: "attachment required" }, 400);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > MAX_ATTACHMENT_BYTES) return json({ error: "file too large (max 20MB)" }, 413);
        const filename = file.name || "upload.bin";
        const contentType = file.type || sniffImageContentType(filename);
        const uuid = newAttachmentUUID();
        const blobPath = saveAttachmentBlob(uuid, bytes);
        await createAttachment({
          uuid,
          issue_id: issue.id,
          filename,
          content_type: contentType,
          size: bytes.length,
          blob_path: blobPath,
          uploaded_by: ctx.user!.login,
        });
        const isImg = isImageContentType(contentType);
        const markdown = isImg
          ? `![${filename}](/attachments/${uuid})`
          : `[${filename}](/attachments/${uuid})`;
        return json({ uuid, name: filename, markdown });
      } catch (e) {
        return json({ error: errMsg(e) }, e instanceof StoreError ? e.status : 500);
      }
    }

    const cp = url.pathname.match(COMMENT_POST_RE);
    if (cp) {
      const [, owner, repo, numStr] = cp;
      if (!(owner && repo && numStr)) return json({ error: "bad path" }, 400);
      const number = Number(numStr);
      try {
        const payload = (await req.json().catch(() => ({}))) as { body?: unknown; close?: unknown; reopen?: unknown };
        const body = typeof payload.body === "string" ? payload.body : "";
        const hasBody = body.trim().length > 0;
        const wantsStateChange = payload.close === true || payload.reopen === true;
        if (!hasBody && !wantsStateChange) return json({ error: "body required" }, 400);
        if (body.length > 65536) return json({ error: "body too long" }, 413);
        const project = await getProject(owner, repo);
        if (!project) return json({ error: "project not found" }, 404);
        if (!(await canWriteProject(project.id, ctx.user))) return json({ error: "forbidden: needs writer role on project" }, 403);
        const issue = await getIssueWithMeta(project.id, number);
        if (!issue) return json({ error: "issue not found" }, 404);
        let view: CommentView | null = null;
        if (hasBody) {
          const c = await postComment(issue.id, body, ctx.user!.login);
          view = {
            id: c.id,
            tag: classifyActor(c.body, c.author_kind),
            login: c.author,
            avatar: "",
            created_at: c.created_at,
            body_html: renderMarkdown(c.body),
          };
        }
        let closed = false;
        let reopened = false;
        if (payload.close === true) {
          await setIssueState(issue.id, "closed");
          closed = true;
          void emitIssueEvent(project.id, issue.id, "closed", url.origin);
        } else if (payload.reopen === true) {
          await setIssueState(issue.id, "open");
          reopened = true;
          void emitIssueEvent(project.id, issue.id, "reopened", url.origin);
        }
        if (view) {
          void emitCommentEvent(project.id, issue.id, view.id, url.origin);
        }
        return json({ comment: view, closed, reopened });
      } catch (e) {
        return json({ error: errMsg(e) }, e instanceof StoreError ? e.status : 500);
      }
    }

    const ci = url.pathname.match(REPO_LIST_RE);
    if (ci) {
      const [, owner, repo] = ci;
      if (!(owner && repo)) return json({ error: "bad path" }, 400);
      try {
        const form = await req.formData().catch(() => new FormData());
        const title = String(form.get("title") ?? "").trim();
        const body = String(form.get("body") ?? "");
        if (!title) return html(errorPage("标题不能为空", "回到上一页填写标题后重试"), 400);
        let project = await getProject(owner, repo);
        let createdProject = false;
        if (!project) {
          project = await createProjectSafe(owner, repo);
          createdProject = true;
        }
        if (!(await canWriteProject(project.id, ctx.user))) {
          return html(errorPage("无权限", "需要该项目 writer 及以上角色才能创建 issue"), 403);
        }
        if (createdProject) {
          await ensureProjectBootstrapAdmin(project.id, ctx.user!.login);
          await autoWireDaemon(project.id, url.origin);
        }
        const issue = await createIssue(project.id, title, body, ctx.user!.login);
        void emitIssueEvent(project.id, issue.id, "opened", url.origin);
        return Response.redirect(
          `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issue.number}`,
          303
        );
      } catch (e) {
        return html(errorPage("创建失败", errMsg(e)), e instanceof StoreError ? e.status : 500);
      }
    }

    const whCreate = url.pathname.match(REPO_WEBHOOKS_RE);
    if (whCreate) {
      const [, owner, repo] = whCreate;
      if (!(owner && repo)) return html(errorPage("bad path", ""), 400);
      try {
        const project = await getProject(owner, repo);
        if (!project) return html(errorPage("项目不存在", ""), 404);
        if (!(await canAdminProject(project.id, ctx.user))) {
          return html(errorPage("无权限", "需要该项目 admin 角色才能管理 webhook"), 403);
        }
        const form = await req.formData().catch(() => new FormData());
        const url_ = String(form.get("url") ?? "").trim();
        const secret = String(form.get("secret") ?? "");
        const events = form.getAll("events") as string[];
        const validEvents = (events.length > 0 ? events : ["issues", "issue_comment"])
          .filter((e): e is WebhookEventName => e === "issues" || e === "issue_comment");
        const wh = await createWebhook({
          project_id: project.id,
          url: url_,
          secret,
          events: validEvents,
        });
        return Response.redirect(
          `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/webhooks#wh-${wh.id}`,
          303
        );
      } catch (e) {
        return html(errorPage("添加失败", errMsg(e)), e instanceof StoreError ? e.status : 500);
      }
    }

    const memberAdd = url.pathname.match(REPO_MEMBER_ADD_RE);
    if (memberAdd) {
      const [, owner, repo] = memberAdd;
      if (!(owner && repo)) return html(errorPage("bad path", ""), 400);
      const project = await getProject(owner, repo);
      if (!project) return html(errorPage("项目不存在", ""), 404);
      const back = `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/members`;
      if (!(await canAdminProject(project.id, ctx.user))) {
        return Response.redirect(`${back}?err=${encodeURIComponent("无权限")}`, 303);
      }
      const form = await req.formData().catch(() => new FormData());
      const login = String(form.get("login") ?? "").trim();
      const role = String(form.get("role") ?? "writer") as ProjectRole;
      if (!["reader", "writer", "admin"].includes(role)) {
        return Response.redirect(`${back}?err=${encodeURIComponent("非法角色")}`, 303);
      }
      try {
        await addProjectMember(project.id, login, role);
        return Response.redirect(`${back}?ok=1&ok_msg=${encodeURIComponent(`已添加 ${login} 为 ${role}`)}`, 303);
      } catch (e) {
        return Response.redirect(`${back}?err=${encodeURIComponent(errMsg(e))}`, 303);
      }
    }

    const memberAction = url.pathname.match(REPO_MEMBER_ACTION_RE);
    if (memberAction) {
      const [, owner, repo, targetLogin, action] = memberAction;
      if (!(owner && repo && targetLogin && action)) return html(errorPage("bad path", ""), 400);
      const project = await getProject(owner, repo);
      if (!project) return html(errorPage("项目不存在", ""), 404);
      const back = `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/members`;
      if (!(await canAdminProject(project.id, ctx.user))) {
        return Response.redirect(`${back}?err=${encodeURIComponent("无权限")}`, 303);
      }
      try {
        if (action === "role") {
          const form = await req.formData().catch(() => new FormData());
          const role = String(form.get("role") ?? "") as ProjectRole;
          if (!["reader", "writer", "admin"].includes(role)) {
            return Response.redirect(`${back}?err=${encodeURIComponent("非法角色")}`, 303);
          }
          // Guard last admin: don't let the only project admin demote themselves.
          const current = await getProjectMembership(project.id, targetLogin);
          if (
            current?.role === "admin" &&
            role !== "admin" &&
            (await countProjectAdmins(project.id)) <= 1
          ) {
            return Response.redirect(`${back}?err=${encodeURIComponent("最后一个 admin 不能降级")}`, 303);
          }
          await setProjectMemberRole(project.id, targetLogin, role);
          return Response.redirect(`${back}?ok=1&ok_msg=${encodeURIComponent(`${targetLogin} → ${role}`)}`, 303);
        }
        if (action === "remove") {
          const current = await getProjectMembership(project.id, targetLogin);
          if (current?.role === "admin" && (await countProjectAdmins(project.id)) <= 1) {
            return Response.redirect(`${back}?err=${encodeURIComponent("最后一个 admin 不能移除")}`, 303);
          }
          await removeProjectMember(project.id, targetLogin);
          return Response.redirect(`${back}?ok=1&ok_msg=${encodeURIComponent(`已移除 ${targetLogin}`)}`, 303);
        }
        return html(errorPage("bad action", ""), 400);
      } catch (e) {
        return Response.redirect(`${back}?err=${encodeURIComponent(errMsg(e))}`, 303);
      }
    }

    const visMatch = url.pathname.match(REPO_VISIBILITY_RE);
    if (visMatch) {
      const [, owner, repo] = visMatch;
      if (!(owner && repo)) return html(errorPage("bad path", ""), 400);
      const project = await getProject(owner, repo);
      if (!project) return html(errorPage("项目不存在", ""), 404);
      const back = `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/members`;
      if (!(await canAdminProject(project.id, ctx.user))) {
        return Response.redirect(`${back}?err=${encodeURIComponent("无权限")}`, 303);
      }
      const fd = await req.formData();
      const visibility = fd.get("visibility");
      if (visibility !== "public" && visibility !== "private") {
        return Response.redirect(`${back}?err=${encodeURIComponent("无效的可见性")}`, 303);
      }
      await updateProjectVisibility(project.id, visibility);
      return Response.redirect(`${back}?ok=1&ok_msg=${encodeURIComponent(`可见性已更新为 ${visibility === "public" ? "公开" : "私有"}`)}`, 303);
    }

    const whAction = url.pathname.match(WH_ACTION_RE);
    if (whAction) {
      const [, idStr, action] = whAction;
      const id = Number(idStr || "0");
      if (!id) return html(errorPage("bad webhook id", ""), 400);
      const wh = await getWebhook(id);
      if (!wh) return html(errorPage("webhook 不存在", ""), 404);
      const project = await getProjectById(wh.project_id);
      if (!project) return html(errorPage("项目不存在", ""), 404);
      if (!(await canAdminProject(project.id, ctx.user))) {
        return html(errorPage("无权限", "需要该项目 admin 角色才能管理 webhook"), 403);
      }
      const back = `${url.origin}/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/webhooks`;
      if (action === "delete") {
        await deleteWebhook(id);
      } else if (action === "toggle") {
        const form = await req.formData().catch(() => new FormData());
        const wantActive = form.get("active") === "1";
        await setWebhookActive(id, wantActive);
      } else if (action === "test") {
        void emitPingEvent(wh.project_id, url.origin);
      }
      return Response.redirect(back, 303);
    }

    const upstreamSave = url.pathname.match(REPO_UPSTREAMS_RE);
    if (upstreamSave) {
      const [, owner, repo] = upstreamSave;
      if (!(owner && repo)) return html(errorPage("bad path", ""), 400);
      const project = await getProject(owner, repo);
      if (!project) return html(errorPage("项目不存在", ""), 404);
      const back = `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/upstreams`;
      if (!(await canAdminProject(project.id, ctx.user))) {
        return Response.redirect(`${back}?err=${encodeURIComponent("无权限")}`, 303);
      }
      const form = await req.formData().catch(() => new FormData());
      const raw = String(form.get("urls") ?? "");
      const result = await trySetUpstreamUrls(project.id, raw);
      if (result.ok) {
        return Response.redirect(
          `${back}?ok=1&ok_msg=${encodeURIComponent(`已保存 ${result.urls.length} 个上游 URL`)}`,
          303,
        );
      }
      return Response.redirect(`${back}?err=${encodeURIComponent(result.msg)}`, 303);
    }

    const modelSave = url.pathname.match(REPO_MODEL_RE);
    if (modelSave) {
      const [, owner, repo] = modelSave;
      if (!(owner && repo)) return html(errorPage("bad path", ""), 400);
      const project = await getProject(owner, repo);
      if (!project) return html(errorPage("项目不存在", ""), 404);
      const back = `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/model`;
      if (!(await canAdminProject(project.id, ctx.user))) {
        return Response.redirect(`${back}?err=${encodeURIComponent("无权限")}`, 303);
      }
      const form = await req.formData().catch(() => new FormData());
      const raw = String(form.get("model") ?? "").trim();
      try {
        await setProjectModel(project.id, raw);
        return Response.redirect(`${back}?ok=1&ok_msg=${encodeURIComponent("模型已保存")}`, 303);
      } catch (e) {
        const msg = e instanceof StoreError ? e.message : (e instanceof Error ? e.message : "保存失败");
        return Response.redirect(`${back}?err=${encodeURIComponent(msg)}`, 303);
      }
    }

    const labelAdd = url.pathname.match(REPO_LABEL_ADD_RE);
    if (labelAdd) {
      const [, owner, repo] = labelAdd;
      if (!(owner && repo)) return html(errorPage("bad path", ""), 400);
      const project = await getProject(owner, repo);
      if (!project) return html(errorPage("项目不存在", ""), 404);
      const back = `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/labels`;
      if (!(await canAdminProject(project.id, ctx.user))) {
        return Response.redirect(`${back}?err=${encodeURIComponent("无权限")}`, 303);
      }
      const form = await req.formData().catch(() => new FormData());
      try {
        await createLabel(project.id, {
          name: String(form.get("name") ?? ""),
          color: String(form.get("color") ?? "#888888"),
          description: String(form.get("description") ?? ""),
          exclusive: form.get("exclusive") === "1",
        });
        return Response.redirect(`${back}?ok=1&ok_msg=${encodeURIComponent("标签已创建")}`, 303);
      } catch (e) {
        return Response.redirect(`${back}?err=${encodeURIComponent(errMsg(e))}`, 303);
      }
    }

    const labelAction = url.pathname.match(REPO_LABEL_ACTION_RE);
    if (labelAction) {
      const [, owner, repo, lidStr, action] = labelAction;
      if (!(owner && repo && lidStr && action)) return html(errorPage("bad path", ""), 400);
      const project = await getProject(owner, repo);
      if (!project) return html(errorPage("项目不存在", ""), 404);
      const back = `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/labels`;
      if (!(await canAdminProject(project.id, ctx.user))) {
        return Response.redirect(`${back}?err=${encodeURIComponent("无权限")}`, 303);
      }
      const lid = Number(lidStr);
      const form = await req.formData().catch(() => new FormData());
      try {
        if (action === "update") {
          await updateLabel(project.id, lid, {
            name: String(form.get("name") ?? ""),
            color: String(form.get("color") ?? "#888888"),
            description: String(form.get("description") ?? ""),
            exclusive: form.get("exclusive") === "1",
          });
        } else if (action === "archive" || action === "unarchive") {
          await archiveLabel(project.id, lid, action === "archive");
        } else if (action === "delete") {
          await deleteLabel(project.id, lid);
        }
        return Response.redirect(`${back}?ok=1`, 303);
      } catch (e) {
        return Response.redirect(`${back}?err=${encodeURIComponent(errMsg(e))}`, 303);
      }
    }

    return json({ error: "not found" }, 404);
  }

  const api = url.pathname.match(API_RE);
  if (api) {
    const [, owner, repo, numStr, kind] = api;
    if (!(owner && repo && numStr && kind)) return html(errorPage("404", "bad path"), 404);
    const number = Number(numStr);
    try {
      if (kind === "page") {
        const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
        const { issue, views, currentPage, hasOlder } = await fetchIssuePage(owner, repo, number, page);
        const payload = {
          owner,
          repo,
          number,
          issueTitle: issue.title,
          state: issue.state,
          totalComments: issue.comment_count,
          currentPage,
          hasOlder,
          comments: views,
        };
        return json(payload);
      }
      const since = url.searchParams.get("since") ?? new Date(0).toISOString();
      const views = await fetchIssueSince(owner, repo, number, since);
      return json({ comments: views });
    } catch (e) {
      return json({ error: errMsg(e) }, e instanceof StoreError ? e.status : 500);
    }
  }

  const isNew = url.pathname.match(REPO_NEW_RE);
  if (isNew) {
    const [, owner, repo] = isNew;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    return html(buildIssueNew(owner, repo, cfg.writesEnabled));
  }

  const view = url.pathname.match(REPO_ISSUE_RE);
  if (view) {
    const [, owner, repo, numStr] = view;
    if (!(owner && repo && numStr)) return html(errorPage("404", "bad path"), 404);
    const number = Number(numStr);
    try {
      const project = await getProject(owner, repo);
      if (!project) return html(errorPage("404", "项目不存在"), 404);
      if (!(await canReadProject(project.id, ctx.user))) return html(errorPage("404", "项目不存在"), 404);
      const { html: body } = await buildIssueThread(cfg, owner, repo, number, ctx.user?.login);
      return html(body);
    } catch (e) {
      const status = e instanceof StoreError ? e.status : 500;
      return html(errorPage(status === 404 ? "找不到 issue" : "加载失败", errMsg(e)), status);
    }
  }

  const list = url.pathname.match(REPO_LIST_RE);
  if (list) {
    const [, owner, repo] = list;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    const project = await getProject(owner, repo);
    if (!project) return html(errorPage("404", "项目不存在"), 404);
    if (!(await canReadProject(project.id, ctx.user))) return html(errorPage("404", "项目不存在"), 404);
    const state = parseState(url.searchParams.get("state"));
    const q = url.searchParams.get("q")?.trim() ?? "";
    const label = url.searchParams.get("label")?.trim() ?? "";
    try {
      return html(await buildIssueList(owner, repo, state, cfg.writesEnabled, q, label));
    } catch (e) {
      return html(errorPage("加载失败", errMsg(e)), e instanceof StoreError ? e.status : 500);
    }
  }

  const whPage = url.pathname.match(REPO_WEBHOOKS_RE);
  if (whPage) {
    const [, owner, repo] = whPage;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    const project = await getProject(owner, repo);
    if (!project) return html(errorPage("项目不存在", "项目未创建"), 404);
    const isAdmin = await canAdminProject(project.id, ctx.user);
    if (!isAdmin) return html(errorPage("无权限", "需要该项目 admin 角色才能管理 webhook"), 403);
    const hooks = await listWebhooks(project.id);
    const deliveriesByWebhook = new Map(
      await Promise.all(hooks.map(async (h) => [h.id, await listDeliveries(h.id, 10)] as const))
    );
    return html(
      buildWebhooksPage({ project, webhooks: hooks, deliveriesByWebhook })
    );
  }

  const membersPage = url.pathname.match(REPO_MEMBERS_RE);
  if (membersPage) {
    const [, owner, repo] = membersPage;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    const project = await getProject(owner, repo);
    if (!project) return html(errorPage("项目不存在", "项目未创建"), 404);
    // Lazy bootstrap: site-admin opening a pre-RBAC project auto-inserts as admin.
    if (ctx.user!.is_admin === 1) await ensureProjectBootstrapAdmin(project.id, ctx.user!.login);
    if (!(await canAdminProject(project.id, ctx.user))) {
      return html(errorPage("无权限", "需要该项目 admin 角色才能管理成员"), 403);
    }
    const flashKind = url.searchParams.get("ok") === "1" ? "ok" : url.searchParams.get("err") ? "err" : null;
    const flashMsg = flashKind === "ok" ? (url.searchParams.get("ok_msg") ?? "") : (url.searchParams.get("err") ?? "");
    const flash = flashKind ? { kind: flashKind as "ok" | "err", msg: flashMsg } : null;
    return html(await buildProjectMembersPage(ctx.user!, project, flash));
  }

  const upstreamsPage = url.pathname.match(REPO_UPSTREAMS_RE);
  if (upstreamsPage) {
    const [, owner, repo] = upstreamsPage;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    const project = await getProject(owner, repo);
    if (!project) return html(errorPage("项目不存在", "项目未创建"), 404);
    if (!(await canAdminProject(project.id, ctx.user))) {
      return html(errorPage("无权限", "需要该项目 admin 角色才能管理上游"), 403);
    }
    const flashKind = url.searchParams.get("ok") === "1" ? "ok" : url.searchParams.get("err") ? "err" : null;
    const flashMsg = flashKind === "ok" ? (url.searchParams.get("ok_msg") ?? "") : (url.searchParams.get("err") ?? "");
    const flash = flashKind ? { kind: flashKind as "ok" | "err", msg: flashMsg } : null;
    return html(buildProjectUpstreamsPage(ctx.user!, project, flash));
  }

  const labelsPage = url.pathname.match(REPO_LABELS_RE);
  if (labelsPage) {
    const [, owner, repo] = labelsPage;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    const project = await getProject(owner, repo);
    if (!project) return html(errorPage("项目不存在", "项目未创建"), 404);
    if (ctx.user!.is_admin === 1) await ensureProjectBootstrapAdmin(project.id, ctx.user!.login);
    if (!(await canAdminProject(project.id, ctx.user))) {
      return html(errorPage("无权限", "需要该项目 admin 角色才能管理标签"), 403);
    }
    const flashKind = url.searchParams.get("ok") === "1" ? "ok" : url.searchParams.get("err") ? "err" : null;
    const flashMsg = flashKind === "ok" ? (url.searchParams.get("ok_msg") ?? "") : (url.searchParams.get("err") ?? "");
    const flash = flashKind ? { kind: flashKind as "ok" | "err", msg: flashMsg } : null;
    return html(await buildProjectLabelsPage(ctx.user!, project, flash));
  }

  const modelPage = url.pathname.match(REPO_MODEL_RE);
  if (modelPage) {
    const [, owner, repo] = modelPage;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    const project = await getProject(owner, repo);
    if (!project) return html(errorPage("项目不存在", "项目未创建"), 404);
    if (!(await canAdminProject(project.id, ctx.user))) {
      return html(errorPage("无权限", "需要该项目 admin 角色才能管理模型"), 403);
    }
    const flashKind = url.searchParams.get("ok") === "1" ? "ok" : url.searchParams.get("err") ? "err" : null;
    const flashMsg = flashKind === "ok" ? (url.searchParams.get("ok_msg") ?? "") : (url.searchParams.get("err") ?? "");
    const flash = flashKind ? { kind: flashKind as "ok" | "err", msg: flashMsg } : null;
    return html(buildProjectModelPage(project, cfg.defaultModel, await listCachedModels(), flash).html);
  }

  const repoMatch = url.pathname.match(REPO_RE);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    if (!(owner && repo)) return html(errorPage("404", "bad path"), 404);
    return Response.redirect(
      `${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      302
    );
  }

  return html(errorPage("404", `未知路径: ${url.pathname}`), 404);
}

function parseState(s: string | null): "open" | "closed" | "all" {
  return s === "closed" ? "closed" : s === "all" ? "all" : "open";
}

async function createProjectSafe(owner: string, name: string) {
  let project = await getProject(owner, name);
  if (project) return project;
  project = await createProject(owner, name, "", cfg.defaultModel);
  return project;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// Boot-time: ensure the configured operator user exists. If it's a fresh DB
// with no admins, promote it. Covers both fresh installs and the legacy-token
// migration path (legacy cookies resolve to this user).
// Also ensure the reserved system user exists (kind=system, used to attribute
// automated actions like future cron / import jobs; not login-able).
await (async () => {
  const op = await ensureBootstrapAdmin(cfg.operatorLogin);
  if (op.is_admin === 0 && (await countAdmins()) === 0) {
    await updateUser(op.login, { is_admin: true });
    log.info("bootstrap: operator promoted to admin", { login: op.login });
  }
  const sys = await ensureBootstrapSystem(cfg.systemLogin);
  void sys;
})();

log.info("ework listening", { host: cfg.host, port: cfg.port, writes: cfg.writesEnabled, operator: cfg.operatorLogin });

export {};
