// SQLite-backed data layer for ework. Single DB (see db.ts) holds projects +
// issues + comments + labels + reactions + attachments + users. All write ops
// run in transactions; per-project issue numbers are allocated atomically.

import { getDB } from "./db";
import { createHash } from "node:crypto";

let _visibilityChecked = false;
let _hasVisibilityColumn = true;

async function visibilitySupported(): Promise<boolean> {
  if (_visibilityChecked) return _hasVisibilityColumn;
  _visibilityChecked = true;
  try {
    await getDB().get("SELECT visibility FROM {{projects}} LIMIT 0");
    _hasVisibilityColumn = true;
  } catch {
    _hasVisibilityColumn = false;
    console.warn("[store] projects.visibility column missing — treating all projects as public");
  }
  return _hasVisibilityColumn;
}

export type UserKind = "human" | "bot" | "system";

export interface UserRow {
  login: string;
  kind: UserKind;
  display_name: string | null;
  password_hash: string | null;
  email: string | null;
  is_admin: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CreateUserInput {
  login: string;
  password: string;
  kind?: UserKind;
  email?: string;
  display_name?: string;
  is_admin?: boolean;
  is_active?: boolean;
}

export interface ProjectRow {
  id: number;
  owner: string;
  name: string;
  description: string;
  upstream_urls: string;
  model: string;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export interface CachedModel {
  id: string;
  label: string;
}

export interface IssueRow {
  id: number;
  project_id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  ai_status: string;
  model: string;
  runtime: string;
}

export interface IssueWithMeta extends IssueRow {
  project_owner: string;
  project_name: string;
  comment_count: number;
}

export interface CommentRow {
  id: number;
  issue_id: number;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
  author_kind?: UserKind;
  author_display_name?: string | null;
  model?: string;
}

export interface LabelRow {
  id: number;
  project_id: number;
  name: string;
  color: string;
  description: string;
  exclusive: number;
  is_archived: number;
}

/** For an exclusive label named "scope/name", the scope is "scope". A label
 *  with no "/" has no scope and is never exclusive. Issues may carry at most
 *  one label per scope (Gitea semantics). */
export function labelScope(name: string): string {
  const i = name.indexOf("/");
  return i > 0 ? name.slice(0, i) : "";
}

export interface AttachmentRow {
  uuid: string;
  issue_id: number;
  filename: string;
  content_type: string;
  size: number;
  blob_path: string;
  uploaded_by: string;
  created_at: string;
}

export class StoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "StoreError";
  }
}

function now(): string {
  return new Date().toISOString();
}

export async function ensureUser(login: string, kind: UserKind = "human", displayName?: string | null): Promise<UserRow> {
  const db = getDB();
  const existing = await db.get<UserRow>("SELECT * FROM {{users}} WHERE login = ?", [login]);
  if (existing) {
    if (displayName && displayName.trim() && existing.display_name !== displayName) {
      await db.run("UPDATE {{users}} SET display_name = ?, updated_at = ? WHERE login = ?", [displayName, now(), login]);
    }
    return existing;
  }
  const ts = now();
  await db.run(
    "INSERT INTO {{users}} (login, kind, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [login, kind, displayName ?? null, ts, ts]
  );
  return {
    login,
    kind,
    display_name: displayName ?? null,
    password_hash: null,
    email: null,
    is_admin: 0,
    is_active: 1,
    created_at: ts,
    updated_at: ts,
  };
}

export async function provisionUser(
  login: string,
  opts: { kind?: UserKind; isAdmin?: boolean },
): Promise<UserRow> {
  const user = await ensureUser(login, opts.kind ?? "human");
  if (opts.isAdmin && !user.is_admin) {
    const db = getDB();
    await db.run("UPDATE {{users}} SET is_admin = 1, updated_at = ? WHERE login = ?", [
      now(),
      login,
    ]);
    return { ...user, is_admin: 1 };
  }
  return user;
}

export async function getProject(owner: string, name: string): Promise<ProjectRow | null> {
  return (await getDB().get<ProjectRow>("SELECT * FROM {{projects}} WHERE owner = ? AND name = ?", [owner, name])) ?? null;
}

export async function getProjectById(id: number): Promise<ProjectRow | null> {
  return (await getDB().get<ProjectRow>("SELECT * FROM {{projects}} WHERE id = ?", [id])) ?? null;
}

export async function getProjectByIssueId(issueId: number): Promise<ProjectRow | null> {
  const row = await getDB().get<ProjectRow>(
    "SELECT p.* FROM {{projects}} p JOIN {{issues}} i ON i.project_id = p.id WHERE i.id = ?",
    [issueId]
  );
  return row ?? null;
}

export interface ProjectWithCounts extends ProjectRow {
  open_count: number;
  total_count: number;
}

export async function listProjectsWithCounts(
  viewer?: { login: string; is_admin: number } | null,
): Promise<ProjectWithCounts[]> {
  const isAdmin = viewer?.is_admin === 1;
  const login = viewer?.login;
  const hasVis = isAdmin ? true : await visibilitySupported();
  const visibilityFilter = !hasVis
    ? ""
    : isAdmin
      ? ""
      : login
        ? ` AND (p.visibility != 'private' OR EXISTS (SELECT 1 FROM {{project_members}} pm WHERE pm.project_id = p.id AND pm.user_login = ?))`
        : ` AND p.visibility != 'private'`;
  const args = hasVis && !isAdmin && login ? [login] : [];
  return await getDB().all<ProjectWithCounts>(
    `SELECT p.*,
       COALESCE(SUM(CASE WHEN i.state = 'open' THEN 1 ELSE 0 END), 0) AS open_count,
       COUNT(i.id) AS total_count
     FROM {{projects}} p
     LEFT JOIN {{issues}} i ON i.project_id = p.id
     WHERE 1=1${visibilityFilter}
     GROUP BY p.id
     ORDER BY p.updated_at DESC`,
    args,
  );
}

export async function listAllProjectIds(): Promise<number[]> {
  const rows = await getDB().all<{ id: number }>("SELECT id FROM {{projects}} ORDER BY id");
  return rows.map((r) => r.id);
}

export async function createProject(owner: string, name: string, description: string, model?: string): Promise<ProjectRow> {
  owner = owner.trim();
  name = name.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(owner)) throw new StoreError(400, "owner 含非法字符");
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new StoreError(400, "name 含非法字符");
  if (await getProject(owner, name)) throw new StoreError(409, `项目 ${owner}/${name} 已存在`);
  const ts = now();
  const db = getDB();
  const info = await db.run(
    "INSERT INTO {{projects}} (owner, name, description, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [owner, name, description ?? "", model ?? "", ts, ts]
  );
  return (await getProjectById(info.insertId))!;
}

export async function touchProject(projectId: number): Promise<void> {
  await getDB().run("UPDATE {{projects}} SET updated_at = ? WHERE id = ?", [now(), projectId]);
}

