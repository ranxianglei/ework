import { THEME_CSS, escapeHtml, escapeAttr } from "../render/layout";

export function buildIssueNew(owner: string, repo: string, writesEnabled: boolean): string {
  const listHref = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  const action = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  const body = writesEnabled
    ? `<form class="new-form" method="POST" action="${escapeAttr(action)}">
  <input type="text" name="title" placeholder="标题（必填）" required maxlength="255" class="new-title">
  <textarea name="body" rows="14" placeholder="正文（支持 Markdown）…"></textarea>
  <div class="new-actions"><a class="new-cancel" href="${escapeAttr(listHref)}">取消</a><button type="submit">创建工单</button></div>
</form>`
    : `<div class="composer-ro">只读模式：创建工单未启用（WORK_WRITES_ENABLED=false）</div>`;
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>新建工单 · ${escapeHtml(owner)}/${escapeHtml(repo)}</title>
<style>${THEME_CSS}
.new-wrap{max-width:900px;margin:0 auto;padding:.6rem 1rem}
.new-form{display:flex;flex-direction:column;gap:.6rem}
.new-title{width:100%;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.55rem .7rem;font:600 16px system-ui,sans-serif}
.new-form textarea{width:100%;resize:vertical;min-height:14em;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.6rem .7rem;font:14px/1.55 -apple-system,"PingFang SC",sans-serif}
.new-actions{display:flex;gap:.6rem;justify-content:flex-end;align-items:center}
.new-cancel{font-size:13px;color:var(--text-muted)}
.new-form button{background:var(--green);color:#fff;border:none;border-radius:8px;padding:.55rem 1.2rem;font:600 13px system-ui,sans-serif;cursor:pointer}
</style></head><body>
<header class="topbar">
  <a href="/" style="color:var(--header-text)">🏠</a>
  <span style="opacity:.5">/</span>
  <a href="${escapeAttr(listHref)}" style="color:var(--header-text)">${escapeHtml(owner)}<span style="opacity:.55">/</span>${escapeHtml(repo)}</a>
  <span class="num">新建工单</span>
</header>
<main class="new-wrap">${body}</main>
</body></html>`;
}
