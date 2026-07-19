import type { Config } from "../config";
import { classifyActor, renderCommentCard, type CommentView } from "../render/components";
import { renderMarkdown } from "../render/markdown";
import { renderLayout, escapeHtml } from "../render/layout";
import { hydrateReactions } from "../reactions";
import {
  StoreError,
  countComments,
  getProject,
  getIssueWithMeta,
  listCommentsPage,
  listCommentsSince,
  getDefaultUpstreamUrl,
  type CommentRow,
  type IssueWithMeta,
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

function toView(c: CommentRow): CommentView {
  return {
    id: c.id,
    tag: classifyActor(c.body, c.author_kind),
    login: c.author,
    avatar: "",
    created_at: c.created_at,
    body_html: renderMarkdown(c.body),
  };
}

export function viewsFromComments(rows: CommentRow[]): CommentView[] {
  const views = rows.map((r) => toView(r));
  hydrateReactions(views);
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

export function buildIssueThread(
  cfg: Config,
  owner: string,
  repo: string,
  number: number,
  viewerLogin?: string
): { html: string } {
  const project = getProject(owner, repo);
  if (!project) throw new StoreError(404, `项目 ${owner}/${repo} 不存在`);
  const issue = getIssueWithMeta(project.id, number);
  if (!issue) throw new StoreError(404, `#${number} 在 ${owner}/${repo} 不存在`);

  const total = countComments(issue.id);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = totalPages;
  const { rows } = listCommentsPage(issue.id, currentPage, PAGE_SIZE);
  const views = viewsFromComments(rows);
  const hasOlder = currentPage > 1;
  const displayViews = orderForDisplay(views, cfg.commentSort);
  const payload = payloadFromComments(issue, displayViews, currentPage, hasOlder, cfg.commentSort);

  const descriptionHtml = renderMarkdown(issue.body);
  const descriptionCollapsed = issue.body.length > 1200;
  const upstreamWebUrl = (() => {
    const clone = getDefaultUpstreamUrl(project);
    if (!clone) return null;
    return webUrlFromClone(clone);
  })();

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
    },
    safeJsonEmbed(payload),
    displayViews.map(renderCommentCard).join("")
  );
  return { html };
}

export interface IssuePageData {
  issue: IssueWithMeta;
  views: CommentView[];
  currentPage: number;
  hasOlder: boolean;
}

export function fetchIssuePage(
  owner: string,
  repo: string,
  number: number,
  page: number
): IssuePageData {
  const project = getProject(owner, repo);
  if (!project) throw new StoreError(404, `项目 ${owner}/${repo} 不存在`);
  const issue = getIssueWithMeta(project.id, number);
  if (!issue) throw new StoreError(404, `#${number} 不存在`);
  const { rows, page: clamped } = listCommentsPage(issue.id, page, PAGE_SIZE);
  const views = viewsFromComments(rows);
  return { issue, views, currentPage: clamped, hasOlder: clamped > 1 };
}

export function fetchIssueSince(
  owner: string,
  repo: string,
  number: number,
  sinceISO: string
): CommentView[] {
  const project = getProject(owner, repo);
  if (!project) throw new StoreError(404, `项目 ${owner}/${repo} 不存在`);
  const issue = getIssueWithMeta(project.id, number);
  if (!issue) throw new StoreError(404, `#${number} 不存在`);
  const rows = listCommentsSince(issue.id, sinceISO);
  return viewsFromComments(rows);
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