export async function updateProjectVisibility(projectId: number, visibility: "public" | "private"): Promise<void> {
  await getDB().run("UPDATE {{projects}} SET visibility = ?, updated_at = ? WHERE id = ?", [visibility, now(), projectId]);
}

const MAX_UPSTREAM_URLS = 10;
const UPSTREAM_URL_RE = /^(https?|ssh|git):\/\/[^\s]+$/i;
const GIT_SCP_RE = /^[A-Za-z0-9_./-]+@[A-Za-z0-9._-]+:.+$/;

export function getProjectUpstreamUrls(project: Pick<ProjectRow, "upstream_urls">): string[] {
  try {
    const arr = JSON.parse(project.upstream_urls) as unknown[];
    return arr.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
}

export function getDefaultUpstreamUrl(project: Pick<ProjectRow, "upstream_urls">): string | null {
  const urls = getProjectUpstreamUrls(project);
  return urls.length > 0 ? urls[0]! : null;
}

export async function setProjectUpstreamUrls(projectId: number, urls: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of urls) {
    const u = String(raw ?? "").trim();
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    if (u.length > 2048) throw new StoreError(400, "上游 URL 过长（≤2048）");
    if (!UPSTREAM_URL_RE.test(u) && !GIT_SCP_RE.test(u)) {
      throw new StoreError(400, `上游 URL 协议非法（须 http(s)/ssh/git 或 git@host:path）: ${u}`);
    }
    cleaned.push(u);
  }
  if (cleaned.length > MAX_UPSTREAM_URLS) {
    throw new StoreError(400, `上游 URL 数量超过上限（${MAX_UPSTREAM_URLS}）`);
  }
  const ts = now();
  await getDB().run(
    "UPDATE {{projects}} SET upstream_urls = ?, updated_at = ? WHERE id = ?",
    [JSON.stringify(cleaned), ts, projectId]
  );
  return cleaned;
}

// `provider/model` shape (alphanumeric + ._-. on both sides of the slash).
// Same regex as OpencodeClient.listModels — keep in sync.
const MODEL_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export async function setProjectModel(projectId: number, model: string): Promise<string> {
  const trimmed = String(model ?? "").trim();
  if (trimmed && !MODEL_RE.test(trimmed)) {
    throw new StoreError(400, `模型格式非法（须 provider/model）: ${trimmed}`);
  }
  await getDB().run(
    "UPDATE {{projects}} SET model = ?, updated_at = ? WHERE id = ?",
    [trimmed, now(), projectId]
  );
  return trimmed;
}

// Resolve the effective model for a project: project override > global
// default. Returns "" when neither is set (caller omits --model and lets
// opencode pick per its own config).
export function resolveModel(projectModel: string, globalDefault: string, issueModel?: string): string {
  const i = String(issueModel ?? "").trim();
  if (i) return i;
  const p = String(projectModel ?? "").trim();
  if (p) return p;
  return String(globalDefault ?? "").trim();
}

export async function listCachedModels(): Promise<CachedModel[]> {
  const rows = await getDB().all<CachedModel>("SELECT provider_model AS id, label FROM {{model_cache}} ORDER BY id");
  return rows;
}

export async function replaceCachedModels(ids: string[]): Promise<void> {
  const db = getDB();
  const ts = now();
  // Dedupe to avoid UNIQUE constraint violations — caller may pass raw
  // output from `opencode models` which could (theoretically) repeat.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  await db.transaction(async () => {
    await db.exec("DELETE FROM {{model_cache}}");
    for (const id of unique) {
      await db.run("INSERT INTO {{model_cache}} (provider_model, label, refreshed_at) VALUES (?, ?, ?)", [id, id, ts]);
    }
  });
}

export async function getIssue(projectId: number, number: number): Promise<IssueRow | null> {
  return (
    (await getDB().get<IssueRow>("SELECT * FROM {{issues}} WHERE project_id = ? AND number = ?", [projectId, number])) ?? null
  );
}

export async function getIssueById(id: number): Promise<IssueRow | null> {
  return (await getDB().get<IssueRow>("SELECT * FROM {{issues}} WHERE id = ?", [id])) ?? null;
}

export async function getIssueWithMeta(projectId: number, number: number): Promise<IssueWithMeta | null> {
  return (
    (await getDB().get<IssueWithMeta>(
      `SELECT i.*, p.owner AS project_owner, p.name AS project_name,
              (SELECT COUNT(*) FROM {{comments}} c WHERE c.issue_id = i.id) AS comment_count
       FROM {{issues}} i JOIN {{projects}} p ON p.id = i.project_id
       WHERE i.project_id = ? AND i.number = ?`,
      [projectId, number]
    )) ?? null
  );
}

export interface ListIssuesOpts {
  state?: "open" | "closed" | "all";
  q?: string;
  label?: string;
  limit?: number;
  viewerLogin?: string;
  viewerIsAdmin?: boolean;
}

export async function listIssues(projectId: number, opts: ListIssuesOpts = {}): Promise<IssueWithMeta[]> {
  const state = opts.state ?? "open";
  const q = (opts.q ?? "").trim();
  const limit = Math.min(opts.limit ?? 50, 200);
  let sql = `SELECT i.*, p.owner AS project_owner, p.name AS project_name,
              (SELECT COUNT(*) FROM {{comments}} c WHERE c.issue_id = i.id) AS comment_count
            FROM {{issues}} i JOIN {{projects}} p ON p.id = i.project_id
            WHERE i.project_id = ?`;
  const args: (string | number)[] = [projectId];
  if (state !== "all") {
    sql += " AND i.state = ?";
    args.push(state);
  }
  if (q) {
    sql += " AND (i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\')";
    const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    args.push(like, like);
  }
  const label = (opts.label ?? "").trim();
  if (label) {
    sql += " AND EXISTS (SELECT 1 FROM {{issue_labels}} il JOIN {{labels}} l ON l.id = il.label_id WHERE il.issue_id = i.id AND l.name = ?)";
    args.push(label);
  }
  sql += " ORDER BY i.updated_at DESC LIMIT ?";
  args.push(limit);
  return await getDB().all<IssueWithMeta>(sql, args);
}

