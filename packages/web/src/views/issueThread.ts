import type { Config } from "../config";
import { classifyActor, renderCommentCard, type CommentView } from "../render/components";
import { renderMarkdown } from "../render/markdown";
import { renderLayout, escapeHtml } from "../render/layout";
import { runIssueActionsHook, type IssueActionContext, type IssueAction } from "../issue-actions-hook";
import { hydrateReactions } from "../reactions";
import {
  StoreError,
  countComments,
  getProject,
  getIssueWithMeta,
  listCommentsPage,
  listCommentsSince,
  getDefaultUpstreamUrl,
  listLabelsForIssue,
  getUserByLogin,
  listCachedModels,
  type CommentRow,
  type IssueWithMeta,
  type ProjectRow,
} from "../store";
import { webUrlFromClone } from "./projectUpstreams";

export const PAGE_SIZE = 30;

export interface IssueThreadPayload {
  owner: string;
  repo: string;
  number: number;
  issueTitle: string;
  state: string;
  totalComments: number;
  pageSize: number;
  currentPage: number;
  hasOlder: boolean;
  sinceISO: string;
  commentSort: "desc" | "asc";
  comments: CommentView[];
}

// Issues in a project cloned from an upstream are that upstream's issues:
// #204 in a github-mirrored repo means github.com/o/r/issues/204. Normalize
// the configured remote (https/git@/ssh/git forms) to its web base; projects
// without an upstream keep resolving refs against this ework install.
export function upstreamRefBase(project: Pick<ProjectRow, "upstream_urls">): string | null {
  const url = getDefaultUpstreamUrl(project);
  if (!url) return null;
  let m = url.match(/^git@([^:]+):(.+)$/);
  if (m?.[1] && m[2]) return `https://${m[1]}/${m[2].replace(/\.git$/, "")}`;
  m = url.match(/^(?:ssh|git):\/\/(?:git@)?([^\/]+)\/(.+)$/);
  if (m?.[1] && m[2]) return `https://${m[1]}/${m[2].replace(/\.git$/, "")}`;
  m = url.match(/^https?:\/\/([^\/]+)\/(.+)$/);
  if (m?.[1] && m[2]) return `https://${m[1]}/${m[2].replace(/\.git$/, "")}`;
  return null;
}

function toView(c: CommentRow, issuePath = ""): CommentView {
  return {
    id: c.id,
    tag: classifyActor(c.body, c.author_kind),
    model: c.model || undefined,
    login: c.author,
    avatar: "",
    created_at: c.created_at,
    body_html: renderMarkdown(c.body, "", issuePath),
    display_name: c.author_display_name ?? null,
  };
}

export async function viewsFromComments(rows: CommentRow[], issuePath = ""): Promise<CommentView[]> {
  const views = rows.map((r) => toView(r, issuePath));
  await hydrateReactions(views);
  return views;
}

export function payloadFromComments(
  issue: IssueWithMeta,
  comments: CommentView[],
  page: number,
  hasOlder: boolean,
  commentSort: "desc" | "asc"
): IssueThreadPayload {
  const last = comments.length > 0 ? comments[comments.length - 1] : null;
  const sinceISO = last?.created_at || issue.updated_at;
  return {
    owner: issue.project_owner,
    repo: issue.project_name,
    number: issue.number,
    issueTitle: issue.title,
    state: issue.state,
    totalComments: issue.comment_count,
    pageSize: PAGE_SIZE,
    currentPage: page,
    hasOlder,
    sinceISO,
    commentSort,
    comments,
  };
}

// app.js's state model is "items[0] = newest" (DESC). For DESC mode we send the server's
// ASC-ordered rows reversed; for ASC mode we send them as-is. The displayOrder is then a
// pure function of commentSort + the canonical DESC internal state.
function orderForDisplay(views: CommentView[], sort: "desc" | "asc"): CommentView[] {
  return sort === "asc" ? views : views.slice().reverse();
}

