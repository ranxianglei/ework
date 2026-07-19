import { BUILD_ID } from "../build";
export interface LayoutProps {
  title: string;
  issueTitle: string;
  repoPath: string;
  issueNumber: number;
  state: string;
  totalComments: number;
  descriptionHtml: string;
  descriptionCollapsed: boolean;
  bodyClass?: string;
  writesEnabled?: boolean;
  operatorLogin?: string;
  upstreamWebUrl?: string | null;
  translateEnabled?: boolean;
  ttsEnabled?: boolean;
}

export const THEME_CSS = `
:root{
  --bg:#ffffff;--bg-muted:#f5f5f5;--bg-elev:#ffffff;--border:#e1e4e8;--text:#24292e;--text-muted:#6a737d;
  --accent:#2185d0;--green:#2da44e;--header-bg:#2c3338;--header-text:#e6edf3;
  --human:#0969da;--bot:#2da44e;--system:#8957e5;--code-bg:#f6f8fa;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#1b1b1b;--bg-muted:#232323;--bg-elev:#262626;--border:#373737;--text:#e6e6e6;--text-muted:#9a9a9a;
  --accent:#4493f8;--green:#3fb950;--header-bg:#161616;--header-text:#e6edf3;
  --human:#4493f8;--bot:#3fb950;--system:#bc8cff;--code-bg:#0d1117;
}}
*{box-sizing:border-box}
mark.hl{background:#ffe082;color:#b71c1c;font-weight:700;border-radius:2px;padding:0 2px}
@media (prefers-color-scheme:dark){mark.hl{background:#5d4037;color:#ff8a80}}
.fsnip{color:var(--text-muted);font-size:13px;margin-top:.2rem;line-height:1.4;overflow-wrap:anywhere}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.topbar{background:var(--header-bg);color:var(--header-text);padding:.55rem 1rem;display:flex;align-items:center;gap:.6rem;font-size:13px;flex-wrap:wrap}
header.topbar .repo{opacity:.85}
header.topbar .num{opacity:.7}
.state-badge{font-size:12px;padding:.1rem .5rem;border-radius:10px;font-weight:600}
.state-open{background:#1a7f37;color:#fff}.state-closed{background:#8250df;color:#fff}
.meta-bar{display:flex;flex-direction:column;gap:.3rem;padding:.7rem max(1rem,calc((100% - 900px)/2));border-bottom:1px solid var(--border);background:var(--bg-muted)}
.meta-bar h1{font-size:18px;margin:0;font-weight:600;overflow-wrap:anywhere;word-break:break-word}
.meta-status{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--text-muted)}
.count{color:var(--text-muted);font-size:12px;white-space:nowrap}
#list{padding:.5rem .6rem 4rem;max-width:900px;margin:0 auto}
.sentinel{height:1px}
.loader,#loadOlderWrap{display:flex;justify-content:center;padding:1rem;color:var(--text-muted);font-size:13px}
#loadOlder{background:var(--bg-elev);border:1px solid var(--border);border-radius:6px;padding:.5rem 1.2rem;color:var(--text);cursor:pointer;font-size:13px}
#loadOlder:hover{border-color:var(--accent)}
.item{padding:.7rem .2rem;position:relative}
.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:8px;overflow:hidden;min-width:0}
.card-h{display:flex;align-items:center;gap:.5rem;padding:.4rem .7rem;background:var(--bg-muted);font-size:13px;flex-wrap:wrap}
.card-h .who{font-weight:600;color:var(--text)}
.tag{font-size:11px;font-weight:600;padding:.05rem .4rem;border-radius:4px;line-height:1.5}
.tag-human{background:color-mix(in srgb,var(--human) 18%,transparent);color:var(--human)}
.tag-bot{background:color-mix(in srgb,var(--bot) 18%,transparent);color:var(--bot)}
.tag-system{background:color-mix(in srgb,var(--system) 18%,transparent);color:var(--system)}
.when{color:var(--text-muted);font-size:12px}
.clink{background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-muted);padding:0 .2rem;opacity:.6;line-height:1.5}
.clink:hover{opacity:1;color:var(--accent)}
.clink.done{color:var(--green);opacity:1}
.card-actions{margin-left:auto;display:inline-flex;gap:.3rem;align-items:center}
.ttsbtn{background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-muted);padding:0 .2rem;opacity:.6;line-height:1.5}
.ttsbtn:hover{opacity:1;color:var(--accent)}
.ttsbtn.playing{color:var(--green);opacity:1}
.ttsstop{background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-muted);padding:0 .2rem;line-height:1.5}
.ttsstop:hover{color:var(--accent)}
.cbtn,.tbtn{background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-muted);padding:0 .2rem;opacity:.6;line-height:1.5}
.cbtn:hover,.tbtn:hover{opacity:1;color:var(--accent)}
.clink:hover{opacity:1;color:var(--accent)}
.clink.done{color:var(--green);opacity:1}
.rx{display:inline-flex;gap:.3rem;align-items:center;margin-left:.2rem;flex-wrap:wrap}
.rxc{display:inline-flex;align-items:center;gap:.15rem;font-size:12px;background:var(--bg-muted);border:1px solid var(--border);border-radius:10px;padding:0 .4rem;line-height:1.6}
.rxn{font-size:11px;color:var(--text-muted)}
.card-b{padding:.6rem .8rem;overflow-wrap:anywhere;word-break:break-word}
.card-b pre{background:var(--code-bg);padding:.7rem;border-radius:6px;overflow:auto;font-size:12.5px}
.card-b code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;font-size:12.5px}
.card-b pre code{background:none;padding:0}
.card-b img,.desc img{max-width:100%;height:auto}
.card-b table,.desc table{border-collapse:collapse;margin:.6rem 0;font-size:13px}
.card-b th,.card-b td,.desc th,.desc td{border:1px solid var(--border);padding:.35rem .55rem;text-align:left;vertical-align:top}
.card-b th,.desc th{background:var(--bg-muted);font-weight:600}
.item-system .card{border-style:dashed;opacity:.86}
.item-system .card-b{font-size:13px;color:var(--text-muted)}
.hidden{display:none!important}
.new-marker{background:color-mix(in srgb,var(--green) 12%,transparent);transition:background 4s ease}
.composer{display:flex;flex-direction:column;gap:.5rem;padding:.7rem 1rem;max-width:900px;margin:0 auto .9rem}
.composer textarea{width:100%;resize:vertical;min-height:6em;max-height:18em;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.6rem .7rem;font:inherit;font-size:15px;line-height:1.5}
.composer .submit-col{display:flex;flex-direction:row;gap:.5rem;justify-content:flex-end;align-items:center}
.composer .upload-btn{background:var(--bg-muted);color:var(--text-muted);border:1px solid var(--border);border-radius:8px;padding:.4rem .6rem;font-size:18px;line-height:1;cursor:pointer;position:relative;overflow:hidden}
.composer .upload-btn input{position:absolute;inset:0;opacity:0;cursor:pointer}
.composer textarea:focus{outline:none;border-color:var(--accent)}
.composer button{flex-shrink:0;background:var(--green);color:#fff;border:none;border-radius:8px;padding:.55rem 1.1rem;font:600 13px system-ui,sans-serif;cursor:pointer}
.composer button:disabled{opacity:.5;cursor:default}
.composer .btn-close{background:var(--bg-muted);color:var(--text);border:1px solid var(--border);margin-right:auto}
.composer .btn-close:hover{border-color:var(--accent)}
.composer .btn-close.armed{background:#d23f31;color:#fff;border-color:#d23f31}
.composer-ro{max-width:900px;margin:0 auto .9rem;padding:.7rem 1rem;color:var(--text-muted);font-size:13px;text-align:center;border:1px dashed var(--border);border-radius:8px}
.tabs{display:flex;gap:.4rem;padding:.6rem 1rem;border-bottom:1px solid var(--border);max-width:900px;margin:0 auto}
.tab{padding:.4rem 1rem;border-radius:6px;font-size:14px;color:var(--text-muted)}
.tab.active{background:var(--bg-muted);color:var(--text);font-weight:600}
.desc-wrap{max-width:900px;margin:0 auto;padding:.5rem 1rem}
.desc-actions{margin-bottom:.4rem;display:flex;gap:.3rem;justify-content:flex-end}
.desc{background:var(--bg-elev);border:1px solid var(--border);border-radius:8px;padding:.6rem .8rem;overflow:hidden;overflow-wrap:anywhere;word-break:break-word}
.desc.collapsed{max-height:8.5em;position:relative}
.desc.collapsed::after{content:"";position:absolute;inset:auto 0 0 0;height:2.6em;background:linear-gradient(transparent,var(--bg-elev))}
.desc-toggle{margin-top:.4rem;background:none;border:none;color:var(--accent);font-size:13px;cursor:pointer;padding:.2rem 0}
.upstream-link{font-size:12px;color:var(--accent);opacity:.85}
.upstream-link:hover{opacity:1;text-decoration:underline}
`;