export async function listAllIssues(opts: ListIssuesOpts = {}): Promise<IssueWithMeta[]> {
  const state = opts.state ?? "open";
  const q = (opts.q ?? "").trim();
  const limit = Math.min(opts.limit ?? 50, 200);
  let sql = `SELECT i.*, p.owner AS project_owner, p.name AS project_name,
              (SELECT COUNT(*) FROM {{comments}} c WHERE c.issue_id = i.id) AS comment_count
            FROM {{issues}} i JOIN {{projects}} p ON p.id = i.project_id
            WHERE 1=1`;
  const args: (string | number)[] = [];
  if (state !== "all") {
    sql += " AND i.state = ?";
    args.push(state);
  }
  if (q) {
    sql += " AND (i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\' OR p.owner LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')";
    const like = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
    args.push(like, like, like, like);
  }
  const label = (opts.label ?? "").trim();
  if (label) {
    sql += " AND EXISTS (SELECT 1 FROM {{issue_labels}} il JOIN {{labels}} l ON l.id = il.label_id WHERE il.issue_id = i.id AND l.name = ?)";
    args.push(label);
  }
  if (!opts.viewerIsAdmin && await visibilitySupported()) {
    sql += " AND (p.visibility != 'private'";
    if (opts.viewerLogin) {
      sql += " OR EXISTS (SELECT 1 FROM {{project_members}} pm WHERE pm.project_id = p.id AND pm.user_login = ?)";
      args.push(opts.viewerLogin);
    }
    sql += ")";
  }
  sql += " ORDER BY i.updated_at DESC LIMIT ?";
  args.push(limit);
  return await getDB().all<IssueWithMeta>(sql, args);
}

export interface CreateIssueOpts {
  createdAt?: string;
  updatedAt?: string;
  state?: "open" | "closed";
  closedAt?: string | null;
  model?: string;
  runtime?: string;
  upstreamIssueNumber?: number;
}

function isoOr(value: string | undefined, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new StoreError(400, "非法 ISO8601 时间戳");
  return new Date(parsed).toISOString();
}

export async function createIssue(
  projectId: number,
  title: string,
  body: string,
  author: string,
  opts: CreateIssueOpts = {}
): Promise<IssueRow> {
  title = title.trim();
  if (!title) throw new StoreError(400, "标题不能为空");
  if (title.length > 255) throw new StoreError(400, "标题过长（≤255）");
  if (body.length > 65536) throw new StoreError(413, "正文过长（≤65536）");
  await ensureUser(author);
  const createdAt = isoOr(opts.createdAt, now());
  const updatedAt = opts.updatedAt ? isoOr(opts.updatedAt, createdAt) : createdAt;
  const state: "open" | "closed" = opts.state ?? "open";
  const closedAt = state === "closed" ? isoOr(opts.closedAt ?? undefined, updatedAt) : null;
  return await getDB().transaction(async () => {
    const next = (await getDB().get<{ n: number }>(
      "SELECT COALESCE(MAX(number), 0) + 1 AS n FROM {{issues}} WHERE project_id = ?", [projectId]
    ))!;
    const info = await getDB().run(
      "INSERT INTO {{issues}} (project_id, number, title, body, state, author, created_at, updated_at, closed_at, model, runtime, upstream_issue_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [projectId, next.n, title, body, state, author, createdAt, updatedAt, closedAt, opts.model ?? "", opts.runtime ?? "", opts.upstreamIssueNumber ?? null]
    );
    await getDB().run("UPDATE {{projects}} SET updated_at = ? WHERE id = ?", [updatedAt, projectId]);
    return (await getIssueById(info.insertId))!;
  });
}

export async function setIssueState(
  issueId: number,
  state: "open" | "closed",
  opts: { closedAt?: string; updatedAt?: string } = {}
): Promise<void> {
  const ts = opts.updatedAt ? isoOr(opts.updatedAt, now()) : now();
  const closedAt = state === "closed" ? isoOr(opts.closedAt ?? undefined, ts) : null;
  await getDB().transaction(async () => {
    await getDB().run("UPDATE {{issues}} SET state = ?, updated_at = ?, closed_at = ? WHERE id = ?", [
      state,
      ts,
      closedAt,
      issueId,
    ]);
    const row = await getDB().get<{ project_id: number }>("SELECT project_id FROM {{issues}} WHERE id = ?", [issueId]);
    await getDB().run("UPDATE {{projects}} SET updated_at = ? WHERE id = ?", [ts, row!.project_id]);
  });
}

export async function updateIssueAiStatus(issueId: number, status: string): Promise<void> {
  await getDB().run("UPDATE {{issues}} SET ai_status = ? WHERE id = ?", [status, issueId]);
}

export async function getIssueAiStatus(issueId: number): Promise<string> {
  const row = await getDB().get<{ ai_status: string }>("SELECT ai_status FROM {{issues}} WHERE id = ?", [issueId]);
  return row?.ai_status ?? "";
}

export async function updateIssueModel(issueId: number, model: string): Promise<void> {
  const clean = model.trim().slice(0, 128);
  await getDB().run("UPDATE {{issues}} SET model = ?, updated_at = ? WHERE id = ?", [clean, now(), issueId]);
}

export async function updateIssueRuntime(issueId: number, runtime: string): Promise<void> {
  const v = runtime === "pi" || runtime === "opencode" ? runtime : "";
  await getDB().run("UPDATE {{issues}} SET runtime = ? WHERE id = ?", [v, issueId]);
}

export interface UpstreamSyncRow {
  id: number;
  project_id: number;
  base_url: string;
  upstream_owner: string;
  upstream_repo: string;
  token: string;
  enabled: number;
  poll_interval_ms: number;
  issue_cursor: string | null;
  comment_cursor: string | null;
  last_poll_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertUpstreamSyncOpts {
  baseUrl: string;
  upstreamOwner: string;
  upstreamRepo: string;
  token?: string;
  enabled?: boolean;
  pollIntervalMs?: number;
}

export async function getUpstreamSync(projectId: number): Promise<UpstreamSyncRow | null> {
  return await getDB().get<UpstreamSyncRow>("SELECT * FROM {{upstream_sync}} WHERE project_id = ?", [projectId]);
}

export async function listEnabledUpstreamSyncs(): Promise<UpstreamSyncRow[]> {
  return await getDB().all<UpstreamSyncRow>("SELECT * FROM {{upstream_sync}} WHERE enabled = 1");
}

export async function upsertUpstreamSync(projectId: number, opts: UpsertUpstreamSyncOpts): Promise<UpstreamSyncRow> {
  const baseUrl = opts.baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/i, "");
  if (!/^https?:\/\//.test(baseUrl)) throw new StoreError(400, "上游地址必须是 http(s) URL");
  const owner = opts.upstreamOwner.trim();
  const repo = opts.upstreamRepo.trim();
  if (!owner || !repo) throw new StoreError(400, "上游 owner/repo 不能为空");
  const interval = opts.pollIntervalMs ?? 60_000;
  if (!Number.isFinite(interval) || interval < 10_000) throw new StoreError(400, "轮询间隔不能小于 10 秒");
  const existing = await getUpstreamSync(projectId);
  const token = opts.token !== undefined ? opts.token.trim() : existing?.token ?? "";
  const enabled = opts.enabled ?? (existing?.enabled === 1);
  const ts = now();
  if (existing) {
    await getDB().run(
      "UPDATE {{upstream_sync}} SET base_url = ?, upstream_owner = ?, upstream_repo = ?, token = ?, enabled = ?, poll_interval_ms = ?, updated_at = ? WHERE project_id = ?",
      [baseUrl, owner, repo, token, enabled ? 1 : 0, Math.floor(interval), ts, projectId]
    );
  } else {
    await getDB().run(
      "INSERT INTO {{upstream_sync}} (project_id, base_url, upstream_owner, upstream_repo, token, enabled, poll_interval_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [projectId, baseUrl, owner, repo, token, enabled ? 1 : 0, Math.floor(interval), ts, ts]
    );
  }
  return (await getUpstreamSync(projectId))!;
}

export async function updateUpstreamSyncState(
  projectId: number,
  patch: { issueCursor?: string | null; commentCursor?: string | null; lastError?: string | null }
): Promise<void> {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.issueCursor !== undefined) {
    sets.push("issue_cursor = ?");
    args.push(patch.issueCursor);
  }
  if (patch.commentCursor !== undefined) {
    sets.push("comment_cursor = ?");
    args.push(patch.commentCursor);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error = ?");
    args.push(patch.lastError);
  }
  if (sets.length === 0) return;
  sets.push("last_poll_at = ?", "updated_at = ?");
  args.push(now(), now(), projectId);
  await getDB().run(`UPDATE {{upstream_sync}} SET ${sets.join(", ")} WHERE project_id = ?`, args);
}

