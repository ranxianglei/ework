import { THEME_CSS, escapeHtml, tabNavHTML } from "./render/layout";

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
  const url = new URL(`${endpoint}${apiPath}`);
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
  return { html: renderFileContent(data, endpoint, daemonLabel, viewerLogin) };
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
  endpoint: string,
  daemonLabel: string,
  viewerLogin?: string
): string {
  const enc = encodeURIComponent;
  const daemonParam = `&daemon=${enc(endpoint)}`;
  const user = viewerLogin ? { login: viewerLogin, is_admin: 0 } : undefined;
  const lines = data.rows.map((r) =>
    `<div class="l"><span class="ln">${r.n}</span><span class="lt">${escapeHtml(r.t)}</span></div>`
  ).join("");

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ework-web · ${escapeHtml(data.path)}</title>
<style>${THEME_CSS}
.nav{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px}
.nav a{color:var(--header-text);opacity:.95}
.wrap{max-width:1000px;margin:0 auto;padding:1rem}
h1{font-size:14px;margin:0 0 .3rem;font-family:ui-monospace,monospace;word-break:break-all}
.remote-badge{display:inline-block;background:#1f6feb33;color:#58a6ff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin-left:.5rem}
.note{color:var(--text-muted);font-size:12px;margin:0 0 .5rem}
.parent-link{font-size:13px;margin-bottom:.4rem}
.parent-link a{color:var(--text-muted)}
.fview{background:var(--bg-elev);border:1px solid var(--border);border-radius:6px;overflow:auto;max-height:80vh;font-size:12.5px;font-family:ui-monospace,monospace}
.l{display:flex}
.ln{color:var(--text-muted);min-width:3.5rem;text-align:right;padding:0 .5rem;user-select:none;border-right:1px solid var(--border)}
.lt{padding:0 .5rem;white-space:pre-wrap;word-break:break-all;flex:1}
.tabs{display:flex;gap:.3rem;padding:.5rem 1rem;border-bottom:1px solid var(--border);font-size:13px}
.tab{padding:.3rem .7rem;border-radius:6px 6px 0 0;text-decoration:none;color:var(--text-muted)}
.tab.active{background:var(--accent);color:#fff}
</style></head><body>
<header class="nav"><a href="/" style="color:var(--header-text)">🏠 ework-web</a></header>
${tabNavHTML("sessions", user)}
<main class="wrap">
<div class="parent-link">📁 <a href="/file?path=${enc(data.path.split("/").slice(0, -1).join("/") || "/")}${daemonParam}">..</a></div>
<h1>${escapeHtml(data.path)}<span class="remote-badge">远程 ${daemonLabel}</span></h1>
${data.note ? `<p class="note">${escapeHtml(data.note)}</p>` : ""}
<div class="fview">${lines}</div>
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
