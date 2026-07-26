// Gitea-compatible webhook emitter.
//
// Emits `issues` (opened/closed/reopened) and `issue_comment` (created) events
// to project-scoped webhook URLs. Payload shape + headers mirror Gitea so that
// downstream consumers written against Gitea work
// unchanged. See:
//   - Gitea docs:   https://docs.gitea.com/development/webhooks
//
// Design notes:
// - HMAC-SHA256 signature is computed over the exact bytes we POST (rawBody),
//   hex-encoded lowercase, matching Gitea's `X-Gitea-Signature`.
// - GitHub-compat alias `X-GitHub-Signature-256: sha256=<hex>` is included too.
// - Delivery is fire-and-forget: callers `void emitX(...)` and the HTTP response
//   is not blocked. Failures are retried with exponential backoff, then recorded.
// - One DB row per delivery ATTEMPT (retries append), so the delivery log shows
//   the full retry trail rather than an opaque final status.

import { createHmac, randomUUID } from "node:crypto";
import { getDB } from "./db";
import { log } from "./logger";
import { loadConfig } from "./config";
import {
  StoreError,
  getIssueById,
  getProjectById,
  getDefaultUpstreamUrl,
  ensureUser,
  resolveModel,
  type IssueRow,
  type ProjectRow,
  type CommentRow,
} from "./store";

export type WebhookEventName = "issues" | "issue_comment";
export type IssueAction = "opened" | "closed" | "reopened";

export interface WebhookRow {
  id: number;
  project_id: number;
  url: string;
  secret: string;
  content_type: string;
  events: string; // JSON array, e.g. '["issues","issue_comment"]'
  active: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryRow {
  id: number;
  webhook_id: number;
  event: WebhookEventName | string;
  delivery_uuid: string;
  payload: string;
  response_status: number | null;
  response_body: string | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

const DEFAULT_EVENTS: WebhookEventName[] = ["issues", "issue_comment"];
const MAX_RESPONSE_LOG_BYTES = 8192;
const HTTP_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [0, 2_000, 8_000];

// Global cap on concurrent in-flight webhook HTTP deliveries. Without this, a
// flood of events against dead targets (e.g. daemon down during migration)
// kicks off unbounded concurrent fetches — each waits HTTP_TIMEOUT_MS, so the
// Bun event loop saturates and ework-web stops serving user traffic. The cap
// queues surplus deliveries; releaseSlot() drains the queue FIFO.
const MAX_CONCURRENT_DELIVERIES = clampPositiveInt(
  Number(process.env.WORK_WEBHOOK_MAX_CONCURRENT ?? "6"),
  1,
  64,
  6
);
let inFlightDeliveries = 0;
const deliveryQueue: Array<() => void> = [];

function clampPositiveInt(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v) || v < lo || v > hi) return fallback;
  return Math.floor(v);
}

function acquireDeliverySlot(): Promise<void> {
  if (inFlightDeliveries < MAX_CONCURRENT_DELIVERIES) {
    inFlightDeliveries++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    deliveryQueue.push(() => {
      inFlightDeliveries++;
      resolve();
    });
  });
}

function releaseDeliverySlot(): void {
  inFlightDeliveries--;
  const next = deliveryQueue.shift();
  if (next) next();
}

function now(): string {
  return new Date().toISOString();
}

function parseEvents(events: unknown): WebhookEventName[] {
  if (typeof events !== "string") return DEFAULT_EVENTS;
  try {
    const arr = JSON.parse(events) as unknown[];
    const valid = arr.filter(
      (v): v is WebhookEventName => v === "issues" || v === "issue_comment"
    );
    return valid.length > 0 ? valid : DEFAULT_EVENTS;
  } catch {
    return DEFAULT_EVENTS;
  }
}

// ─── CRUD ────────────────────────────────────────────────────

export async function listWebhooks(projectId: number): Promise<WebhookRow[]> {
  return await getDB().all<WebhookRow>("SELECT * FROM {{webhooks}} WHERE project_id = ? ORDER BY id", [projectId]);
}