export async function getIssueByUpstreamNumber(projectId: number, upstreamNumber: number): Promise<IssueRow | null> {
  return await getDB().get<IssueRow>(
    "SELECT * FROM {{issues}} WHERE project_id = ? AND upstream_issue_number = ?",
    [projectId, upstreamNumber]
  );
}

export async function getCommentByUpstreamId(upstreamCommentId: number): Promise<CommentRow | null> {
  return await getDB().get<CommentRow>(
    "SELECT * FROM {{comments}} WHERE upstream_comment_id = ?",
    [upstreamCommentId]
  );
}

export async function updateCommentModel(commentId: number, model: string): Promise<void> {
  await getDB().run(
    "UPDATE {{comments}} SET model = ? WHERE id = ?",
    [model.slice(0, 128), commentId],
  );
}
export interface IssuePatch {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  closedAt?: string | null;
  updatedAt?: string;
}

export async function editIssue(issueId: number, patch: IssuePatch): Promise<void> {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw new StoreError(400, "标题不能为空");
    if (t.length > 255) throw new StoreError(400, "标题过长（≤255）");
    sets.push("title = ?");
    args.push(t);
  }
  if (patch.body !== undefined) {
    if (patch.body.length > 65536) throw new StoreError(413, "正文过长（≤65536）");
    sets.push("body = ?");
    args.push(patch.body);
  }
  if (patch.state !== undefined) {
    if (patch.state !== "open" && patch.state !== "closed") {
      throw new StoreError(400, "非法 state");
    }
    sets.push("state = ?");
    args.push(patch.state);
    const ts = patch.updatedAt ? isoOr(patch.updatedAt, now()) : now();
    sets.push("updated_at = ?");
    args.push(ts);
    sets.push("closed_at = ?");
    args.push(patch.state === "closed" ? isoOr(patch.closedAt ?? undefined, ts) : null);
  } else if (patch.updatedAt !== undefined) {
    sets.push("updated_at = ?");
    args.push(isoOr(patch.updatedAt, now()));
  }
  if (sets.length === 0) return;
  if (!patch.state && !patch.updatedAt) {
    sets.push("updated_at = ?");
    args.push(now());
  }
  args.push(issueId);
  await getDB().transaction(async () => {
    await getDB().run(`UPDATE {{issues}} SET ${sets.join(", ")} WHERE id = ?`, args);
    const row = await getDB().get<{ project_id: number }>("SELECT project_id FROM {{issues}} WHERE id = ?", [issueId]);
    if (row) await getDB().run("UPDATE {{projects}} SET updated_at = ? WHERE id = ?", [now(), row.project_id]);
  });
}

export async function countComments(issueId: number): Promise<number> {
  const row = await getDB().get<{ n: number }>("SELECT COUNT(*) AS n FROM {{comments}} WHERE issue_id = ?", [issueId]);
  return row!.n;
}

export async function listCommentsPage(issueId: number, page: number, pageSize: number): Promise<{ rows: CommentRow[]; page: number }> {
  const total = await countComments(issueId);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const offset = (clamped - 1) * pageSize;
  const rows = await getDB().all<CommentRow>(
    `SELECT c.*, u.kind AS author_kind, u.display_name AS author_display_name
     FROM {{comments}} c
     LEFT JOIN {{users}} u ON u.login = c.author
     WHERE c.issue_id = ?
     ORDER BY c.created_at ASC, c.id ASC
     LIMIT ? OFFSET ?`,
    [issueId, pageSize, offset]
  );
  return { rows, page: clamped };
}

export async function listCommentsSince(issueId: number, sinceISO: string): Promise<CommentRow[]> {
  return await getDB().all<CommentRow>(
    `SELECT c.*, u.kind AS author_kind, u.display_name AS author_display_name
     FROM {{comments}} c
     LEFT JOIN {{users}} u ON u.login = c.author
     WHERE c.issue_id = ? AND c.created_at > ?
     ORDER BY c.created_at ASC, c.id ASC`,
    [issueId, sinceISO]
  );
}

export async function listCommentsForIssue(issueId: number): Promise<CommentRow[]> {
  return await getDB().all<CommentRow>(
    `SELECT c.*, u.kind AS author_kind, u.display_name AS author_display_name
     FROM {{comments}} c
     LEFT JOIN {{users}} u ON u.login = c.author
     WHERE c.issue_id = ?
     ORDER BY c.created_at ASC, c.id ASC`,
    [issueId]
  );
}

export interface CreateCommentOpts {
  createdAt?: string;
  updatedAt?: string;
  upstreamCommentId?: number;
}

export async function postComment(
  issueId: number,
  body: string,
  author: string,
  opts: CreateCommentOpts = {}
): Promise<CommentRow> {
  if (!body || !body.trim()) throw new StoreError(400, "评论不能为空");
  if (body.length > 65536) throw new StoreError(413, "评论过长（≤65536）");
  await ensureUser(author);
  const createdAt = isoOr(opts.createdAt, now());
  const updatedAt = opts.updatedAt ? isoOr(opts.updatedAt, createdAt) : createdAt;
  return await getDB().transaction(async () => {
    const info = await getDB().run(
      "INSERT INTO {{comments}} (issue_id, author, body, created_at, updated_at, upstream_comment_id) VALUES (?, ?, ?, ?, ?, ?)",
      [issueId, author, body, createdAt, updatedAt, opts.upstreamCommentId ?? null]
    );
    await getDB().run("UPDATE {{issues}} SET updated_at = ? WHERE id = ?", [updatedAt, issueId]);
    const row = await getDB().get<{ project_id: number }>("SELECT project_id FROM {{issues}} WHERE id = ?", [issueId]);
    await getDB().run("UPDATE {{projects}} SET updated_at = ? WHERE id = ?", [updatedAt, row!.project_id]);
    return (await getDB().get<CommentRow>(
      `SELECT c.*, u.kind AS author_kind, u.display_name AS author_display_name
       FROM {{comments}} c LEFT JOIN {{users}} u ON u.login = c.author
       WHERE c.id = ?`,
      [info.insertId]
    ))!;
  });
}

