import { THEME_CSS, escapeHtml, escapeAttr, containsCI, highlightAll, tabNavHTML, aiStatusBadge } from "../render/layout";
import { BUILD_ID } from "../build";
import { listAllIssues, listLabelsForIssues, type IssueWithMeta, type LabelRow } from "../store";
import { relTime } from "../render/components";

export const FEED_PAGE_SIZE = 50;

function labelChip(label: LabelRow, owner: string, repo: string, state: string): string {
  const href = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&label=${encodeURIComponent(label.name)}`;
  return `<span class="issue-label" data-href="${escapeAttr(href)}" style="--lc:${escapeAttr(label.color)}" title="${escapeAttr(label.description ?? "")}">${escapeHtml(label.name)}</span>`;
}

function issueRow(it: IssueWithMeta, q: string, state: string, labels: LabelRow[]): string {
  const href = `/${encodeURIComponent(it.project_owner)}/${encodeURIComponent(it.project_name)}/issues/${it.number}`;
  const title = q ? highlightAll(it.title, q) : escapeHtml(it.title);
  const projectStr = `${escapeHtml(it.project_owner)}<span style="opacity:.55">/</span>${escapeHtml(it.project_name)}`;
  const chips = labels.length
    ? `<span class="row-labels">${labels.map((l) => labelChip(l, it.project_owner, it.project_name, state)).join("")}</span>`
    : "";
  const aiBadge = aiStatusBadge(it.ai_status);
  return `<a class="row" href="${escapeAttr(href)}">
    <div class="row-title">${title}${chips}</div>
    <div class="row-meta">${projectStr} · #${it.number} · 💬 ${it.comment_count} · ${relTime(it.updated_at)}${aiBadge ? ` · ${aiBadge}` : ""}</div>
  </a>`;
}

export async function buildIssuesFeed(
  state: "open" | "closed" | "all",
  q: string,
  label: string = "",
  viewer?: { login: string; is_admin: number } | null,
): Promise<string> {
  const issues = await listAllIssues({
    state, q, label, limit: FEED_PAGE_SIZE,
    viewerLogin: viewer?.login,
    viewerIsAdmin: viewer?.is_admin === 1,
  });
  const labelMap = await listLabelsForIssues(issues.map((it) => it.id));
  const matchesFirst = q
    ? [...issues].sort((a, b) => Number(containsCI(b.title, q)) - Number(containsCI(a.title, q)))
    : issues;
  const openActive = state === "open" ? " active" : "";
  const closedActive = state === "closed" ? " active" : "";
  const allActive = state === "all" ? " active" : "";
  const qParam = q ? `&q=${encodeURIComponent(q)}` : "";
  const labelFilterHint = label
    ? `<div class="label-filter">标签: <strong>${escapeHtml(label)}</strong></div>`
    : "";
  const rows = matchesFirst.length
    ? matchesFirst.map((it) => issueRow(it, q, state, labelMap.get(it.id) ?? [])).join("")
    : `<div class="empty">暂无工单</div>`;
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>Issues · 全部</title>
<style>${THEME_CSS}
.feed-wrap{max-width:900px;margin:0 auto;padding:.4rem 1rem 3rem}
.search{margin:.4rem 0 .8rem;display:flex;gap:.4rem}
.search input{flex:1;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.5rem .7rem;font:inherit}
.tabs-sub{display:flex;gap:.3rem;margin-bottom:.6rem}
.tabs-sub a{padding:.3rem .8rem;border-radius:6px;font-size:13px;color:var(--text-muted)}
.tabs-sub a.active{background:var(--bg-muted);color:var(--text);font-weight:600}
.row{display:block;padding:.6rem .2rem;border-bottom:1px solid var(--border);color:var(--text);text-decoration:none}
.row:hover{text-decoration:none;background:var(--bg-muted)}
.row-title{font-weight:500;overflow-wrap:anywhere}
.row-meta{color:var(--text-muted);font-size:12px;margin-top:.2rem}
.empty{color:var(--text-muted);text-align:center;padding:2rem;font-size:13px}
  .row-labels{display:inline;margin-left:.3rem}
  .issue-label{display:inline;color:var(--text-muted);font-size:11px;text-decoration:none;margin-left:.35rem;white-space:nowrap;cursor:pointer}
  .issue-label::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--lc);margin-right:2px;vertical-align:middle}
  .issue-label:hover{color:var(--text);text-decoration:underline}
.label-filter{font-size:13px;color:var(--text-muted);margin-bottom:.4rem}
.label-filter strong{color:var(--text)}
</style></head><body>
<header class="topbar"><a href="/" title="ework 主页" style="color:var(--header-text)">🏠</a></header>
${tabNavHTML("issues", viewer ? { login: viewer.login, is_admin: viewer.is_admin } : undefined)}
<main class="feed-wrap">
  <form class="search" method="GET" action="/issues">
    <input type="text" name="q" value="${escapeAttr(q)}" placeholder="搜索全部项目的标题/正文/项目名…">
    <input type="hidden" name="state" value="${state}">
    <button type="submit" style="background:var(--bg-muted);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.4rem .8rem;font-size:13px">搜索</button>
  </form>
  <div class="tabs-sub">
    <a class="tab${openActive}" href="/issues?state=open${qParam}">Open</a>
    <a class="tab${closedActive}" href="/issues?state=closed${qParam}">Closed</a>
    <a class="tab${allActive}" href="/issues?state=all${qParam}">All</a>
  </div>
  ${labelFilterHint}
  <div class="rows">${rows}</div>
<script src="/static/row-nav.js?v=${BUILD_ID}" defer></script>
</main>
</body></html>`;
}
