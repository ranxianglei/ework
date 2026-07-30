import { THEME_CSS, escapeHtml, tabNavHTML } from "./render/layout";
import hljs from "highlight.js";
import { renderMarkdown } from "./render/markdown";

// Extension → hljs language map (mirrors fileview.ts for parity).
const EXT_LANG: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  cs: "csharp", php: "php", swift: "swift", scala: "scala", sh: "bash",
  bash: "bash", zsh: "bash", fish: "bash", yml: "yaml", yaml: "yaml",
  json: "json", json5: "json", toml: "toml", xml: "xml", html: "xml",
  htm: "xml", css: "css", scss: "scss", less: "less", sql: "sql",
  dockerfile: "dockerfile", makefile: "makefile", lua: "lua", pl: "perl",
};

function extToLang(p: string): string {
  const base = (p.split("/").pop() || "").toLowerCase();
  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "dockerfile";
  if (base === "makefile" || base.endsWith(".mk")) return "makefile";
  const m = base.match(/\.([a-z0-9]+)$/);
  const ext = m && m[1];
  return ext ? (EXT_LANG[ext] || "") : "";
}

function hljsHighlight(text: string, lang: string): string {
  try {
    return hljs.highlight(text, { language: lang }).value;
  } catch {
    return escapeHtml(text);
  }
}

export class RemoteFileError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteFileError";
    this.status = status;
  }
}

interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

interface DirListing {
  path: string;
  entries: DirEntry[];
}