export async function getComment(commentId: number): Promise<CommentRow | null> {
  const row = await getDB().get<CommentRow>(
    `SELECT c.*, u.kind AS author_kind, u.display_name AS author_display_name
     FROM {{comments}} c LEFT JOIN {{users}} u ON u.login = c.author
     WHERE c.id = ?`,
    [commentId]
  );
  return row ?? null;
}

export async function editComment(commentId: number, body: string): Promise<CommentRow> {
  const trimmed = String(body ?? "");
  if (!trimmed.trim()) throw new StoreError(400, "评论不能为空");
  if (trimmed.length > 65536) throw new StoreError(413, "评论过长（≤65536）");
  const ts = now();
  const info = await getDB().run("UPDATE {{comments}} SET body = ?, updated_at = ? WHERE id = ?", [trimmed, ts, commentId]);
  if (info.changes === 0) throw new StoreError(404, `评论 ${commentId} 不存在`);
  return (await getComment(commentId))!;
}

export async function deleteComment(commentId: number): Promise<void> {
  const info = await getDB().run("DELETE FROM {{comments}} WHERE id = ?", [commentId]);
  if (info.changes === 0) throw new StoreError(404, `评论 ${commentId} 不存在`);
}

export interface ReactionAgg {
  comment_id: number;
  content: string;
  n: number;
}

export async function listReactionsFor(commentIds: number[]): Promise<ReactionAgg[]> {
  if (commentIds.length === 0) return [];
  const placeholders = commentIds.map(() => "?").join(",");
  return await getDB().all<ReactionAgg>(
    `SELECT comment_id, content, COUNT(*) AS n
     FROM {{reactions}} WHERE comment_id IN (${placeholders})
     GROUP BY comment_id, content`,
    commentIds
  );
}

export async function addReaction(commentId: number, userLogin: string, content: string): Promise<void> {
  if (!content || content.length > 32) throw new StoreError(400, "非法的 reaction content");
  await ensureUser(userLogin);
  await getDB().run(
    "INSERT OR IGNORE INTO {{reactions}} (comment_id, user_login, content) VALUES (?, ?, ?)",
    [commentId, userLogin, content]
  );
}

export async function removeReaction(commentId: number, userLogin: string, content: string): Promise<void> {
  await getDB().run(
    "DELETE FROM {{reactions}} WHERE comment_id = ? AND user_login = ? AND content = ?",
    [commentId, userLogin, content]
  );
}

const LABEL_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LABEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _\-./]{0,62}$/;

export async function listLabels(projectId: number, includeArchived = false): Promise<LabelRow[]> {
  const where = includeArchived ? "project_id = ?" : "project_id = ? AND is_archived = 0";
  return await getDB().all<LabelRow>(`SELECT * FROM {{labels}} WHERE ${where} ORDER BY name`, [projectId]);
}

export async function listLabelsForIssue(issueId: number): Promise<LabelRow[]> {
  return await getDB().all<LabelRow>(
    `SELECT l.* FROM {{labels}} l
     JOIN {{issue_labels}} il ON il.label_id = l.id
     WHERE il.issue_id = ? ORDER BY l.name`,
    [issueId]
  );
}

export async function listLabelsForIssues(issueIds: number[]): Promise<Map<number, LabelRow[]>> {
  const result = new Map<number, LabelRow[]>();
  if (issueIds.length === 0) return result;
  const placeholders = issueIds.map(() => "?").join(",");
  const rows = await getDB().all<{
    issue_id: number;
    label_id: number;
    name: string;
    color: string;
    description: string | null;
    exclusive: number;
    is_archived: number;
  }>(
    `SELECT il.issue_id, l.id AS label_id, l.name, l.color, l.description, l.exclusive, l.is_archived
     FROM {{issue_labels}} il JOIN {{labels}} l ON l.id = il.label_id
     WHERE il.issue_id IN (${placeholders})
     ORDER BY l.name`,
    issueIds
  );
  for (const r of rows) {
    const issueId = r.issue_id;
    const label: LabelRow = {
      id: r.label_id,
      project_id: 0,
      name: r.name,
      color: r.color,
      description: r.description ?? "",
      exclusive: r.exclusive,
      is_archived: r.is_archived,
    };
    const list = result.get(issueId);
    if (list) list.push(label);
    else result.set(issueId, [label]);
  }
  return result;
}

export async function getLabel(projectId: number, id: number): Promise<LabelRow | null> {
  return (await getDB().get<LabelRow>("SELECT * FROM {{labels}} WHERE project_id = ? AND id = ?", [projectId, id])) ?? null;
}

interface LabelInput {
  name: string;
  color: string;
  description?: string;
  exclusive?: boolean;
}

function validateLabel(t: LabelInput): { name: string; color: string; description: string; exclusive: number } {
  const name = t.name.trim();
  if (!name) throw new StoreError(400, "标签名不能为空");
  if (!LABEL_NAME_RE.test(name)) throw new StoreError(400, "标签名仅允许字母数字、空格、_ - . /，且不能以 / 开头");
  if (!LABEL_COLOR_RE.test(t.color)) throw new StoreError(400, "颜色须为 #RRGGBB");
  return { name, color: t.color, description: (t.description ?? "").trim(), exclusive: t.exclusive ? 1 : 0 };
}

export async function createLabel(projectId: number, input: LabelInput): Promise<LabelRow> {
  const v = validateLabel(input);
  const info = await getDB().run(
    "INSERT INTO {{labels}} (project_id, name, color, description, exclusive) VALUES (?, ?, ?, ?, ?)",
    [projectId, v.name, v.color, v.description, v.exclusive]
  );
  return (await getDB().get<LabelRow>("SELECT * FROM {{labels}} WHERE id = ?", [info.insertId]))!;
}

export async function updateLabel(projectId: number, id: number, input: Partial<LabelInput>): Promise<LabelRow> {
  const existing = await getLabel(projectId, id);
  if (!existing) throw new StoreError(404, "标签不存在");
  const merged: LabelInput = {
    name: input.name ?? existing.name,
    color: input.color ?? existing.color,
    description: input.description ?? existing.description,
    exclusive: input.exclusive ?? (existing.exclusive === 1),
  };
  const v = validateLabel(merged);
  await getDB().run(
    "UPDATE {{labels}} SET name = ?, color = ?, description = ?, exclusive = ? WHERE project_id = ? AND id = ?",
    [v.name, v.color, v.description, v.exclusive, projectId, id]
  );
  return (await getDB().get<LabelRow>("SELECT * FROM {{labels}} WHERE id = ?", [id]))!;
}