export function renderLayout(props: LayoutProps, inner: string, initialItems: string): string {
  const stateClass = props.state === "closed" ? "state-closed" : "state-open";
  const stateLabel = props.state === "closed" ? "Closed" : "Open";
  const isClosed = props.state === "closed";
  const toggleAction = isClosed ? "reopen" : "close";
  const toggleLabel = isClosed ? "评论并重新打开" : "评论并关闭";
  const toggleTitle = isClosed ? "发评论并重新打开工单" : "发评论并关闭工单";
  const [repoOwner, repoName] = props.repoPath.split("/");
  const repoIssuesHref = `/${encodeURIComponent(repoOwner ?? "")}/${encodeURIComponent(repoName ?? "")}/issues`;
  const op = props.operatorLogin ?? "operator";
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(props.title)}</title>
<link rel="stylesheet" href="/static/highlight.css">
<style>${THEME_CSS}</style>
</head>
<body class="${props.bodyClass ?? ""}">
<header class="topbar">
  <a href="/" style="color:var(--header-text)">🏠</a>
  <span style="opacity:.5">/</span>
  <a href="${escapeAttr(repoIssuesHref)}" style="color:var(--header-text)">${escapeHtml(props.repoPath)}</a>
  <span class="num">#${props.issueNumber}</span>
