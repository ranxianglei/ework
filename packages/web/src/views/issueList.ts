import { THEME_CSS, escapeHtml, escapeAttr, containsCI, highlightAll, tabNavHTML } from "../render/layout";
import { getProject, listIssues, listLabelsForIssues, type IssueWithMeta, type LabelRow } from "../store";
import { relTime } from "../render/components";

export const LIST_PAGE_SIZE = 50;

function labelChip(label: LabelRow, owner: string, repo: string, state: string): string {
  const href = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&label=${encodeURIComponent(label.name)}`;
  return `<a class="issue-label" href="${escapeAttr(href)}" style="background:${escapeAttr(label.color)}" title="${escapeAttr(label.description ?? "")}">${escapeHtml(label.name)}</a>`;
}

function issueRow(
  it: IssueWithMeta,
  owner: string,
  repo: string,
  q: string,
  state: string,
  labels: LabelRow[],
): string {
  const href = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${it.number}`;
  const title = q ? highlightAll(it.title, q) : escapeHtml(it.title);
  const chips = labels.length
    ? `<div class="row-labels">${labels.map((l) => labelChip(l, owner, repo, state)).join("")}</div>`
    : "";
  return `<a class="row" href="${escapeAttr(href)}">
    <div class="row-title">${title}</div>
    ${chips}
    <div class="row-meta">#${it.number} · 💬 ${it.comment_count} · ${relTime(it.updated_at)}</div>
  </a>`;
}

export async function buildIssueList(
  owner: string,
  repo: string,
  state: "open" | "closed" | "all",
  writesEnabled: boolean,
  q: string,
  label: string = "",
): Promise<string> {
  const project = await getProject(owner, repo);
  if (!project) {
    return notFoundProject(owner, repo);
  }
  const issues = await listIssues(project.id, { state, q, label, limit: LIST_PAGE_SIZE });
  const labelMap = await listLabelsForIssues(issues.map((it) => it.id));
  const matchesFirst = q
    ? [...issues].sort((a, b) => Number(containsCI(b.title, q)) - Number(containsCI(a.title, q)))
    : issues;
  const openActive = state === "open" ? " active" : "";
  const closedActive = state === "closed" ? " active" : "";
  const allActive = state === "all" ? " active" : "";
  const qParam = q ? `&q=${encodeURIComponent(q)}` : "";
  const labelParam = label ? `&label=${encodeURIComponent(label)}` : "";
  const labelFilterHint = label
    ? `<div class="label-filter">标签: <strong>${escapeHtml(label)}</strong> <a href="/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}${qParam}" class="label-clear">✕</a></div>`
    : "";
  const newBtn = writesEnabled
    ? `<a class="new-btn" href="/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/new">+ 新建</a>`
    : "";
  const rows = matchesFirst.length
    ? matchesFirst.map((it) => issueRow(it, owner, repo, q, state, labelMap.get(it.id) ?? [])).join("")
    : `<div class="empty">暂无工单</div>`;
  const searchVal = escapeAttr(q);
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(owner)}/${escapeHtml(repo)} · Issues</title>
<style>${THEME_CSS}
.list-wrap{max-width:900px;margin:0 auto;padding:.4rem 1rem 3rem}
.search{margin:.4rem 0 .8rem;display:flex;gap:.4rem}
.search input{flex:1;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.5rem .7rem;font:inherit}
.tabs-sub{display:flex;gap:.3rem;margin-bottom:.6rem;align-items:center}
.tabs-sub a{padding:.3rem .8rem;border-radius:6px;font-size:13px;color:var(--text-muted)}
.tabs-sub a.active{background:var(--bg-muted);color:var(--text);font-weight:600}
.new-btn{margin-left:auto;background:var(--green);color:#fff;padding:.3rem .8rem;border-radius:6px;font-size:13px;font-weight:600}
.row{display:block;padding:.6rem .2rem;border-bottom:1px solid var(--border);color:var(--text)}
.row:hover{text-decoration:none;background:var(--bg-muted)}
.row-title{font-weight:500;overflow-wrap:anywhere}
.row-meta{color:var(--text-muted);font-size:12px;margin-top:.2rem}
.empty{color:var(--text-muted);text-align:center;padding:2rem;font-size:13px}
.row-labels{display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.2rem}
.issue-label{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:500;color:#fff;text-decoration:none;line-height:18px;white-space:nowrap}
.issue-label:hover{opacity:.85;text-decoration:none}
.label-filter{font-size:13px;color:var(--text-muted);margin-bottom:.4rem}
.label-filter strong{color:var(--text)}
.label-clear{color:var(--text-muted);text-decoration:none;margin-left:.3rem}
.label-clear:hover{color:var(--text)}
</style></head><body>
<header class="topbar">
  <a href="/" style="color:var(--header-text)">🏠</a>
  <span style="opacity:.5">/</span>
  <a href="/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues" style="color:var(--header-text)">${escapeHtml(owner)}<span style="opacity:.55">/</span>${escapeHtml(repo)}</a>
</header>
${tabNavHTML("issues")}
<main class="list-wrap">
  <form class="search" method="GET" action="/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues">
    <input type="text" name="q" value="${searchVal}" placeholder="搜索标题/正文…">
    <input type="hidden" name="state" value="${state}">
    <button type="submit" class="new-btn" style="background:var(--bg-muted);color:var(--text)">搜索</button>
  </form>
  <div class="tabs-sub">
    <a class="tab${openActive}" href="/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open${qParam}${labelParam}">Open</a>
    <a class="tab${closedActive}" href="/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=closed${qParam}${labelParam}">Closed</a>
    <a class="tab${allActive}" href="/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=all${qParam}${labelParam}">All</a>
    ${newBtn}
  </div>
  ${labelFilterHint}
  <div class="rows">${rows}</div>
</main>
</body></html>`;
}

function notFoundProject(owner: string, repo: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>项目不存在</title>
  <style>body{font-family:system-ui,sans-serif;background:#1b1b1b;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style></head>
  <body><div style="text-align:center"><h2>项目 ${escapeHtml(owner)}/${escapeHtml(repo)} 不存在</h2>
  <p style="color:#9a9a9a"><a href="/projects" style="color:var(--accent)">← 返回项目列表</a></p></div></body></html>`;
}