export async function archiveLabel(projectId: number, id: number, archived: boolean): Promise<LabelRow> {
  const existing = await getLabel(projectId, id);
  if (!existing) throw new StoreError(404, "标签不存在");
  await getDB().run("UPDATE {{labels}} SET is_archived = ? WHERE project_id = ? AND id = ?", [archived ? 1 : 0, projectId, id]);
  return (await getDB().get<LabelRow>("SELECT * FROM {{labels}} WHERE id = ?", [id]))!;
}

export async function deleteLabel(projectId: number, id: number): Promise<void> {
  await getDB().run("DELETE FROM {{labels}} WHERE project_id = ? AND id = ?", [projectId, id]);
}

/** Attach (`on=true`) or detach a label. When attaching an exclusive label
 *  (scope/name with exclusive=1), any other already-attached label sharing the
 *  same scope is removed first, so an issue holds at most one label per scope. */
export async function setIssueLabel(issueId: number, labelId: number, on: boolean): Promise<void> {
  if (!on) {
    await getDB().run("DELETE FROM {{issue_labels}} WHERE issue_id = ? AND label_id = ?", [issueId, labelId]);
    return;
  }
  const label = await getDB().get<LabelRow>("SELECT * FROM {{labels}} WHERE id = ?", [labelId]);
  if (!label) throw new StoreError(404, "标签不存在");
  // Wrap read-modify-write in a transaction to prevent concurrent callers
  // from racing on exclusive-scope eviction (read old set → both insert).
  await getDB().transaction(async () => {
    if (label.exclusive === 1) {
      const scope = labelScope(label.name);
      if (scope) {
        const current = await listLabelsForIssue(issueId);
        const siblings = current.filter((l) => l.exclusive === 1 && labelScope(l.name) === scope && l.id !== labelId);
        for (const s of siblings) {
          await getDB().run("DELETE FROM {{issue_labels}} WHERE issue_id = ? AND label_id = ?", [issueId, s.id]);
        }
      }
    }
    const dialect = getDB().dialect;
    const insert = dialect === "sqlite"
      ? "INSERT OR IGNORE INTO {{issue_labels}} (issue_id, label_id) VALUES (?, ?)"
      : "INSERT IGNORE INTO {{issue_labels}} (issue_id, label_id) VALUES (?, ?)";
    await getDB().run(insert, [issueId, labelId]);
  });
}

export async function setIssueLabels(issueId: number, labelIds: number[]): Promise<void> {
  const dialect = getDB().dialect;
  // Wrap DELETE + INSERTs in a transaction so a crash between operations
  // doesn't leave the issue with zero labels.
  await getDB().transaction(async () => {
    await getDB().run("DELETE FROM {{issue_labels}} WHERE issue_id = ?", [issueId]);
    const ids = Array.from(new Set(labelIds));
    const insert = dialect === "sqlite"
      ? "INSERT OR IGNORE INTO {{issue_labels}} (issue_id, label_id) VALUES (?, ?)"
      : "INSERT IGNORE INTO {{issue_labels}} (issue_id, label_id) VALUES (?, ?)";
    for (const id of ids) {
      await getDB().run(insert, [issueId, id]);
    }
  });
}

export async function createAttachment(a: Omit<AttachmentRow, "created_at">): Promise<AttachmentRow> {
  const ts = now();
  await getDB().run(
    `INSERT INTO {{attachments}} (uuid, issue_id, filename, content_type, size, blob_path, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [a.uuid, a.issue_id, a.filename, a.content_type, a.size, a.blob_path, a.uploaded_by, ts]
  );
  return (await getDB().get<AttachmentRow>("SELECT * FROM {{attachments}} WHERE uuid = ?", [a.uuid]))!;
}

export async function getAttachment(uuid: string): Promise<AttachmentRow | null> {
  return (await getDB().get<AttachmentRow>("SELECT * FROM {{attachments}} WHERE uuid = ?", [uuid])) ?? null;
}

const LOGIN_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function hashPassword(plain: string): Promise<string> {
  // Algorithm is encoded in the modular crypt string ($2b$10$...), so future
  // migration to argon2 only affects newly-set passwords; legacy verifies work.
  return Bun.password.hash(plain, { algorithm: "bcrypt", cost: 10 });
}

export async function createUser(input: CreateUserInput): Promise<UserRow> {
  const login = input.login.trim();
  if (!LOGIN_RE.test(login)) {
    throw new StoreError(400, "login 含非法字符或长度不在 1-64 内");
  }
  if (input.password.length < 8) {
    throw new StoreError(400, "密码至少 8 位");
  }
  if (input.password.length > 200) {
    throw new StoreError(400, "密码过长（≤200）");
  }
  const db = getDB();
  if (await db.get("SELECT 1 FROM {{users}} WHERE login = ?", [login])) {
    throw new StoreError(409, `用户 ${login} 已存在`);
  }
  const ts = now();
  const hash = await hashPassword(input.password);
  await db.run(
    `INSERT INTO {{users}} (login, kind, display_name, password_hash, email, is_admin, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      login,
      input.kind ?? "human",
      input.display_name ?? null,
      hash,
      input.email ?? null,
      input.is_admin ? 1 : 0,
      input.is_active === false ? 0 : 1,
      ts,
      ts
    ]
  );
  return (await getUserByLogin(login))!;
}

export async function getUserByLogin(login: string): Promise<UserRow | null> {
  return (await getDB().get<UserRow>("SELECT * FROM {{users}} WHERE login = ?", [login])) ?? null;
}

export async function listUsers(): Promise<UserRow[]> {
  return await getDB().all<UserRow>("SELECT * FROM {{users}} ORDER BY is_admin DESC, created_at ASC");
}

export async function listAdmins(): Promise<UserRow[]> {
  return await getDB().all<UserRow>("SELECT * FROM {{users}} WHERE is_admin = 1");
}

export async function verifyUserPassword(login: string, password: string): Promise<UserRow | null> {
  const user = await getUserByLogin(login);
  if (!user || !user.password_hash || !user.is_active) return null;
  const ok = await Bun.password.verify(password, user.password_hash);
  return ok ? user : null;
}

export interface UpdateUserPatch {
  email?: string | null;
  display_name?: string | null;
  is_admin?: boolean;
  is_active?: boolean;
  kind?: UserKind;
}

export async function updateUser(login: string, patch: UpdateUserPatch): Promise<UserRow> {
  const existing = await getUserByLogin(login);
  if (!existing) throw new StoreError(404, `用户 ${login} 不存在`);
  const ts = now();
  const db = getDB();
  await db.run(
    `UPDATE {{users}} SET
       email = COALESCE(?, email),
       display_name = COALESCE(?, display_name),
       is_admin = COALESCE(?, is_admin),
       is_active = COALESCE(?, is_active),
       kind = COALESCE(?, kind),
       updated_at = ?
     WHERE login = ?`,
    [
      patch.email !== undefined ? patch.email : null,
      patch.display_name !== undefined ? patch.display_name : null,
      patch.is_admin !== undefined ? (patch.is_admin ? 1 : 0) : null,
      patch.is_active !== undefined ? (patch.is_active ? 1 : 0) : null,
      patch.kind ?? null,
      ts,
      login
    ]
  );
  return (await getUserByLogin(login))!;
}

