// Gitea-compatible REST shim under /api/v1/*.
//
// Rationale: ework reuses Gitea's
// GiteaClient which speaks Gitea's REST protocol verbatim. Rather than
// rewrite the daemon to talk ework's native /api/* shape (and re-translate
// all the response fields), we expose Gitea-shaped endpoints so the daemon
// can be repointed at ework just by changing GITEA_URL. The webhook payload
// builders in webhooks.ts are reused here so consumers see ONE consistent
// Gitea-compatible contract across push (webhook) and pull (REST).
//
// Coverage matches Gitea's actual surface (10 endpoints identified in the
// bg audit) plus a few cheap stubs (/version, /user, /repos/:o/:r) that
// Gitea clients commonly hit during connection bootstrap.

import { getDB, getConfigAll } from "./db";
import {
  StoreError,
  getProject,
  getIssue,
  getIssueById,
  getComment,
  postComment,
  editComment,
  deleteComment,
  editIssue,
  createIssue,
  countComments,
  listCommentsForIssue,
  listAllIssues,
  addReaction,
  removeReaction,
  listReactionsFor,
  canWriteProject,
  canReadProject,
  ensureUser,
  getUserByLogin,
  type UserRow,
  updateCommentModel,
} from "./store";
import {
  buildUser,
  buildIssuePayload,
  buildCommentPayload,
  buildRepository,
  emitIssueEvent,
  emitCommentEvent,
} from "./webhooks";

const ROUTES = {
  version: /^\/api\/v1\/version$/,
  currentUser: /^\/api\/v1\/user$/,
  // Owner/repo char class must match store.ts project-create validator
  // (`/^[A-Za-z0-9_.-]+$/`). Loosening here without loosening there (or vice
  // versa) creates a routing black hole where valid projects 404 in the shim.
  repoShow: /^\/api\/v1\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/,
  issuesCollection: /^\/api\/v1\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues$/,
  issueSearch: /^\/api\/v1\/repos\/issues\/search$/,
  issueShow: /^\/api\/v1\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)$/,
  issueComments: /^\/api\/v1\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)\/comments$/,
  issueReactions: /^\/api\/v1\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)\/reactions$/,
  commentShow: /^\/api\/v1\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/comments\/(\d+)$/,
  commentReactions: /^\/api\/v1\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/comments\/(\d+)\/reactions$/,
  commentModel: /^\/api\/v1\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/comments\/(\d+)\/model$/,
} as const;

export interface GiteaApiResult {
  status: number;
  body: unknown;
}

function giteaError(status: number, message: string): GiteaApiResult {
  return { status, body: { message, url: "/api/v1/swagger" } };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const txt = await req.text();
    if (!txt) return {};
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new StoreError(400, "invalid JSON body");
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asIssueState(v: unknown): "open" | "closed" | undefined {
  return v === "open" || v === "closed" ? v : undefined;
}

function asContent(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 32) throw new StoreError(400, "reaction content 过长（≤32）");
  return trimmed;
}