export async function buildIssueThread(
  cfg: Config,
  owner: string,
  repo: string,
  number: number,
  viewerLogin?: string,
  projectDispatchOff?: boolean
): Promise<{ html: string }> {
  const project = await getProject(owner, repo);
  if (!project) throw new StoreError(404, `项目 ${owner}/${repo} 不存在`);
  const issue = await getIssueWithMeta(project.id, number);
  if (!issue) throw new StoreError(404, `#${number} 在 ${owner}/${repo} 不存在`);

  const total = await countComments(issue.id);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = totalPages;
  const { rows } = await listCommentsPage(issue.id, currentPage, PAGE_SIZE);
  const issuePath = `${upstreamRefBase(project) ?? `/${owner}/${repo}`}/issues/${issue.number}`;
  const views = await viewsFromComments(rows, issuePath);
  const hasOlder = currentPage > 1;
  const displayViews = orderForDisplay(views, cfg.commentSort);
  const payload = payloadFromComments(issue, displayViews, currentPage, hasOlder, cfg.commentSort);

  const descriptionHtml = renderMarkdown(issue.body, "", issuePath);
  const descriptionCollapsed = issue.body.length > 1200;
  const upstreamWebUrl = (() => {
    const clone = getDefaultUpstreamUrl(project);
    if (!clone) return null;
    return webUrlFromClone(clone);
  })();
  const labels = await listLabelsForIssue(issue.id);
  const viewerUser = viewerLogin ? await getUserByLogin(viewerLogin) : null;
  const viewerIsAdmin = !!viewerUser?.is_admin;

  let customActions: IssueAction[] = [];
  let extraStatusBadges: Record<string, { cls: string; label: string }> | undefined;
  if (cfg.issueActionsHook && viewerLogin) {
    const ctx: IssueActionContext = {
      owner, repo, issueNumber: number,
      state: issue.state, aiStatus: issue.ai_status ?? "",
      viewerLogin, viewerIsAdmin,
      labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    };
    const result = await runIssueActionsHook(cfg.issueActionsHook, ctx);
    customActions = result.actions;
    extraStatusBadges = result.statusBadges;
  }

  const html = renderLayout(
    {
      title: `${issue.title} · ${owner}/${repo}#${number}`,
      issueTitle: issue.title,
      repoPath: `${owner}/${repo}`,
      issueNumber: number,
      state: issue.state,
      totalComments: issue.comment_count,
      descriptionHtml,
      descriptionCollapsed,
      writesEnabled: cfg.writesEnabled,
      operatorLogin: viewerLogin ?? cfg.operatorLogin,
      upstreamWebUrl,
      translateEnabled: !!cfg.translateUrl && cfg.translateUrl.trim() !== "",
      ttsEnabled: cfg.ttsBackends.some((b) => b.url && b.url.trim() !== ""),
      labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
      canEditLabels: cfg.writesEnabled !== false,
      aiStatus: issue.ai_status ?? "",
      projectDispatchOff: projectDispatchOff ?? false,
      viewerLogin,
      viewerIsAdmin,
      customActions,
      extraStatusBadges,
      modelSelect: cfg.writesEnabled !== false
        ? { current: issue.model ?? "", options: (await listCachedModels()).map((m) => ({ id: m.id, label: m.label })) }
        : null,
      runtimeSelect: cfg.writesEnabled !== false ? { current: issue.runtime ?? "" } : null,
    },
    safeJsonEmbed(payload),
    displayViews.map((v) => renderCommentCard(v, cfg)).join("")
  );
  return { html };
}

export interface IssuePageData {
  issue: IssueWithMeta;
  views: CommentView[];
  currentPage: number;
  hasOlder: boolean;
}

export async function fetchIssuePage(
  owner: string,
  repo: string,
  number: number,
  page: number
): Promise<IssuePageData> {
  const project = await getProject(owner, repo);
  if (!project) throw new StoreError(404, `项目 ${owner}/${repo} 不存在`);
  const issue = await getIssueWithMeta(project.id, number);
  if (!issue) throw new StoreError(404, `#${number} 不存在`);
  const { rows, page: clamped } = await listCommentsPage(issue.id, page, PAGE_SIZE);
  const views = await viewsFromComments(rows, `${upstreamRefBase(project) ?? `/${owner}/${repo}`}/issues/${issue.number}`);
  return { issue, views, currentPage: clamped, hasOlder: clamped > 1 };
}

export async function fetchIssueSince(
  owner: string,
  repo: string,
  number: number,
  sinceISO: string
): Promise<CommentView[]> {
  const project = await getProject(owner, repo);
  if (!project) throw new StoreError(404, `项目 ${owner}/${repo} 不存在`);
  const issue = await getIssueWithMeta(project.id, number);
  if (!issue) throw new StoreError(404, `#${number} 不存在`);
  const rows = await listCommentsSince(issue.id, sinceISO);
  return await viewsFromComments(rows, `${upstreamRefBase(project) ?? `/${owner}/${repo}`}/issues/${issue.number}`);
}

export function safeJsonEmbed(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function errorPage(title: string, detail: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <style>body{font-family:system-ui,sans-serif;background:#1b1b1b;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{max-width:560px;padding:2rem}h1{font-size:18px;margin:0 0 .5rem}pre{background:#0d1117;padding:.8rem;border-radius:6px;overflow:auto;white-space:pre-wrap;font-size:12.5px}</style>
  </head><body><div class="box"><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(detail)}</pre></div></body></html>`;
}