export async function setUserPassword(login: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw new StoreError(400, "密码至少 8 位");
  if (newPassword.length > 200) throw new StoreError(400, "密码过长（≤200）");
  const existing = await getUserByLogin(login);
  if (!existing) throw new StoreError(404, `用户 ${login} 不存在`);
  const ts = now();
  const hash = await hashPassword(newPassword);
  await getDB().run("UPDATE {{users}} SET password_hash = ?, updated_at = ? WHERE login = ?", [hash, ts, login]);
}

export async function countAdmins(): Promise<number> {
  const row = await getDB().get<{ n: number }>("SELECT COUNT(*) AS n FROM {{users}} WHERE is_admin = 1");
  return row!.n;
}

export interface PatRow {
  id: number;
  user_login: string;
  name: string;
  salt: string;
  token_hash: string;
  token_last_eight: string;
  scopes: string;
  ip_allowlist: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatePatInput {
  user_login: string;
  name: string;
  scopes?: string[];
  ip_allowlist?: string[];
  expires_at?: string | null;
}

export interface CreatePatResult {
  row: PatRow;
  plaintext: string;
}

const PAT_NAME_RE = /^[\w\u4e00-\u9fa5 .\-()]{1,64}$/;
const CIDR4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

function parseIPv4(s: string): number[] | null {
  const m = s.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map((x) => parseInt(x ?? "", 10));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const m = cidr.trim().match(CIDR4_RE);
  if (!m) return false;
  const net = [m[1], m[2], m[3], m[4]].map((x) => parseInt(x ?? "", 10));
  if (net.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const ipParts = parseIPv4(ip);
  if (!ipParts) return false;
  const prefix = m[5] !== undefined ? parseInt(m[5], 10) : 32;
  if (prefix < 0 || prefix > 32) return false;
  const netLong = (((net[0] ?? 0) << 24) | ((net[1] ?? 0) << 16) | ((net[2] ?? 0) << 8) | (net[3] ?? 0)) >>> 0;
  const ipLong = (((ipParts[0] ?? 0) << 24) | ((ipParts[1] ?? 0) << 16) | ((ipParts[2] ?? 0) << 8) | (ipParts[3] ?? 0)) >>> 0;
  const mask = prefix === 0 ? 0 : (prefix === 32 ? -1 : (-1 << (32 - prefix))) >>> 0;
  return (netLong & mask) === (ipLong & mask);
}

export function parsePatIpAllowlist(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function normalizeIpV4(ip: string): string | null {
  if (!ip) return null;
  let s = ip.trim();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end > 0) s = s.slice(1, end);
  }
  const v4mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped) {
    const v4 = v4mapped[1] ?? "";
    return parseIPv4(v4) ? v4 : null;
  }
  const v4port = s.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
  if (v4port) {
    const v4 = v4port[1] ?? "";
    return parseIPv4(v4) ? v4 : null;
  }
  return parseIPv4(s) ? s : null;
}

// Returns true if `ip` satisfies the allowlist. Empty allowlist = allow all.
// ip is required (caller must pass the request IP, "unknown" never matches).
export function ipAllowedBy(ip: string | null | undefined, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const cleanIp = normalizeIpV4(typeof ip === "string" ? ip : "");
  if (!cleanIp) return false;
  return allowlist.some((cidr) => ipInCidr(cleanIp, cidr));
}

function validateCidrList(input: string[] | undefined): string[] {
  if (!input || input.length === 0) return [];
  if (input.length > 16) throw new StoreError(400, "IP allowlist 最多 16 条 CIDR");
  const out: string[] = [];
  for (const raw of input) {
    const cidr = raw.trim();
    if (!cidr) continue;
    if (!CIDR4_RE.test(cidr)) throw new StoreError(400, `非法 CIDR: ${cidr}（仅支持 IPv4）`);
    out.push(cidr);
  }
  return out;
}

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function sha256Hex(msg: string): string {
  const h = createHash("sha256");
  h.update(msg);
  return h.digest("hex");
}