interface FileContent {
  path: string;
  size: number;
  rows: { n: number; t: string }[];
  mode: string;
  byteCapped: boolean;
  note: string;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtMtime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}时前`;
  return new Date(ms).toISOString().slice(5, 16);
}

async function fetchDaemon(
  endpoint: string,
  apiPath: string,
  params: Record<string, string>
): Promise<Response> {
  const base = /^https?:\/\//.test(endpoint) ? endpoint : `http://${endpoint}`;
  const url = new URL(`${base}${apiPath}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  return resp;
}

export async function browseRemoteFile(
  endpoint: string,
  rawPath: string,
  mode: string,
  order: string,
  viewerLogin?: string
): Promise<{ html: string }> {
  const daemonLabel = escapeHtml(endpoint);

  const listResp = await fetchDaemon(endpoint, "/api/files/list", { path: rawPath });
  if (listResp.ok) {
    const data = (await listResp.json()) as DirListing;
    return { html: renderDirListing(data, endpoint, daemonLabel, viewerLogin) };
  }
  if (listResp.status !== 400) {
    const err = await listResp.json().catch(() => ({ error: "unknown" })) as { error?: string };
    throw new RemoteFileError(err.error ?? `daemon returned ${listResp.status}`, listResp.status);
  }

  const readResp = await fetchDaemon(endpoint, "/api/files/read", {
    path: rawPath,
    mode: mode === "head" ? "head" : "tail",
    order: order === "asc" ? "asc" : "desc",
  });
  if (!readResp.ok) {
    const err = await readResp.json().catch(() => ({ error: "unknown" })) as { error?: string };
    throw new RemoteFileError(err.error ?? `daemon returned ${readResp.status}`, readResp.status);
  }
  const data = (await readResp.json()) as FileContent;
  return { html: renderFileContent(data, rawPath, endpoint, daemonLabel, viewerLogin) };
}

function renderDirListing(
  data: DirListing,
  endpoint: string,
  daemonLabel: string,
  viewerLogin?: string
): string {
  const enc = encodeURIComponent;
  const daemonParam = `&daemon=${enc(endpoint)}`;
  const parentPath = data.path.split("/").slice(0, -1).join("/") || "/";
  const rows = data.entries.map((e) => {
    const childPath = `${data.path.replace(/\/$/, "")}/${e.name}`;
    const icon = e.isDir ? "📁" : "📄";
    const size = e.isDir ? "—" : fmtSize(e.size);
    return `<tr>
      <td><a href="/file?path=${enc(childPath)}${daemonParam}">${icon} ${escapeHtml(e.name)}</a></td>
      <td class="ms">${size}</td>
      <td class="ts">${fmtMtime(e.mtime)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="3" class="empty">空目录</td></tr>`;

  const user = viewerLogin ? { login: viewerLogin, is_admin: 0 } : undefined;
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ework-web · ${escapeHtml(data.path)}</title>
<style>${THEME_CSS}
.nav{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px}
.nav a{color:var(--header-text);opacity:.95}
.wrap{max-width:900px;margin:0 auto;padding:1rem}
h1{font-size:15px;margin:0 0 .3rem;font-family:ui-monospace,monospace;word-break:break-all}
.remote-badge{display:inline-block;background:#1f6feb33;color:#58a6ff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin-left:.5rem}
.dtable{width:100%;border-collapse:collapse;font-size:13px;margin-top:.6rem}
.dtable th,.dtable td{border:1px solid var(--border);padding:.3rem .5rem;text-align:left}
.dtable th{background:var(--bg);color:var(--text-muted);font-weight:600}
.dtable a{color:var(--accent);text-decoration:none}
.dtable a:hover{text-decoration:underline}
.dtable .ms,.dtable .ts{color:var(--text-muted);white-space:nowrap;font-size:12px}
.empty{color:var(--text-muted);text-align:center;padding:.6rem}
.parent-link{font-size:13px;margin-bottom:.4rem}
.parent-link a{color:var(--text-muted)}
.tabs{display:flex;gap:.3rem;padding:.5rem 1rem;border-bottom:1px solid var(--border);font-size:13px}
.tab{padding:.3rem .7rem;border-radius:6px 6px 0 0;text-decoration:none;color:var(--text-muted)}
.tab.active{background:var(--accent);color:#fff}
</style></head><body>
<header class="nav"><a href="/" style="color:var(--header-text)">🏠 ework-web</a></header>
${tabNavHTML("sessions", user)}
<main class="wrap">
<div class="parent-link">📁 <a href="/file?path=${enc(parentPath)}${daemonParam}">..</a></div>
<h1>${escapeHtml(data.path)}<span class="remote-badge">远程 ${daemonLabel}</span></h1>
<table class="dtable"><thead><tr>
  <th>名称</th><th>大小</th><th>修改时间</th>
</tr></thead><tbody>${rows}</tbody></table>
</main></body></html>`;
}

function renderFileContent(
  data: FileContent,
  rawPath: string,
  endpoint: string,
  daemonLabel: string,
  viewerLogin?: string
): string {
  const enc = encodeURIComponent;
  const daemonParam = `&daemon=${enc(endpoint)}`;
  const user = viewerLogin ? { login: viewerLogin, is_admin: 0 } : undefined;

  const ext = (rawPath.split(".").pop() || "").toLowerCase();
  const isMd = ext === "md" || ext === "markdown";
  const lang = extToLang(rawPath);
  const fullText = data.rows.map((r) => r.t).join("\n");
  const shownBytes = data.rows.reduce((s, r) => s + r.t.length + 1, 0);

  let body: string;
  if (isMd) {
    body = `<div class="md-render">${renderMarkdown(fullText, "")}</div>`;
  } else if (lang && shownBytes <= 256000) {
    const nums = data.rows.map((r) => r.n).join("\n");
    body = `<div class="fv-code"><pre class="fv-gutter">${escapeHtml(nums)}</pre><pre class="fv-src"><code class="hljs language-${escapeHtml(lang)}">${hljsHighlight(fullText, lang)}</code></pre></div>`;
  } else {
    body = `<pre class="fv-plain"><code>${data.rows.map((r) => `<span class="ln"><span class="lnn">${r.n}</span><span class="lnc">${escapeHtml(r.t)}</span></span>`).join("")}</code></pre>`;
  }

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ework-web · ${escapeHtml(data.path)}</title>
<link rel="stylesheet" href="/static/highlight.css">
<style>${THEME_CSS}
.hljs{color:var(--text);background:transparent}
.hljs-comment,.hljs-quote{color:var(--text-muted);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-type{color:#d73a49;font-weight:600}
.hljs-string,.hljs-attr,.hljs-template-tag,.hljs-addition{color:#032f62}
.hljs-number,.hljs-literal,.hljs-variable,.hljs-template-variable{color:#005cc5}
.hljs-title,.hljs-section,.hljs-name,.hljs-function .hljs-title{color:#6f42c1;font-weight:600}
.hljs-tag{color:var(--text-muted)}
.hljs-attribute{color:#005cc5}
.hljs-regexp,.hljs-link{color:#032f62}
.hljs-deletion{color:#b31d28;background-color:#ffeef0}
.hljs-addition{background-color:#f0fff4}
@media(prefers-color-scheme:dark){.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-type{color:#ff7b72}.hljs-string,.hljs-attr,.hljs-template-tag{color:#a5d6ff}.hljs-number,.hljs-literal,.hljs-variable{color:#79c0ff}.hljs-title,.hljs-section,.hljs-name,.hljs-function .hljs-title{color:#d2a8ff}.hljs-comment,.hljs-quote{color:#8b949e}.hljs-deletion{color:#ffa198;background:#67060c}.hljs-addition{background:#033a16}}
.nav{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px}
.nav a{color:var(--header-text);opacity:.95}
.wrap{max-width:1100px;margin:0 auto;padding:1rem}
h1{font-size:14px;margin:0 0 .3rem;font-family:ui-monospace,monospace;word-break:break-all}
.remote-badge{display:inline-block;background:#1f6feb33;color:#58a6ff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin-left:.5rem}
.note{color:var(--text-muted);font-size:12px;margin:0 0 .5rem}
.parent-link{font-size:13px;margin-bottom:.4rem}
.parent-link a{color:var(--text-muted)}
.fv-code{display:flex;border:1px solid var(--border);border-radius:8px;overflow:auto;font-size:12.5px;line-height:1.5}
.fv-gutter{background:var(--bg-muted);color:var(--text-muted);text-align:right;padding:.6rem .7rem;user-select:none;white-space:pre;flex-shrink:0;border:none;margin:0}
.fv-src{margin:0;flex:1;overflow:auto;background:var(--bg-elev);padding:.6rem .8rem;border:none}
.fv-src code{background:none;padding:0;white-space:pre;font-size:12.5px}
.fv-plain{background:var(--bg-elev);border:1px solid var(--border);border-radius:8px;padding:.6rem 0;overflow:auto;font-size:12.5px;line-height:1.5}
.fv-plain .ln{display:flex}
.fv-plain .lnn{user-select:none;text-align:right;color:var(--text-muted);padding:0 .7rem 0 .8rem;min-width:3.5em;flex-shrink:0;border-right:1px solid var(--border);background:var(--bg-muted)}
.fv-plain .lnc{padding:0 .8rem;white-space:pre;overflow-wrap:anywhere}
.md-render{max-width:820px;margin:0 auto;padding:1rem 1.5rem 5rem;font-size:14.5px;line-height:1.7;color:var(--text)}
.md-render h1,.md-render h2,.md-render h3,.md-render h4{line-height:1.3;margin:1.4em 0 .6em;font-weight:600}
.md-render h1{font-size:1.7em;border-bottom:1px solid var(--border);padding-bottom:.3em}
.md-render h2{font-size:1.4em;border-bottom:1px solid var(--border);padding-bottom:.3em}
.md-render h3{font-size:1.2em}
.md-render h4{font-size:1.05em}
.md-render p{margin:.6em 0}
.md-render ul,.md-render ol{margin:.6em 0;padding-left:1.6em}
.md-render li{margin:.25em 0}
.md-render a{color:var(--accent);text-decoration:none}
.md-render a:hover{text-decoration:underline}
.md-render code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:var(--bg-muted);padding:.15em .35em;border-radius:4px}
.md-render pre{background:var(--bg-elev);border:1px solid var(--border);border-radius:8px;padding:.7rem 1rem;overflow:auto;margin:.8em 0}
.md-render pre code{background:none;padding:0;font-size:13px}
.md-render blockquote{border-left:3px solid var(--border);margin:.8em 0;padding:.2em 0 .2em 1em;color:var(--text-muted)}
.md-render table{border-collapse:collapse;margin:.8em 0;width:100%}
.md-render th,.md-render td{border:1px solid var(--border);padding:.4em .7em;text-align:left}
.md-render th{background:var(--bg-muted);font-weight:600}
.md-render img{max-width:100%}
.md-render hr{border:none;border-top:1px solid var(--border);margin:1.4em 0}
</style></head><body>
<header class="nav"><a href="/" style="color:var(--header-text)">🏠 ework-web</a></header>
${tabNavHTML("sessions", user)}
<main class="wrap">
<div class="parent-link">📁 <a href="/file?path=${enc(data.path.split("/").slice(0, -1).join("/") || "/")}${daemonParam}">..</a></div>
<h1>${escapeHtml(data.path)}<span class="remote-badge">远程 ${daemonLabel}</span></h1>
${data.note ? `<p class="note">${escapeHtml(data.note)}</p>` : ""}
${body}
</main></body></html>`;
}

export async function proxyFileSince(
  endpoint: string,
  rawPath: string,
  after: number
): Promise<{ rows: { n: number; t: string }[]; size: number; rotated: boolean; capped: boolean }> {
  const resp = await fetchDaemon(endpoint, "/api/files/since", {
    path: rawPath,
    after: String(after),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: "unknown" })) as { error?: string };
    throw new RemoteFileError(err.error ?? `daemon returned ${resp.status}`, resp.status);
  }
  return await resp.json();
}