async function canSudo(u: UserRow): Promise<boolean> {
  const cfg = await getConfigAll();
  const allow = (cfg["sudoLogins"] ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
  return allow.includes(u.login);
}

export async function handleGiteaApi(
  req: Request,
  url: URL,
  ctx: { user: UserRow | null }
): Promise<GiteaApiResult | null> {
  const path = url.pathname;
  if (!path.startsWith("/api/v1/")) return null;
  const origin = new URL(req.url).origin;
  const caller = ctx.user;
  if (!caller) return giteaError(401, "requires authentication");

  // ─── Sudo: Gitea convention for impersonation ───
  // Allows bridge/integration processes to post on behalf of real users.
  // Permission gated by config KV `sudoLogins` whitelist (not is_admin — bridges
  // should not be admins). Sudo-Kind header controls kind for first-creation
  // only; existing users' kind is never changed via sudo.
  const sudoLoginRaw = req.headers.get("Sudo") ?? url.searchParams.get("sudo");
  const sudoLogin = sudoLoginRaw?.trim() || null;
  let user: UserRow = caller;
  if (sudoLogin && sudoLogin !== caller.login) {
    if (!(await canSudo(caller))) return giteaError(403, "sudo requires permission");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(sudoLogin)) return giteaError(400, "invalid sudo login");
    const sudoKindRaw = req.headers.get("Sudo-Kind")?.trim();
    const sudoDisplayName = req.headers.get("Sudo-Display-Name")?.trim() || null;
    const existing = await getUserByLogin(sudoLogin);
    if (existing) {
      user = existing;
    } else {
      const kind = sudoKindRaw === "bot" || sudoKindRaw === "system" ? sudoKindRaw : "human";
      user = await ensureUser(sudoLogin, kind, sudoDisplayName);
    }
    if (!user.is_active) return giteaError(403, "sudo target inactive");
  }

  if (ROUTES.version.test(path) && req.method === "GET") {
    return { status: 200, body: { version: "1.22.0" } };
  }

  if (ROUTES.currentUser.test(path) && req.method === "GET") {
    return { status: 200, body: buildUser(user.login, origin) };
  }

  // issueSearch must be matched BEFORE repoShow: the path /repos/issues/search
  // would otherwise match repoShow's owner=issues, repo=search capture groups.
  let m = path.match(ROUTES.issueSearch);
  if (m && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const state = (url.searchParams.get("state") ?? "open") as "open" | "closed" | "all";
    const limitRaw = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    try {
      const rows = await listAllIssues({ q, state, limit, viewerLogin: user.login, viewerIsAdmin: caller.is_admin === 1 && user.is_admin === 1 });
      const body = [];
      for (const row of rows) {
        const project = await getProject(row.project_owner, row.project_name);
        if (!project) continue;
        body.push({
          ...buildIssuePayload(row, project, row.comment_count ?? 0, origin),
          repository: buildRepository(project, origin),
        });
      }
      return { status: 200, body };
    } catch (e) {
      return giteaError(e instanceof StoreError ? e.status : 500, e instanceof Error ? e.message : "error");
    }
  }

  m = path.match(ROUTES.repoShow);
  if (m && req.method === "GET") {
    const [, owner, repo] = m;
    if (!(owner && repo)) return giteaError(404, "not found");
    const project = await getProject(owner, repo);
    if (!project) return giteaError(404, "repository not found");
    if (!(await canReadProject(project.id, user))) return giteaError(404, "repository not found");
    return { status: 200, body: buildRepository(project, origin) };
  }

  m = path.match(ROUTES.issuesCollection);
  if (m && req.method === "POST") {
    const [, owner, repo] = m;
    if (!(owner && repo)) return giteaError(404, "not found");
    try {
      const project = await getProject(owner, repo);
      if (!project) return giteaError(404, "repository not found");
      if (!(await canWriteProject(project.id, user))) return giteaError(403, "requires writer role");
      const body = await readJson(req);
      const title = asString(body.title);
      if (!title) return giteaError(400, "title required");
      const text = asString(body.body) ?? "";
      const created = await createIssue(project.id, title, text, user.login, {
        createdAt: asString(body.created_at),
        updatedAt: asString(body.updated_at),
        state: asIssueState(body.state) ?? "open",
        closedAt: asString(body.closed_at) || undefined,
        model: asString(body.model) || undefined,
      });
      void emitIssueEvent(project.id, created.id, "opened", origin);
      if (created.state === "closed") {
        void emitIssueEvent(project.id, created.id, "closed", origin);
      }
      return { status: 201, body: buildIssuePayload(created, project, 0, origin) };
    } catch (e) {
      return giteaError(e instanceof StoreError ? e.status : 500, e instanceof Error ? e.message : "error");
    }
  }

  m = path.match(ROUTES.issueShow);
  if (m) {
    const [, owner, repo, numStr] = m;
    if (!(owner && repo && numStr)) return giteaError(404, "not found");
    const number = Number(numStr);
    try {
      const project = await getProject(owner, repo);
      if (!project) return giteaError(404, "repository not found");
      const issue = await getIssue(project.id, number);
      if (!issue) return giteaError(404, "issue not found");

      if (req.method === "GET") {
        if (!(await canReadProject(project.id, user))) return giteaError(404, "repository not found");
        return { status: 200, body: buildIssuePayload(issue, project, await countComments(issue.id), origin) };
      }
      if (req.method === "PATCH") {
        if (!(await canWriteProject(project.id, user))) return giteaError(403, "requires writer role");
        const body = await readJson(req);
        const before = issue.state;
        await editIssue(issue.id, {
          title: asString(body.title),
          body: asString(body.body),
          state: asIssueState(body.state),
          closedAt: asString(body.closed_at) || undefined,
          updatedAt: asString(body.updated_at),
        });
        const after = await getIssueById(issue.id);
        if (!after) return giteaError(404, "issue vanished mid-edit");
        if (before === "open" && after.state === "closed") {
          void emitIssueEvent(project.id, after.id, "closed", origin);
        } else if (before === "closed" && after.state === "open") {
          void emitIssueEvent(project.id, after.id, "reopened", origin);
        }
        return { status: 200, body: buildIssuePayload(after, project, await countComments(after.id), origin) };
      }
      return giteaError(405, `method ${req.method} not allowed`);
    } catch (e) {
      return giteaError(e instanceof StoreError ? e.status : 500, e instanceof Error ? e.message : "error");
    }
  }

  m = path.match(ROUTES.issueComments);
  if (m) {
    const [, owner, repo, numStr] = m;
    if (!(owner && repo && numStr)) return giteaError(404, "not found");
    const number = Number(numStr);
    try {
      const project = await getProject(owner, repo);
      if (!project) return giteaError(404, "repository not found");
      const issue = await getIssue(project.id, number);
      if (!issue) return giteaError(404, "issue not found");

      if (req.method === "GET") {
        if (!(await canReadProject(project.id, user))) return giteaError(404, "repository not found");
        const comments = await listCommentsForIssue(issue.id);
        return {
          status: 200,
          body: comments.map((c) => buildCommentPayload(issue, c, project, origin)),
        };
      }
      if (req.method === "POST") {
        if (!(await canWriteProject(project.id, user))) return giteaError(403, "requires writer role");
        const body = await readJson(req);
        const text = asString(body.body);
        if (text === undefined) return giteaError(400, "body required");
        const created = await postComment(issue.id, text, user.login, {
          createdAt: asString(body.created_at),
          updatedAt: asString(body.updated_at),
        });
        void emitCommentEvent(project.id, issue.id, created.id, origin);
        return { status: 201, body: buildCommentPayload(issue, created, project, origin) };
      }
      return giteaError(405, `method ${req.method} not allowed`);
    } catch (e) {
      return giteaError(e instanceof StoreError ? e.status : 500, e instanceof Error ? e.message : "error");
    }
  }

  // /issues/:n/reactions — stub. Some daemons use these for the 🔄 picked-up marker
  // on issues. ework has no issue-reactions table today (only comment reactions).
  // Returning empty list keeps the daemon's main loop (comment + close) running
  // without crashing. Add a real issue_reactions table in Phase 4.x if the
  // picked-up marker turns out to matter operationally.
  m = path.match(ROUTES.issueReactions);
  if (m && (req.method === "POST" || req.method === "DELETE" || req.method === "GET")) {
    return { status: 200, body: [] };
  }

  m = path.match(ROUTES.commentShow);
  if (m) {
    const [, owner, repo, cidStr] = m;
    if (!(owner && repo && cidStr)) return giteaError(404, "not found");
    const cid = Number(cidStr);
    try {
      const project = await getProject(owner, repo);
      if (!project) return giteaError(404, "repository not found");
      if (!(await canReadProject(project.id, user))) return giteaError(404, "repository not found");

      if (req.method === "GET") {
        const comment = await getComment(cid);
        if (!comment) return giteaError(404, "comment not found");
        const issue = await getIssueById(comment.issue_id);
        if (!issue) return giteaError(404, "issue not found");
        return { status: 200, body: buildCommentPayload(issue, comment, project, origin) };
      }
      if (req.method === "PATCH") {
        if (!(await canWriteProject(project.id, user))) return giteaError(403, "requires writer role");
        const body = await readJson(req);
        const text = asString(body.body);
        if (text === undefined) return giteaError(400, "body required");
        const updated = await editComment(cid, text);
        const issue = await getIssueById(updated.issue_id);
        if (!issue) return giteaError(404, "issue not found");
        return { status: 200, body: buildCommentPayload(issue, updated, project, origin) };
      }
      if (req.method === "DELETE") {
        if (!(await canWriteProject(project.id, user))) return giteaError(403, "requires writer role");
        await deleteComment(cid);
        return { status: 204, body: null };
      }
      return giteaError(405, `method ${req.method} not allowed`);
    } catch (e) {
      return giteaError(e instanceof StoreError ? e.status : 500, e instanceof Error ? e.message : "error");
    }
  }

  m = path.match(ROUTES.commentModel);
  if (m) {
    const [, owner, repo, cidStr] = m;
    if (!(owner && repo && cidStr)) return giteaError(404, "not found");
    const cid = Number(cidStr);
    try {
      const project = await getProject(owner, repo);
      if (!project) return giteaError(404, "repository not found");
      if (!(await canWriteProject(project.id, user))) return giteaError(403, "requires writer role");
      const body = (await readJson(req).catch(() => ({}))) as { model?: unknown };
      const model = typeof body.model === "string" ? body.model.trim() : "";
      await updateCommentModel(cid, model);
      return { status: 200, body: { ok: true, model } };
    } catch (e) {
      return giteaError(500, e instanceof Error ? e.message : String(e));
    }
  }

  m = path.match(ROUTES.commentReactions);
  if (m) {
    const [, owner, repo, cidStr] = m;
    if (!(owner && repo && cidStr)) return giteaError(404, "not found");
    const cid = Number(cidStr);
    try {
      const project = await getProject(owner, repo);
      if (!project) return giteaError(404, "repository not found");
      if (!(await canReadProject(project.id, user))) return giteaError(404, "repository not found");

      if (req.method === "GET") {
        return { status: 200, body: await reactionsList(cid, origin) };
      }
      if (req.method === "POST" || req.method === "DELETE") {
        if (!(await canWriteProject(project.id, user))) return giteaError(403, "requires writer role");
        const body = await readJson(req);
        const content = asContent(body.content);
        if (content === undefined) return giteaError(400, "content required");
        if (req.method === "POST") await addReaction(cid, user.login, content);
        else await removeReaction(cid, user.login, content);
        return { status: 200, body: await reactionsList(cid, origin) };
      }
      return giteaError(405, `method ${req.method} not allowed`);
    } catch (e) {
      return giteaError(e instanceof StoreError ? e.status : 500, e instanceof Error ? e.message : "error");
    }
  }

  return giteaError(404, "endpoint not implemented in ework shim");
}

// Gitea returns a per-user list, not the aggregated counts ework's store
// keeps. The "reaction" key is Gitea's wire name; we also emit "content"
// for self-consistency with ework's schema.
async function reactionsList(commentId: number, origin: string): Promise<{ user: ReturnType<typeof buildUser>; reaction: string; content: string }[]> {
  const aggs = await listReactionsFor([commentId]);
  if (aggs.length === 0) return [];
  const rows = await getDB().all<{ user_login: string; content: string }>(
    "SELECT user_login, content FROM {{reactions}} WHERE comment_id = ? ORDER BY rowid",
    [commentId]
  );
  return rows.map((r) => ({
    user: buildUser(r.user_login, origin),
    reaction: r.content,
    content: r.content,
  }));
}
