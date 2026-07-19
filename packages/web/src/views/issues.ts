import { THEME_CSS, escapeHtml, escapeAttr, containsCI, highlightAll, tabNavHTML } from "../render/layout";
import { listAllIssues, type IssueWithMeta } from "../store";
import { relTime } from "../render/components";

export const FEED_PAGE_SIZE = 50;

function issueRow(it: IssueWithMeta, q: string): string {
  const href = `/${encodeURIComponent(it.project_owner)}/${encodeURIComponent(it.project_name)}/issues/${it.number}`;
  const title = q ? highlightAll(it.title, q) : escapeHtml(it.title);
  const projectStr = `${escapeHtml(it.project_owner)}<span style="opacity:.55">/</span>${escapeHtml(it.project_name)}`;
  return `<a class="row" href="${escapeAttr(href)}">
    <div class="row-title">${title}</div>
    <div class="row-meta">${projectStr} · #${it.number} · 💬 ${it.comment_count} · ${relTime(it.updated_at)}</div>
  </a>`;
}

export function buildIssuesFeed(
  state: "open" | "closed" | "all",
  q: string
): string {
  const issues = listAllIssues({ state, q, limit: FEED_PAGE_SIZE });
  const matchesFirst = q
    ? [...issues].sort((a, b) => Number(containsCI(b.title, q)) - Number(containsCI(a.title, q)))
    : issues;
  const openActive = state === "open" ? " active" : "";
  const closedActive = state === "closed" ? " active" : "";
  const allActive = state === "all" ? " active" : "";
  const qParam = q ? `&q=${encodeURIComponent(q)}` : "";
  const rows = matchesFirst.length
    ? matchesFirst.map((it) => issueRow(it, q)).join("")
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
.row{display:block;padding:.6rem .2rem;border-bottom:1px solid var(--border);color:var(--text)}
.row:hover{text-decoration:none;background:var(--bg-muted)}
.row-title{font-weight:500;overflow-wrap:anywhere}
.row-meta{color:var(--text-muted);font-size:12px;margin-top:.2rem}
.empty{color:var(--text-muted);text-align:center;padding:2rem;font-size:13px}
</style></head><body>
<header class="topbar"><span style="font-weight:600">📦 ework</span></header>
${tabNavHTML("issues")}
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
  <div class="rows">${rows}</div>
</main>
</body></html>`;
}