function ctEqualBuf(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function createPat(input: CreatePatInput): Promise<CreatePatResult> {
  const login = input.user_login.trim();
  const name = input.name.trim();
  const user = await getUserByLogin(login);
  if (!user) throw new StoreError(404, `用户 ${login} 不存在`);
  if (!PAT_NAME_RE.test(name)) throw new StoreError(400, "token 名称含非法字符或长度不在 1-64 内");
  const scopes = input.scopes ?? ["read", "write"];
  for (const s of scopes) {
    if (!/^[a-z:_]{1,32}$/.test(s)) throw new StoreError(400, `scope 含非法字符: ${s}`);
  }
  const ipAllowlist = validateCidrList(input.ip_allowlist);
  let expiresAt: string | null = null;
  if (input.expires_at) {
    const t = Date.parse(input.expires_at);
    if (!Number.isFinite(t)) throw new StoreError(400, "expires_at 不是合法时间");
    expiresAt = new Date(t).toISOString();
  }
  // 40-char hex token (matches Gitea format) + 20-char hex per-token salt.
  const plaintext = randomHex(20);
  const salt = randomHex(10);
  const tokenHash = sha256Hex(salt + plaintext);
  const lastEight = plaintext.slice(-8);
  const ts = now();
  const info = await getDB().run(
    `INSERT INTO {{personal_access_tokens}}
       (user_login, name, salt, token_hash, token_last_eight, scopes, ip_allowlist, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [login, name, salt, tokenHash, lastEight, JSON.stringify(scopes), JSON.stringify(ipAllowlist), expiresAt, ts]
  );
  const row = await getPat(info.insertId);
  if (!row) throw new StoreError(500, "PAT 创建后无法读取");
  return { row, plaintext };
}

export async function getPat(id: number): Promise<PatRow | null> {
  return (await getDB().get<PatRow>("SELECT * FROM {{personal_access_tokens}} WHERE id = ?", [id])) ?? null;
}

export async function listPatsForUser(login: string): Promise<PatRow[]> {
  return await getDB().all<PatRow>(
    "SELECT * FROM {{personal_access_tokens}} WHERE user_login = ? ORDER BY created_at DESC",
    [login]
  );
}

export interface PatWithUser extends PatRow {
  user_kind: UserKind | null;
  user_is_admin: number | null;
  user_is_active: number | null;
}

export async function listAllPatsWithUsers(): Promise<PatWithUser[]> {
  return await getDB().all<PatWithUser>(
    `SELECT p.*, u.kind AS user_kind, u.is_admin AS user_is_admin, u.is_active AS user_is_active
     FROM {{personal_access_tokens}} p
     LEFT JOIN {{users}} u ON u.login = p.user_login
     ORDER BY p.created_at DESC`
  );
}

export async function revokePat(id: number, login: string): Promise<void> {
  const row = await getPat(id);
  if (!row) throw new StoreError(404, "token 不存在");
  if (row.user_login !== login) throw new StoreError(403, "无权操作他人 token");
  if (row.revoked_at) return;
  await getDB().run("UPDATE {{personal_access_tokens}} SET revoked_at = ? WHERE id = ?", [now(), id]);
}

// Admin override: revoke any token regardless of owner. Caller MUST check
// ctx.user.is_admin === 1 before invoking.
export async function revokePatAsAdmin(id: number): Promise<void> {
  const row = await getPat(id);
  if (!row) throw new StoreError(404, "token 不存在");
  if (row.revoked_at) return;
  await getDB().run("UPDATE {{personal_access_tokens}} SET revoked_at = ? WHERE id = ?", [now(), id]);
}

export async function verifyPat(rawToken: string, ip?: string | null): Promise<UserRow | null> {
  if (!/^[0-9a-f]{40}$/.test(rawToken)) return null;
  const lastEight = rawToken.slice(-8);
  const candidates = await getDB().all<PatRow>(
    "SELECT * FROM {{personal_access_tokens}} WHERE token_last_eight = ?",
    [lastEight]
  );
  const nowMs = Date.now();
  for (const row of candidates) {
    if (row.revoked_at) continue;
    if (row.expires_at && Date.parse(row.expires_at) < nowMs) continue;
    const expected = sha256Hex(row.salt + rawToken);
    if (!ctEqualBuf(Buffer.from(expected, "hex"), Buffer.from(row.token_hash, "hex"))) continue;
    const allowlist = parsePatIpAllowlist(row.ip_allowlist ?? "[]");
    if (!ipAllowedBy(ip, allowlist)) continue;
    const user = await getUserByLogin(row.user_login);
    if (!user || !user.is_active) return null;
    await getDB().run("UPDATE {{personal_access_tokens}} SET last_used_at = ? WHERE id = ?", [now(), row.id]);
    return user;
  }
  return null;
}

export type ProjectRole = "reader" | "writer" | "admin";

export interface ProjectMembership {
  project_id: number;
  user_login: string;
  role: ProjectRole;
  created_at: string;
}

const ROLE_RANK: Record<ProjectRole, number> = { reader: 1, writer: 2, admin: 3 };

export interface ProjectMemberWithUser extends ProjectMembership {
  user_kind: UserKind;
  user_display_name: string | null;
  user_is_active: number;
}

export async function listProjectMembersWithUsers(projectId: number): Promise<ProjectMemberWithUser[]> {
  return await getDB().all<ProjectMemberWithUser>(
    `SELECT m.*, u.kind AS user_kind, u.display_name AS user_display_name, u.is_active AS user_is_active
     FROM {{project_members}} m JOIN {{users}} u ON u.login = m.user_login
     WHERE m.project_id = ?
     ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'writer' THEN 1 ELSE 2 END, m.created_at ASC`,
    [projectId]
  );
}

export async function listMembershipsForUser(userLogin: string): Promise<ProjectMembership[]> {
  return await getDB().all<ProjectMembership>(
    "SELECT * FROM {{project_members}} WHERE user_login = ? ORDER BY created_at ASC",
    [userLogin]
  );
}

export async function getProjectMembership(projectId: number, userLogin: string): Promise<ProjectMembership | null> {
  return (
    (await getDB().get<ProjectMembership>(
      "SELECT * FROM {{project_members}} WHERE project_id = ? AND user_login = ?",
      [projectId, userLogin]
    )) ?? null
  );
}

// Returns the user's effective role on a project, or null. Site-admins return
// "admin" (the highest project role) so caller's canWrite/canAdmin work without
// a separate code path. Caller still needs to check user.is_admin separately
// for site-wide admin powers (user management, etc.).
export async function getRoleOnProject(projectId: number, user: { login: string; is_admin: number } | null): Promise<ProjectRole | null> {
  if (!user) return null;
  if (user.is_admin === 1) return "admin";
  const m = await getProjectMembership(projectId, user.login);
  return m?.role ?? null;
}

export async function canWriteProject(projectId: number, user: { login: string; is_admin: number } | null): Promise<boolean> {
  const r = await getRoleOnProject(projectId, user);
  return r !== null && ROLE_RANK[r] >= ROLE_RANK.writer;
}

export async function canAdminProject(projectId: number, user: { login: string; is_admin: number } | null): Promise<boolean> {
  const r = await getRoleOnProject(projectId, user);
  return r === "admin";
}

export async function canReadProject(projectId: number, user: { login: string; is_admin: number } | null): Promise<boolean> {
  if (!user) return false;
  if (user.is_admin === 1) return true;
  const project = await getProjectById(projectId);
  if (!project) return false;
  if (project.visibility !== "private") return true;
  const r = await getRoleOnProject(projectId, user);
  return r !== null;
}

export async function addProjectMember(projectId: number, userLogin: string, role: ProjectRole): Promise<ProjectMembership> {
  const login = userLogin.trim();
  if (!(await getUserByLogin(login))) throw new StoreError(404, `用户 ${login} 不存在`);
  const ts = now();
  await getDB().run(
    "INSERT OR IGNORE INTO {{project_members}} (project_id, user_login, role, created_at) VALUES (?, ?, ?, ?)",
    [projectId, login, role, ts]
  );
  return (await getProjectMembership(projectId, login))!;
}

export async function setProjectMemberRole(projectId: number, userLogin: string, role: ProjectRole): Promise<void> {
  const m = await getProjectMembership(projectId, userLogin);
  if (!m) throw new StoreError(404, `用户 ${userLogin} 不是该项目成员`);
  await getDB().run(
    "UPDATE {{project_members}} SET role = ? WHERE project_id = ? AND user_login = ?",
    [role, projectId, userLogin]
  );
}

export async function removeProjectMember(projectId: number, userLogin: string): Promise<void> {
  await getDB().run(
    "DELETE FROM {{project_members}} WHERE project_id = ? AND user_login = ?",
    [projectId, userLogin]
  );
}

export async function countProjectAdmins(projectId: number): Promise<number> {
  const row = await getDB().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM {{project_members}} WHERE project_id = ? AND role = 'admin'",
    [projectId]
  );
  return row!.n;
}

// Idempotent bootstrap: if the project has zero members, add `login` as admin.
// Called from project-create flow + lazily from project settings page when a
// site-admin first opens it on an old (pre-RBAC) project.
export async function ensureProjectBootstrapAdmin(projectId: number, login: string): Promise<void> {
  const existing = await getDB().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM {{project_members}} WHERE project_id = ?",
    [projectId]
  );
  if (existing!.n > 0) return;
  if (!(await getUserByLogin(login))) return;
  const ts = now();
  await getDB().run(
    "INSERT OR IGNORE INTO {{project_members}} (project_id, user_login, role, created_at) VALUES (?, ?, 'admin', ?)",
    [projectId, login, ts]
  );
}
