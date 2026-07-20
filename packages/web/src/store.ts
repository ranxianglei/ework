// SQLite-backed data layer for ework. Single DB (see db.ts) holds projects +
// issues + comments + labels + reactions + attachments + users. All write ops
// run in transactions; per-project issue numbers are allocated atomically.

import { rawDB } from "./db";
import { createHash } from "node:crypto";

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
  created_at: string;
  updated_at: string;
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
}

export interface LabelRow {
  id: number;
  project_id: number;
  name: string;
  color: string;
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

type DB = ReturnType<typeof rawDB>;

function now(): string {
  return new Date().toISOString();
}

function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw e;
  }
}

export function ensureUser(login: string, kind: UserKind = "human"): UserRow {
  const db = rawDB();
  const existing = db.query("SELECT * FROM users WHERE login = ?").get(login) as UserRow | null;
  if (existing) return existing;
  const ts = now();
  db.query(
    "INSERT INTO users (login, kind, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).run(login, kind, ts, ts);
  return {
    login,
    kind,
    display_name: null,
    password_hash: null,
    email: null,
    is_admin: 0,
    is_active: 1,
    created_at: ts,
    updated_at: ts,
  };
}

export function getProject(owner: string, name: string): ProjectRow | null {
  return (rawDB().query("SELECT * FROM projects WHERE owner = ? AND name = ?").get(owner, name) as ProjectRow | null) ?? null;
}

export function getProjectById(id: number): ProjectRow | null {
  return (rawDB().query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null) ?? null;
}

export function getProjectByIssueId(issueId: number): ProjectRow | null {
  const row = rawDB()
    .query("SELECT p.* FROM projects p JOIN issues i ON i.project_id = p.id WHERE i.id = ?")
    .get(issueId) as ProjectRow | null;
  return row ?? null;
}

export interface ProjectWithCounts extends ProjectRow {
  open_count: number;
  total_count: number;
}

export function listProjectsWithCounts(): ProjectWithCounts[] {
  return rawDB()
    .query(
      `SELECT p.*,
         COALESCE(SUM(CASE WHEN i.state = 'open' THEN 1 ELSE 0 END), 0) AS open_count,
         COUNT(i.id) AS total_count
       FROM projects p
       LEFT JOIN issues i ON i.project_id = p.id
       GROUP BY p.id
       ORDER BY p.updated_at DESC`
    )
    .all() as ProjectWithCounts[];
}

export function createProject(owner: string, name: string, description: string): ProjectRow {
  owner = owner.trim();
  name = name.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(owner)) throw new StoreError(400, "owner 含非法字符");
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new StoreError(400, "name 含非法字符");
  if (getProject(owner, name)) throw new StoreError(409, `项目 ${owner}/${name} 已存在`);
  const ts = now();
  const db = rawDB();
  const info = db
    .query("INSERT INTO projects (owner, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(owner, name, description ?? "", ts, ts);
  return getProjectById(Number(info.lastInsertRowid))!;
}

export function touchProject(projectId: number): void {
  rawDB().query("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), projectId);
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

export function setProjectUpstreamUrls(projectId: number, urls: string[]): string[] {
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
  rawDB()
    .query("UPDATE projects SET upstream_urls = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(cleaned), ts, projectId);
  return cleaned;
}

export function getIssue(projectId: number, number: number): IssueRow | null {
  return (
    (rawDB()
      .query("SELECT * FROM issues WHERE project_id = ? AND number = ?")
      .get(projectId, number) as IssueRow | null) ?? null
  );
}

export function getIssueById(id: number): IssueRow | null {
  return (rawDB().query("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | null) ?? null;
}

export function getIssueWithMeta(projectId: number, number: number): IssueWithMeta | null {
  return (
    (rawDB()
      .query(
        `SELECT i.*, p.owner AS project_owner, p.name AS project_name,
                (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count
         FROM issues i JOIN projects p ON p.id = i.project_id
         WHERE i.project_id = ? AND i.number = ?`
      )
      .get(projectId, number) as IssueWithMeta | null) ?? null
  );
}

export interface ListIssuesOpts {
  state?: "open" | "closed" | "all";
  q?: string;
  limit?: number;
}

export function listIssues(projectId: number, opts: ListIssuesOpts = {}): IssueWithMeta[] {
  const state = opts.state ?? "open";
  const q = (opts.q ?? "").trim();
  const limit = Math.min(opts.limit ?? 50, 200);
  let sql = `SELECT i.*, p.owner AS project_owner, p.name AS project_name,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count
            FROM issues i JOIN projects p ON p.id = i.project_id
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
  sql += " ORDER BY i.updated_at DESC LIMIT ?";
  args.push(limit);
  return rawDB().query(sql).all(...args) as IssueWithMeta[];
}

export function listAllIssues(opts: ListIssuesOpts = {}): IssueWithMeta[] {
  const state = opts.state ?? "open";
  const q = (opts.q ?? "").trim();
  const limit = Math.min(opts.limit ?? 50, 200);
  let sql = `SELECT i.*, p.owner AS project_owner, p.name AS project_name,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count
            FROM issues i JOIN projects p ON p.id = i.project_id
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
  sql += " ORDER BY i.updated_at DESC LIMIT ?";
  args.push(limit);
  return rawDB().query(sql).all(...args) as IssueWithMeta[];
}

export interface CreateIssueOpts {
  createdAt?: string;
  updatedAt?: string;
  state?: "open" | "closed";
  closedAt?: string | null;
}

function isoOr(value: string | undefined, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new StoreError(400, "非法 ISO8601 时间戳");
  return new Date(parsed).toISOString();
}

export function createIssue(
  projectId: number,
  title: string,
  body: string,
  author: string,
  opts: CreateIssueOpts = {}
): IssueRow {
  title = title.trim();
  if (!title) throw new StoreError(400, "标题不能为空");
  if (title.length > 255) throw new StoreError(400, "标题过长（≤255）");
  if (body.length > 65536) throw new StoreError(413, "正文过长（≤65536）");
  ensureUser(author);
  const createdAt = isoOr(opts.createdAt, now());
  const updatedAt = opts.updatedAt ? isoOr(opts.updatedAt, createdAt) : createdAt;
  const state: "open" | "closed" = opts.state ?? "open";
  const closedAt = state === "closed" ? isoOr(opts.closedAt ?? undefined, updatedAt) : null;
  const db = rawDB();
  return tx(db, () => {
    const next = (
      db.query("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM issues WHERE project_id = ?").get(projectId) as {
        n: number;
      }
    ).n;
    const info = db
      .query(
        "INSERT INTO issues (project_id, number, title, body, state, author, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(projectId, next, title, body, state, author, createdAt, updatedAt, closedAt);
    db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, projectId);
    return getIssueById(Number(info.lastInsertRowid))!;
  });
}

export function setIssueState(
  issueId: number,
  state: "open" | "closed",
  opts: { closedAt?: string; updatedAt?: string } = {}
): void {
  const ts = opts.updatedAt ? isoOr(opts.updatedAt, now()) : now();
  const closedAt = state === "closed" ? isoOr(opts.closedAt ?? undefined, ts) : null;
  const db = rawDB();
  tx(db, () => {
    db.query("UPDATE issues SET state = ?, updated_at = ?, closed_at = ? WHERE id = ?").run(
      state,
      ts,
      closedAt,
      issueId
    );
    const row = db.query("SELECT project_id FROM issues WHERE id = ?").get(issueId) as { project_id: number };
    db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(ts, row.project_id);
  });
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  closedAt?: string | null;
  updatedAt?: string;
}

export function editIssue(issueId: number, patch: IssuePatch): void {
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
  const db = rawDB();
  tx(db, () => {
    db.query(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    const row = db.query("SELECT project_id FROM issues WHERE id = ?").get(issueId) as { project_id: number } | null;
    if (row) db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), row.project_id);
  });
}

export function countComments(issueId: number): number {
  const row = rawDB().query("SELECT COUNT(*) AS n FROM comments WHERE issue_id = ?").get(issueId) as { n: number };
  return row.n;
}

export function listCommentsPage(issueId: number, page: number, pageSize: number): { rows: CommentRow[]; page: number } {
  const total = countComments(issueId);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const offset = (clamped - 1) * pageSize;
  const rows = rawDB()
    .query(
      `SELECT c.*, u.kind AS author_kind
       FROM comments c
       LEFT JOIN users u ON u.login = c.author
       WHERE c.issue_id = ?
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(issueId, pageSize, offset) as CommentRow[];
  return { rows, page: clamped };
}

export function listCommentsSince(issueId: number, sinceISO: string): CommentRow[] {
  return rawDB()
    .query(
      `SELECT c.*, u.kind AS author_kind
       FROM comments c
       LEFT JOIN users u ON u.login = c.author
       WHERE c.issue_id = ? AND c.created_at > ?
       ORDER BY c.created_at ASC, c.id ASC`
    )
    .all(issueId, sinceISO) as CommentRow[];
}

export function listCommentsForIssue(issueId: number): CommentRow[] {
  return rawDB()
    .query(
      `SELECT c.*, u.kind AS author_kind
       FROM comments c
       LEFT JOIN users u ON u.login = c.author
       WHERE c.issue_id = ?
       ORDER BY c.created_at ASC, c.id ASC`
    )
    .all(issueId) as CommentRow[];
}

export interface CreateCommentOpts {
  createdAt?: string;
  updatedAt?: string;
}

export function postComment(
  issueId: number,
  body: string,
  author: string,
  opts: CreateCommentOpts = {}
): CommentRow {
  if (!body || !body.trim()) throw new StoreError(400, "评论不能为空");
  if (body.length > 65536) throw new StoreError(413, "评论过长（≤65536）");
  ensureUser(author);
  const createdAt = isoOr(opts.createdAt, now());
  const updatedAt = opts.updatedAt ? isoOr(opts.updatedAt, createdAt) : createdAt;
  const db = rawDB();
  return tx(db, () => {
    const info = db
      .query("INSERT INTO comments (issue_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(issueId, author, body, createdAt, updatedAt);
    db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(updatedAt, issueId);
    const row = db.query("SELECT project_id FROM issues WHERE id = ?").get(issueId) as { project_id: number };
    db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, row.project_id);
    return db.query(
      `SELECT c.*, u.kind AS author_kind
       FROM comments c LEFT JOIN users u ON u.login = c.author
       WHERE c.id = ?`
    ).get(Number(info.lastInsertRowid)) as CommentRow;
  });
}

export function getComment(commentId: number): CommentRow | null {
  const row = rawDB().query(
    `SELECT c.*, u.kind AS author_kind
     FROM comments c LEFT JOIN users u ON u.login = c.author
     WHERE c.id = ?`
  ).get(commentId) as CommentRow | undefined;
  return row ?? null;
}

export function editComment(commentId: number, body: string): CommentRow {
  const trimmed = String(body ?? "");
  if (!trimmed.trim()) throw new StoreError(400, "评论不能为空");
  if (trimmed.length > 65536) throw new StoreError(413, "评论过长（≤65536）");
  const ts = now();
  const db = rawDB();
  const info = db
    .query("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?")
    .run(trimmed, ts, commentId);
  if (info.changes === 0) throw new StoreError(404, `评论 ${commentId} 不存在`);
  return getComment(commentId)!;
}

export function deleteComment(commentId: number): void {
  const info = rawDB().query("DELETE FROM comments WHERE id = ?").run(commentId);
  if (info.changes === 0) throw new StoreError(404, `评论 ${commentId} 不存在`);
}

export interface ReactionAgg {
  comment_id: number;
  content: string;
  n: number;
}

export function listReactionsFor(commentIds: number[]): ReactionAgg[] {
  if (commentIds.length === 0) return [];
  const placeholders = commentIds.map(() => "?").join(",");
  return rawDB()
    .query(
      `SELECT comment_id, content, COUNT(*) AS n
       FROM reactions WHERE comment_id IN (${placeholders})
       GROUP BY comment_id, content`
    )
    .all(...commentIds) as ReactionAgg[];
}

export function addReaction(commentId: number, userLogin: string, content: string): void {
  if (!content || content.length > 32) throw new StoreError(400, "非法的 reaction content");
  ensureUser(userLogin);
  rawDB()
    .query("INSERT OR IGNORE INTO reactions (comment_id, user_login, content) VALUES (?, ?, ?)")
    .run(commentId, userLogin, content);
}

export function removeReaction(commentId: number, userLogin: string, content: string): void {
  rawDB()
    .query("DELETE FROM reactions WHERE comment_id = ? AND user_login = ? AND content = ?")
    .run(commentId, userLogin, content);
}

export function listLabels(projectId: number): LabelRow[] {
  return rawDB().query("SELECT * FROM labels WHERE project_id = ? ORDER BY name").all(projectId) as LabelRow[];
}

export function listLabelsForIssue(issueId: number): LabelRow[] {
  return rawDB()
    .query(
      `SELECT l.* FROM labels l
       JOIN issue_labels il ON il.label_id = l.id
       WHERE il.issue_id = ? ORDER BY l.name`
    )
    .all(issueId) as LabelRow[];
}

export function createLabel(projectId: number, name: string, color: string): LabelRow {
  name = name.trim();
  if (!name) throw new StoreError(400, "标签名不能为空");
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new StoreError(400, "颜色须为 #RRGGBB");
  const db = rawDB();
  const info = db
    .query("INSERT INTO labels (project_id, name, color) VALUES (?, ?, ?)")
    .run(projectId, name, color);
  return db.query("SELECT * FROM labels WHERE id = ?").get(Number(info.lastInsertRowid)) as LabelRow;
}

export function setIssueLabel(issueId: number, labelId: number, on: boolean): void {
  const db = rawDB();
  if (on) {
    db.query("INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)").run(issueId, labelId);
  } else {
    db.query("DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?").run(issueId, labelId);
  }
}

export function createAttachment(a: Omit<AttachmentRow, "created_at">): AttachmentRow {
  const ts = now();
  const db = rawDB();
  db
    .query(
      `INSERT INTO attachments (uuid, issue_id, filename, content_type, size, blob_path, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(a.uuid, a.issue_id, a.filename, a.content_type, a.size, a.blob_path, a.uploaded_by, ts);
  return db.query("SELECT * FROM attachments WHERE uuid = ?").get(a.uuid) as AttachmentRow;
}

export function getAttachment(uuid: string): AttachmentRow | null {
  return (rawDB().query("SELECT * FROM attachments WHERE uuid = ?").get(uuid) as AttachmentRow | null) ?? null;
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
  const db = rawDB();
  if (db.query("SELECT 1 FROM users WHERE login = ?").get(login)) {
    throw new StoreError(409, `用户 ${login} 已存在`);
  }
  const ts = now();
  const hash = await hashPassword(input.password);
  db.query(
    `INSERT INTO users (login, kind, display_name, password_hash, email, is_admin, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    login,
    input.kind ?? "human",
    input.display_name ?? null,
    hash,
    input.email ?? null,
    input.is_admin ? 1 : 0,
    input.is_active === false ? 0 : 1,
    ts,
    ts
  );
  return getUserByLogin(login)!;
}

export function getUserByLogin(login: string): UserRow | null {
  return (rawDB().query("SELECT * FROM users WHERE login = ?").get(login) as UserRow | null) ?? null;
}

export function listUsers(): UserRow[] {
  return rawDB()
    .query("SELECT * FROM users ORDER BY is_admin DESC, created_at ASC")
    .all() as UserRow[];
}

export function listAdmins(): UserRow[] {
  return rawDB().query("SELECT * FROM users WHERE is_admin = 1").all() as UserRow[];
}

export async function verifyUserPassword(login: string, password: string): Promise<UserRow | null> {
  const user = getUserByLogin(login);
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

export function updateUser(login: string, patch: UpdateUserPatch): UserRow {
  const existing = getUserByLogin(login);
  if (!existing) throw new StoreError(404, `用户 ${login} 不存在`);
  const ts = now();
  const db = rawDB();
  db.query(
    `UPDATE users SET
       email = COALESCE(?, email),
       display_name = COALESCE(?, display_name),
       is_admin = COALESCE(?, is_admin),
       is_active = COALESCE(?, is_active),
       kind = COALESCE(?, kind),
       updated_at = ?
     WHERE login = ?`
  ).run(
    patch.email !== undefined ? patch.email : null,
    patch.display_name !== undefined ? patch.display_name : null,
    patch.is_admin !== undefined ? (patch.is_admin ? 1 : 0) : null,
    patch.is_active !== undefined ? (patch.is_active ? 1 : 0) : null,
    patch.kind ?? null,
    ts,
    login
  );
  return getUserByLogin(login)!;
}

export async function setUserPassword(login: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw new StoreError(400, "密码至少 8 位");
  if (newPassword.length > 200) throw new StoreError(400, "密码过长（≤200）");
  const existing = getUserByLogin(login);
  if (!existing) throw new StoreError(404, `用户 ${login} 不存在`);
  const ts = now();
  const hash = await hashPassword(newPassword);
  rawDB()
    .query("UPDATE users SET password_hash = ?, updated_at = ? WHERE login = ?")
    .run(hash, ts, login);
}

export function countAdmins(): number {
  const row = rawDB().query("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get() as { n: number };
  return row.n;
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
  const user = getUserByLogin(login);
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
  const db = rawDB();
  const info = db
    .query(
      `INSERT INTO personal_access_tokens
         (user_login, name, salt, token_hash, token_last_eight, scopes, ip_allowlist, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(login, name, salt, tokenHash, lastEight, JSON.stringify(scopes), JSON.stringify(ipAllowlist), expiresAt, ts);
  const row = getPat(Number(info.lastInsertRowid));
  if (!row) throw new StoreError(500, "PAT 创建后无法读取");
  return { row, plaintext };
}

export function getPat(id: number): PatRow | null {
  return (rawDB().query("SELECT * FROM personal_access_tokens WHERE id = ?").get(id) as PatRow | null) ?? null;
}

export function listPatsForUser(login: string): PatRow[] {
  return rawDB()
    .query("SELECT * FROM personal_access_tokens WHERE user_login = ? ORDER BY created_at DESC")
    .all(login) as PatRow[];
}

export interface PatWithUser extends PatRow {
  user_kind: UserKind | null;
  user_is_admin: number | null;
  user_is_active: number | null;
}

export function listAllPatsWithUsers(): PatWithUser[] {
  return rawDB()
    .query(
      `SELECT p.*, u.kind AS user_kind, u.is_admin AS user_is_admin, u.is_active AS user_is_active
       FROM personal_access_tokens p
       LEFT JOIN users u ON u.login = p.user_login
       ORDER BY p.created_at DESC`
    )
    .all() as PatWithUser[];
}

export function revokePat(id: number, login: string): void {
  const row = getPat(id);
  if (!row) throw new StoreError(404, "token 不存在");
  if (row.user_login !== login) throw new StoreError(403, "无权操作他人 token");
  if (row.revoked_at) return;
  rawDB()
    .query("UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ?")
    .run(now(), id);
}

// Admin override: revoke any token regardless of owner. Caller MUST check
// ctx.user.is_admin === 1 before invoking.
export function revokePatAsAdmin(id: number): void {
  const row = getPat(id);
  if (!row) throw new StoreError(404, "token 不存在");
  if (row.revoked_at) return;
  rawDB()
    .query("UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ?")
    .run(now(), id);
}

export async function verifyPat(rawToken: string, ip?: string | null): Promise<UserRow | null> {
  if (!/^[0-9a-f]{40}$/.test(rawToken)) return null;
  const lastEight = rawToken.slice(-8);
  const candidates = rawDB()
    .query("SELECT * FROM personal_access_tokens WHERE token_last_eight = ?")
    .all(lastEight) as PatRow[];
  const nowMs = Date.now();
  for (const row of candidates) {
    if (row.revoked_at) continue;
    if (row.expires_at && Date.parse(row.expires_at) < nowMs) continue;
    const expected = sha256Hex(row.salt + rawToken);
    if (!ctEqualBuf(Buffer.from(expected, "hex"), Buffer.from(row.token_hash, "hex"))) continue;
    const allowlist = parsePatIpAllowlist(row.ip_allowlist ?? "[]");
    if (!ipAllowedBy(ip, allowlist)) continue;
    const user = getUserByLogin(row.user_login);
    if (!user || !user.is_active) return null;
    rawDB()
      .query("UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?")
      .run(now(), row.id);
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

export function listProjectMembersWithUsers(projectId: number): ProjectMemberWithUser[] {
  return rawDB()
    .query(
      `SELECT m.*, u.kind AS user_kind, u.display_name AS user_display_name, u.is_active AS user_is_active
       FROM project_members m JOIN users u ON u.login = m.user_login
       WHERE m.project_id = ?
       ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'writer' THEN 1 ELSE 2 END, m.created_at ASC`
    )
    .all(projectId) as ProjectMemberWithUser[];
}

export function listMembershipsForUser(userLogin: string): ProjectMembership[] {
  return rawDB()
    .query("SELECT * FROM project_members WHERE user_login = ? ORDER BY created_at ASC")
    .all(userLogin) as ProjectMembership[];
}

export function getProjectMembership(projectId: number, userLogin: string): ProjectMembership | null {
  return (
    (rawDB()
      .query("SELECT * FROM project_members WHERE project_id = ? AND user_login = ?")
      .get(projectId, userLogin) as ProjectMembership | null) ?? null
  );
}

// Returns the user's effective role on a project, or null. Site-admins return
// "admin" (the highest project role) so caller's canWrite/canAdmin work without
// a separate code path. Caller still needs to check user.is_admin separately
// for site-wide admin powers (user management, etc.).
export function getRoleOnProject(projectId: number, user: { login: string; is_admin: number } | null): ProjectRole | null {
  if (!user) return null;
  if (user.is_admin === 1) return "admin";
  const m = getProjectMembership(projectId, user.login);
  return m?.role ?? null;
}

export function canWriteProject(projectId: number, user: { login: string; is_admin: number } | null): boolean {
  const r = getRoleOnProject(projectId, user);
  return r !== null && ROLE_RANK[r] >= ROLE_RANK.writer;
}

export function canAdminProject(projectId: number, user: { login: string; is_admin: number } | null): boolean {
  const r = getRoleOnProject(projectId, user);
  return r === "admin";
}

export function addProjectMember(projectId: number, userLogin: string, role: ProjectRole): ProjectMembership {
  const login = userLogin.trim();
  if (!getUserByLogin(login)) throw new StoreError(404, `用户 ${login} 不存在`);
  const ts = now();
  const db = rawDB();
  db.query(
    "INSERT OR IGNORE INTO project_members (project_id, user_login, role, created_at) VALUES (?, ?, ?, ?)"
  ).run(projectId, login, role, ts);
  return getProjectMembership(projectId, login)!;
}

export function setProjectMemberRole(projectId: number, userLogin: string, role: ProjectRole): void {
  const m = getProjectMembership(projectId, userLogin);
  if (!m) throw new StoreError(404, `用户 ${userLogin} 不是该项目成员`);
  rawDB()
    .query("UPDATE project_members SET role = ? WHERE project_id = ? AND user_login = ?")
    .run(role, projectId, userLogin);
}

export function removeProjectMember(projectId: number, userLogin: string): void {
  rawDB()
    .query("DELETE FROM project_members WHERE project_id = ? AND user_login = ?")
    .run(projectId, userLogin);
}

export function countProjectAdmins(projectId: number): number {
  const row = rawDB()
    .query("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'admin'")
    .get(projectId) as { n: number };
  return row.n;
}

// Idempotent bootstrap: if the project has zero members, add `login` as admin.
// Called from project-create flow + lazily from project settings page when a
// site-admin first opens it on an old (pre-RBAC) project.
export function ensureProjectBootstrapAdmin(projectId: number, login: string): void {
  const existing = rawDB()
    .query("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?")
    .get(projectId) as { n: number };
  if (existing.n > 0) return;
  if (!getUserByLogin(login)) return;
  const ts = now();
  rawDB()
    .query("INSERT OR IGNORE INTO project_members (project_id, user_login, role, created_at) VALUES (?, ?, 'admin', ?)")
    .run(projectId, login, ts);
}