export async function getWebhook(id: number): Promise<WebhookRow | null> {
  const row = await getDB().get<WebhookRow>("SELECT * FROM {{webhooks}} WHERE id = ?", [id]);
  return row ?? null;
}

export interface CreateWebhookInput {
  project_id: number;
  url: string;
  secret?: string;
  events?: WebhookEventName[];
  active?: boolean;
}

export async function createWebhook(input: CreateWebhookInput): Promise<WebhookRow> {
  const url = input.url.trim();
  if (!url) throw new StoreError(400, "URL 不能为空");
  if (!/^https?:\/\//i.test(url)) throw new StoreError(400, "URL 必须是 http(s)://");
  if (url.length > 2048) throw new StoreError(400, "URL 过长");
  const secret = (input.secret ?? "").slice(0, 256);
  const events = input.events && input.events.length > 0 ? input.events : DEFAULT_EVENTS;
  const ts = now();
  const info = await getDB().run(
    `INSERT INTO {{webhooks}} (project_id, url, secret, content_type, events, active, created_at, updated_at)
     VALUES (?, ?, ?, 'application/json', ?, ?, ?, ?)`,
    [
      input.project_id,
      url,
      secret,
      JSON.stringify(events),
      input.active === false ? 0 : 1,
      ts,
      ts
    ]
  );
  return (await getWebhook(info.insertId))!;
}

export async function deleteWebhook(id: number): Promise<void> {
  await getDB().run("DELETE FROM {{webhooks}} WHERE id = ?", [id]);
}

export async function setWebhookActive(id: number, active: boolean): Promise<void> {
  await getDB().run("UPDATE {{webhooks}} SET active = ?, updated_at = ? WHERE id = ?", [active ? 1 : 0, now(), id]);
}

export async function listDeliveries(webhookId: number, limit = 50): Promise<WebhookDeliveryRow[]> {
  return await getDB().all<WebhookDeliveryRow>(
    "SELECT * FROM {{webhook_deliveries}} WHERE webhook_id = ? ORDER BY id DESC LIMIT ?",
    [webhookId, limit]
  );
}

export interface DeliveryWithWebhookRow extends WebhookDeliveryRow {
  webhook_url: string;
  project_owner: string;
  project_name: string;
}

export async function listAllRecentDeliveries(limit = 100): Promise<DeliveryWithWebhookRow[]> {
  return await getDB().all<DeliveryWithWebhookRow>(
    `SELECT d.*, w.url AS webhook_url, p.owner AS project_owner, p.name AS project_name
     FROM {{webhook_deliveries}} d
     LEFT JOIN {{webhooks}} w ON w.id = d.webhook_id
     LEFT JOIN {{projects}} p ON p.id = w.project_id
     ORDER BY d.id DESC LIMIT ?`,
    [limit]
  );
}

// ─── Payload builders (Gitea-compatible shape) ───────────────
//
// We populate the fields downstream consumers actually read (see Gitea's
// GiteaTracker.parseWebhookEvent): action, issue.{number,title,body,state,
// user.login,html_url}, comment.{id,body,user.login}, repository.{name,
// owner.login,full_name}, sender.login. We also include the rest of the
// standard Gitea fields (created_at, comments count, id, etc.) populated from
// ework's data so payload-completeness checkers / other Gitea clients work too.

interface PayloadUser {
  id: number;
  login: string;
  login_name: string;
  full_name: string;
  email: string;
  avatar_url: string;
  html_url: string;
  is_admin: boolean;
  language: string;
}

interface PayloadLabel {
  id: number;
  name: string;
  color: string;
  description: string;
}

interface PayloadRepository {
  id: number;
  owner: PayloadUser;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  fork: boolean;
  parent: null;
  empty: boolean;
  mirror: boolean;
  size: number;
  html_url: string;
  ssh_url: string;
  clone_url: string;
  website: string;
  stars_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  default_branch: string;
  created_at: string;
  updated_at: string;
  // Non-Gitea extension. ework-daemon reads this to decide whether to push
  // `--model <X>` on opencode spawn. Empty string = no override (let opencode
  // pick). Gitea-strict consumers ignore unknown fields per JSON POST rules.
  ework_model?: string;
}

interface PayloadIssue {
  id: number;
  url: string;
  html_url: string;
  number: number;
  title: string;
  body: string;
  labels: PayloadLabel[];
  milestone: null;
  assignee: null;
  assignees: null;
  state: "open" | "closed";
  is_locked: boolean;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  due_date: null;
  pull_request: null;
  repository: PayloadRepository;
  user: PayloadUser;
}

interface PayloadComment {
  id: number;
  html_url: string;
  pull_request_url: string;
  issue_url: string;
  body: string;
  created_at: string;
  updated_at: string;
  user: PayloadUser;
}

interface IssueEventPayload {
  action: IssueAction;
  issue: PayloadIssue;
  repository: PayloadRepository;
  sender: PayloadUser;
  commit_id?: string;
  commit_url?: string;
  url?: string;
}

interface CommentEventPayload {
  action: "created";
  issue: PayloadIssue;
  comment: PayloadComment;
  repository: PayloadRepository;
  sender: PayloadUser;
}

function buildUser(login: string, origin: string): PayloadUser {
  return {
    id: 1,
    login,
    login_name: "",
    full_name: login,
    email: `${login}@${new URL(origin).host ?? "localhost"}.noreply.ework`,
    avatar_url: `${origin}/static/favicon.svg`,
    html_url: origin,
    is_admin: false,
    language: "",
  };
}

function buildRepository(project: ProjectRow, origin: string, model?: string): PayloadRepository {
  const fullName = `${project.owner}/${project.name}`;
  const htmlUrl = `${origin}/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}`;
  // clone_url must be a real Git remote (ework-web is NOT a Git server). Use the
  // project's default upstream URL when bound; fall back to the synthetic htmlUrl
  // + .git for purely tracker-only projects (recipients that don't attempt git
  // clone will still see a syntactically valid URL).
  const upstream = getDefaultUpstreamUrl(project);
  const repo: PayloadRepository = {
    id: project.id,
    owner: buildUser(project.owner, origin),
    name: project.name,
    full_name: fullName,
    description: project.description ?? "",
    private: false,
    fork: false,
    parent: null,
    empty: false,
    mirror: false,
    size: 0,
    html_url: htmlUrl,
    ssh_url: "",
    clone_url: upstream ?? `${htmlUrl}.git`,
    website: "",
    stars_count: 0,
    forks_count: 0,
    watchers_count: 1,
    open_issues_count: 0,
    default_branch: "main",
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
  // Only attach ework_model when non-empty (keeps payload compact + lets
  // Gitea-strict consumers ignore the field entirely on no-op cases).
  if (model) repo.ework_model = model;
  return repo;
}

function buildIssue(
  issue: IssueRow,
  project: ProjectRow,
  commentCount: number,
  origin: string,
  model?: string,
): PayloadIssue {
  const repoUrl = `${origin}/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}`;
  const issueUrl = `${repoUrl}/issues/${issue.number}`;
  return {
    id: issue.id,
    url: `${origin}/api/v1/repos/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/issues/${issue.number}`,
    html_url: issueUrl,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    labels: [],
    milestone: null,
    assignee: null,
    assignees: null,
    state: issue.state,
    is_locked: false,
    comments: commentCount,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    due_date: null,
    pull_request: null,
    repository: buildRepository(project, origin, model),
    user: buildUser(issue.author, origin),
  };
}

function buildComment(
  issue: IssueRow,
  comment: CommentRow,
  project: ProjectRow,
  origin: string
): PayloadComment {
  const repoUrl = `${origin}/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}`;
  const issueUrl = `${repoUrl}/issues/${issue.number}`;
  return {
    id: comment.id,
    html_url: `${issueUrl}#issuecomment-${comment.id}`,
    pull_request_url: "",
    issue_url: issueUrl,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: buildUser(comment.author, origin),
  };
}

function buildCommentPayload(
  issue: IssueRow,
  comment: CommentRow,
  project: ProjectRow,
  commentCount: number,
  origin: string,
  model?: string,
): CommentEventPayload {
  return {
    action: "created",
    issue: buildIssue(issue, project, commentCount, origin, model),
    comment: buildComment(issue, comment, project, origin),
    repository: buildRepository(project, origin, model),
    sender: buildUser(comment.author, origin),
  };
}

function buildIssuePayload(
  issue: IssueRow,
  project: ProjectRow,
  commentCount: number,
  action: IssueAction,
  origin: string,
  model?: string,
): IssueEventPayload {
  return {
    action,
    issue: buildIssue(issue, project, commentCount, origin, model),
    repository: buildRepository(project, origin, model),
    sender: buildUser(issue.author, origin),
  };
}

// ─── Delivery ────────────────────────────────────────────────

function signBody(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function buildHeaders(
  event: WebhookEventName,
  deliveryUuid: string,
  rawBody: string,
  secret: string
): Record<string, string> {
  const sig = signBody(secret, rawBody);
  return {
    "Content-Type": "application/json",
    "User-Agent": "eworkServer/0.1",
    "X-Gitea-Delivery": deliveryUuid,
    "X-Gitea-Event": event,
    "X-Gitea-Signature": sig,
    "X-Gitea-Event-Type": event,
    "X-Gogs-Event": event,
    "X-Gogs-Delivery": deliveryUuid,
    "X-Gogs-Signature": sig,
    "X-GitHub-Delivery": deliveryUuid,
    "X-GitHub-Event": event,
    "X-GitHub-Signature-256": `sha256=${sig}`,
  };
}

interface DeliveryAttemptResult {
  status: number | null;
  body: string | null;
  durationMs: number;
  error: string | null;
}

async function postWithTimeout(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<DeliveryAttemptResult> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
      redirect: "manual",
    });
    const text = await res.text().catch(() => "");
    return {
      status: res.status,
      body: text.slice(0, MAX_RESPONSE_LOG_BYTES) || null,
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (e) {
    return {
      status: null,
      body: null,
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function recordDelivery(
  webhookId: number,
  event: WebhookEventName,
  deliveryUuid: string,
  rawBody: string,
  result: DeliveryAttemptResult
): Promise<void> {
  try {
    await getDB().run(
      `INSERT INTO {{webhook_deliveries}}
        (webhook_id, event, delivery_uuid, payload, response_status, response_body, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        webhookId,
        event,
        deliveryUuid,
        rawBody,
        result.status,
        result.body,
        result.durationMs,
        result.error,
        now()
      ]
    );
  } catch (e) {
    log.error("webhook: failed to record delivery", { err: e as Error });
  }
}

async function deliver(
  webhook: WebhookRow,
  event: WebhookEventName,
  rawBody: string
): Promise<void> {
  await acquireDeliverySlot();
  try {
    for (const attempt of RETRY_DELAYS_MS) {
      if (attempt > 0) await Bun.sleep(attempt);
      const deliveryUuid = randomUUID();
      const headers = buildHeaders(event, deliveryUuid, rawBody, webhook.secret);
      const result = await postWithTimeout(webhook.url, rawBody, headers);
      const success = result.status !== null && result.status >= 200 && result.status < 300;
      await recordDelivery(webhook.id, event, deliveryUuid, rawBody, result);
      if (success) return;
      // 410 Gone: receiver explicitly says "stop sending" — honor it, no retry.
      if (result.status === 410) return;
    }
    log.warn("webhook: gave up after retries", {
      attempts: RETRY_DELAYS_MS.length,
      webhookId: webhook.id,
      url: webhook.url,
      event,
    });
  } finally {
    releaseDeliverySlot();
  }
}

async function fanOut(
  projectId: number,
  event: WebhookEventName,
  rawBody: string
): Promise<void> {
  const webhooks = await getDB().all<WebhookRow>(
    "SELECT * FROM {{webhooks}} WHERE project_id = ? AND active = 1",
    [projectId]
  );
  for (const wh of webhooks) {
    if (!parseEvents(wh.events).includes(event)) continue;
    void deliver(wh, event, rawBody);
  }
}

// ─── Public emit API ─────────────────────────────────────────

export async function emitIssueEvent(
  projectId: number,
  issueId: number,
  action: IssueAction,
  origin: string
): Promise<void> {
  try {
    const project = await getProjectById(projectId);
    if (!project) return;
    const issue = await getIssueById(issueId);
    if (!issue) return;
    const commentCount = await countCommentsSafe(issueId);
    // Resolve model: project override > global default. Empty string = no
    // override (daemon omits --model, lets opencode pick). globalDefault
    // comes from the config table via loadConfig() — cheap DB read.
    const globalDefault = (await loadConfig()).defaultModel;
    const model = resolveModel(project.model, globalDefault);
    const payload = buildIssuePayload(issue, project, commentCount, action, origin, model);
    const rawBody = JSON.stringify(payload);
    await fanOut(projectId, "issues", rawBody);
  } catch (e) {
    log.error("webhook: emitIssueEvent failed", {
      err: e as Error,
      projectId,
      issueId,
      action,
    });
  }
}

export async function emitCommentEvent(
  projectId: number,
  issueId: number,
  commentId: number,
  origin: string
): Promise<void> {
  try {
    const project = await getProjectById(projectId);
    if (!project) return;
    const issue = await getIssueById(issueId);
    if (!issue) return;
    const comment = await getCommentByIdSafe(commentId);
    if (!comment) return;
    const commentCount = await countCommentsSafe(issueId);
    const globalDefault = (await loadConfig()).defaultModel;
    const model = resolveModel(project.model, globalDefault);
    const payload = buildCommentPayload(issue, comment, project, commentCount, origin, model);
    const rawBody = JSON.stringify(payload);
    await fanOut(projectId, "issue_comment", rawBody);
  } catch (e) {
    log.error("webhook: emitCommentEvent failed", {
      err: e as Error,
      projectId,
      issueId,
      commentId,
    });
  }
}

export async function emitPingEvent(projectId: number, origin: string): Promise<void> {
  // Synthetic ping: send a small `ping` event (no issue context). Useful for
  // verifying webhook configuration without triggering a real write.
  try {
    const project = await getProjectById(projectId);
    if (!project) return;
    const payload = {
      zen: "smoke",
      hook_id: 0,
      hook: { type: "Gitea", id: 0, active: true, events: parseEvents(undefined) },
      repository: buildRepository(project, origin),
      sender: buildUser(project.owner, origin),
    };
    const rawBody = JSON.stringify(payload);
    await fanOut(projectId, "issues", rawBody);
  } catch (e) {
    log.error("webhook: emitPingEvent failed", { err: e as Error, projectId });
  }
}

// ─── Helpers (kept here to avoid widening store.ts surface) ──

async function countCommentsSafe(issueId: number): Promise<number> {
  try {
    const row = await getDB().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM {{comments}} WHERE issue_id = ?",
      [issueId]
    );
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

async function getCommentByIdSafe(id: number): Promise<CommentRow | null> {
  try {
    const row = await getDB().get<CommentRow>("SELECT * FROM {{comments}} WHERE id = ?", [id]);
    return row ?? null;
  } catch {
    return null;
  }
}

// Re-exported so callers don't need to import ensureUser separately for tests.
export const _internal = { ensureUser, buildHeaders, signBody, parseEvents };

// Payload builders shared with giteaApi.ts (REST shim). The shim must return
// the exact same shape as the webhook payloads so consumers (daemon, plugins)
// see one consistent Gitea-compatible contract regardless of whether they
// pull via webhook push or REST poll.
export {
  buildUser,
  buildRepository,
  buildIssue as buildIssuePayload,
  buildComment as buildCommentPayload,
};