</header>
<div class="meta-bar">
  <h1>${escapeHtml(props.issueTitle)}</h1>
  <div class="meta-status">
    <span class="state-badge ${stateClass}">${stateLabel}</span>
    <span class="count" id="count">…</span>
    ${props.upstreamWebUrl ? `<a class="upstream-link" href="${escapeAttr(props.upstreamWebUrl)}" target="_blank" rel="noopener noreferrer" title="跳转到上游仓库">🔗 查看上游</a>` : ""}
  </div>
</div>
${props.descriptionHtml.trim() ? `<div class="desc-wrap">
  <div class="desc-actions">${actionBarHTML({ copy: true, link: true, translate: true, tts: true, translateEnabled: props.translateEnabled !== false, ttsEnabled: props.ttsEnabled !== false })}</div>
  <div class="desc${props.descriptionCollapsed ? " collapsed" : ""}" id="issueDesc">${props.descriptionHtml}</div>
  ${props.descriptionCollapsed ? `<button type="button" class="desc-toggle" id="descToggle">显示详情 ▾</button>` : ""}
</div>` : ""}
${props.writesEnabled !== false
  ? `<form id="composer" class="composer">
  <textarea id="composerInput" rows="5" placeholder="写评论…（Ctrl/⌘+Enter 发送，以 ${escapeHtml(op)} 身份；可粘贴/选择图片或任意文件上传）"></textarea>
  <div class="submit-col">
    <button type="button" id="composerClose" class="btn-close" data-action="${toggleAction}" title="${toggleTitle}">${toggleLabel}</button>
    <label class="upload-btn" title="上传图片/附件/文件">📎<input type="file" id="composerFile" multiple></label>
    <button type="submit" id="composerSubmit">发送</button>
  </div>
</form>`
  : `<div class="composer-ro">📝 只读模式：评论 / 上传未启用（WORK_WRITES_ENABLED=false）</div>`}
<main id="list">
  <div id="items">${initialItems}</div>
  <div class="sentinel" id="sentinel"></div>
  <div id="loadOlderWrap"><button id="loadOlder">加载更早</button></div>
  <div class="loader hidden" id="loader">加载中…</div>
</main>
<script type="application/json" id="initial-data">${inner}</script>
<script src="/static/tts.js?v=${BUILD_ID}" defer></script>
<script src="/static/app.js?v=${BUILD_ID}" defer></script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export function containsCI(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function highlightAll(text: string, needle: string): string {
  const esc = escapeHtml(text);
  if (!needle) return esc;
  const n = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return esc.replace(new RegExp(`(${n})`, "gi"), '<mark class="hl">$1</mark>');
}

export function snipHighlight(text: string, needle: string, radius = 50): string {
  if (!needle) return "";
  const flat = text.replace(/\s+/g, " ");
  const lo = flat.toLowerCase();
  const n = needle.toLowerCase();
  const idx = lo.indexOf(n);
  if (idx < 0) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + n.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return `${prefix}${escapeHtml(flat.slice(start, idx))}<mark class="hl">${escapeHtml(flat.slice(idx, idx + n.length))}</mark>${escapeHtml(flat.slice(idx + n.length, end))}${suffix}`;
}

export function tabNavHTML(active: "projects" | "issues" | "sessions" | "me", user?: { login: string; is_admin: number | boolean }): string {
  const p = active === "projects" ? " active" : "";
  const i = active === "issues" ? " active" : "";
  const s = active === "sessions" ? " active" : "";
  const m = active === "me" ? " active" : "";
  const userTab = user
    ? `<a class="tab${m}" href="/me" title="${escapeAttr(user.login)}">👤 ${escapeHtml(user.login)}</a>`
    : "";
  return `<nav class="tabs"><a class="tab${p}" href="/projects">项目</a><a class="tab${i}" href="/issues">Issues</a><a class="tab${s}" href="/sessions">会话</a><a class="tab" href="/settings" style="margin-left:auto">⚙️ 设置</a>${userTab}</nav>`;
}

export interface ActionBarOpts {
  cid?: string;
  copy?: boolean;
  link?: boolean;
  translate?: boolean;
  tts?: boolean;
  translateEnabled?: boolean;
  ttsEnabled?: boolean;
}

export function actionBarHTML(o: ActionBarOpts): string {
  const d = o.cid != null ? ` data-cid="${escapeAttr(o.cid)}"` : "";
  const cpy = o.copy ? `<button type="button" class="cbtn"${d} title="复制">📋</button>` : "";
  const lnk = o.link ? `<button type="button" class="clink"${d} title="复制楼层链接">🔗</button>` : "";
  const tr = (o.translate && o.translateEnabled !== false)
    ? `<button type="button" class="tbtn"${d} title="翻译">翻译</button>`
    : "";
  const tts = (o.tts && o.ttsEnabled !== false)
    ? `<button type="button" class="ttsstop"${d} title="停止朗读">⏹</button><button type="button" class="ttsbtn"${d} title="朗读">🔊</button>`
    : "";
  return cpy + lnk + tr + tts;
}
