import { realpathSync, statSync, readFileSync, openSync, readSync, closeSync, readdirSync } from "fs";
import { isAbsolute, relative, join, dirname } from "path";
import hljs from "highlight.js";
import { THEME_CSS, escapeHtml, escapeAttr } from "./render/layout";
import { renderMarkdown } from "./render/markdown";
import { BUILD_ID } from "./build";
import type { Config } from "./config";

export class FileViewError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FileViewError";
    this.status = status;
  }
}

// Defense-in-depth denylist — always rejected even inside an allowlisted root.
// Tested on both the raw input and the realpath, so symlinks can't bypass.
const DENY = [
  /(^|\/)\.env\b/i,
  /(^|\/)\.(ssh|gnupg|aws|config\/gitea)\b/i,
  /(id_rsa|id_ed25519|id_ecdsa|id_dsa)\b/i,
  /^\/(?:etc|proc|sys|dev|boot|root)\b/i,
  /\/\.git\/(?:config|hooks|HEAD)\b/i,
];

export interface LineRow {
  n: number;
  t: string;
}

export interface FileChunk {
  realPath: string;
  rows: LineRow[];
  mode: "tail" | "head";
  order: "asc" | "desc";
  byteCapped: boolean;
  note: string;
  size: number;
}

export interface FileDelta {
  rows: LineRow[];
  size: number;
  rotated: boolean;
  capped: boolean;
}

// Shared security gate for /file and /api/file/since: absolute path → denylist
// (raw) → realpath → denylist (realpath) → allowlist containment → regular file.
// Returns the realpath; caller does the read.
function validateFilePath(cfg: Config, rawPath: string): string {
  if (!rawPath || !isAbsolute(rawPath)) {
    throw new FileViewError("path must be absolute", 400);
  }
  for (const re of DENY) if (re.test(rawPath)) {
    throw new FileViewError("denied: sensitive path", 403);
  }
  let rp: string;
  try {
    rp = realpathSync(rawPath);
  } catch {
    throw new FileViewError("file not found", 404);
  }
  for (const re of DENY) if (re.test(rp)) {
    throw new FileViewError("denied: sensitive path", 403);
  }
  // Allowlist: realpath must be strictly within a root. Both root and target are
  // realpath-resolved so a root symlink is followed consistently; relative() with
  // no leading ".." and not absolute => target is contained under the root.
  const inRoot = cfg.fileRoots.some((r) => {
    if (!isAbsolute(r)) return false;
    let rr: string;
    try { rr = realpathSync(r); } catch { return false; }
    const rel = relative(rr, rp);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  });
  if (!inRoot) throw new FileViewError("denied: outside allowlisted roots", 403);
  return rp;
}

function validateReadableFile(cfg: Config, rawPath: string): { rp: string; size: number } {
  const rp = validateFilePath(cfg, rawPath);
  let st: ReturnType<typeof statSync>;
  try { st = statSync(rp); } catch { throw new FileViewError("stat failed", 404); }
  if (!st.isFile()) throw new FileViewError("not a regular file", 400);
  return { rp, size: st.size };
}

// Like validateReadableFile but accepts directories too — caller branches on
// isDirectory(). Same allowlist/denylist/realpath gate applies to dirs.
function validatePath(cfg: Config, rawPath: string): { rp: string; isDir: boolean } {
  const rp = validateFilePath(cfg, rawPath);
  let st: ReturnType<typeof statSync>;
  try { st = statSync(rp); } catch { throw new FileViewError("stat failed", 404); }
  if (st.isDirectory()) return { rp, isDir: true };
  if (!st.isFile()) throw new FileViewError("not a regular file or directory", 400);
  return { rp, isDir: false };
}

export function readAllowedFile(
  cfg: Config,
  rawPath: string,
  mode: "tail" | "head",
  order: "asc" | "desc"
): FileChunk {
  const { rp, size } = validateReadableFile(cfg, rawPath);

  const cap = cfg.fileMaxBytes;
  let buf: Buffer;
  let byteCapped = false;
  if (size > cap) {
    // Slice only `cap` bytes from the chosen end — avoids loading multi-MB/GB
    // logs into memory. Tail reads the last cap; head reads the first cap.
    const start = mode === "tail" ? size - cap : 0;
    buf = readSlice(rp, start, cap);
    byteCapped = true;
  } else {
    try { buf = readFileSync(rp); } catch (e) {
      throw new FileViewError(`read failed: ${(e as Error).message}`, 500);
    }
  }

  // Binary detection: a NUL byte in the first 8KB => not a text log.
  const scanLen = Math.min(buf.length, 8192);
  for (let i = 0; i < scanLen; i++) if (buf[i] === 0) {
    throw new FileViewError("binary file (not viewable as text)", 415);
  }

  const text = buf.toString("utf-8");
  let lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const totalLines = lines.length;
  const n = cfg.fileMaxLines;
  let shown: string[];
  let note: string;
  if (byteCapped) {
    if (mode === "tail") {
      shown = lines.slice(-n);
      // First line of a tail slice is likely truncated mid-line — clobber it.
      if (shown.length > 1) shown[0] = "(…前文已截断)";
      note = `文件 ${formatBytes(size)}，仅读取末尾 ${formatBytes(cap)} 的最后 ${shown.length} 行`;
    } else {
      shown = lines.slice(0, n);
      note = `文件 ${formatBytes(size)}，仅读取开头 ${formatBytes(cap)} 的前 ${shown.length} 行`;
    }
  } else if (totalLines <= n) {
    shown = lines;
    note = `共 ${totalLines} 行 · ${formatBytes(size)}`;
  } else if (mode === "tail") {
    shown = lines.slice(-n);
    note = `共 ${totalLines} 行，显示末尾 ${n} 行`;
  } else {
    shown = lines.slice(0, n);
    note = `共 ${totalLines} 行，显示前 ${n} 行`;
  }

  // Original line numbers (unknown when byte-capped → positional 1..N).
  let firstNum: number;
  if (byteCapped) {
    firstNum = 1;
  } else if (mode === "tail") {
    firstNum = totalLines - shown.length + 1;
  } else {
    firstNum = 1;
  }
  let rows = shown.map((t, i) => ({ n: firstNum + i, t }));
  if (order === "desc") rows = rows.reverse();

  return { realPath: rp, rows, mode, order, byteCapped, note, size };
}

// Live tail -f: returns only bytes appended after `afterOffset`. `rotated`
// (size shrank) tells the client to reload; client seeds afterOffset from page size.
export function readFileSince(cfg: Config, rawPath: string, afterOffset: number): FileDelta {
  if (!Number.isFinite(afterOffset) || afterOffset < 0) {
    throw new FileViewError("bad after offset", 400);
  }
  const { rp, size } = validateReadableFile(cfg, rawPath);
  if (size < afterOffset) return { rows: [], size, rotated: true, capped: false };
  if (size === afterOffset) return { rows: [], size, rotated: false, capped: false };
  const cap = cfg.fileMaxBytes;
  const want = Math.min(size - afterOffset, cap);
  const buf = readSlice(rp, afterOffset, want);
  const scanLen = Math.min(buf.length, 8192);
  for (let i = 0; i < scanLen; i++) if (buf[i] === 0) {
    throw new FileViewError("binary file (not viewable as text)", 415);
  }
  const text = buf.toString("utf-8");
  let lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const capped = size - afterOffset >= cap;
  if (capped && lines.length > 1) lines[0] = "(…前文已截断)";
  const n = cfg.fileMaxLines;
  if (lines.length > n) lines = lines.slice(-n);
  const rows = lines.map((t) => ({ n: 0, t }));
  return { rows, size, rotated: false, capped };
}

function readSlice(path: string, start: number, len: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// Log files default newest-first (tail + desc); documents head + asc.
function isLogPath(p: string): boolean {
  return /\.log(\.\d+)?$/i.test(p) || /\.out$/i.test(p);
}

const EXT_LANG: Record<string, string> = {
  py: "python", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
  java: "java", kt: "kotlin", go: "go", rs: "rust", rb: "ruby", php: "php",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cxx: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", sql: "sql", json: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", html: "xml", htm: "xml", css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown", scala: "scala", swift: "swift", lua: "lua", pl: "perl",
};

function extToLang(p: string): string {
  const base = (p.split("/").pop() || "").toLowerCase();
  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "dockerfile";
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

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// Compact relative/short mtime for directory rows — kept short on purpose so two
// fixed columns (time + size) don't starve the name on narrow phone screens.
function fmtMtime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "刚刚";
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  if (d.getFullYear() === new Date().getFullYear()) return `${mm}-${dd}`;
  return `${String(d.getFullYear()).slice(-2)}-${mm}-${dd}`;
}

// Directory listing (FTP-style): parent link + entries (dirs first), each
// clickable to /file?path=<child> which re-validates + branches dir/file.
function breadcrumbHTML(rp: string, cfg: Config): string {
  const segs = rp.split("/").filter(Boolean);
  let roots: string[] = [];
  try { roots = cfg.fileRoots.map((r) => realpathSync(r)); } catch { /* ignore */ }
  const within = (p: string) => roots.some((root) => p === root || p.startsWith(root + "/"));
  const parts: string[] = [];
  let acc = "";
  segs.forEach((seg, i) => {
    acc += "/" + seg;
    if (i === segs.length - 1) parts.push(`<span class="fpc-last">${escapeHtml(seg)}</span>`);
    else if (within(acc)) parts.push(`<a class="fpc" href="/file?path=${encodeURIComponent(acc)}">${escapeHtml(seg)}</a>`);
    else parts.push(`<span class="fpc-muted">${escapeHtml(seg)}</span>`);
  });
  return `<span class="fpc-root">/</span>` + parts.join(`<span class="fpc-sep">/</span>`);
}

export function buildDirView(cfg: Config, rp: string, sortReq: string | undefined, tdirReq: string | undefined): { html: string } {
  type Ent = { name: string; isDir: boolean; size: number; mtime: number };
  const ents: Ent[] = [];
  try {
    for (const d of readdirSync(rp, { withFileTypes: true })) {
      let size = 0; let mtime = 0;
      try { const st = statSync(join(rp, d.name)); size = st.size; mtime = st.mtimeMs; } catch { /* unreadable entry */ }
      ents.push({ name: d.name, isDir: d.isDirectory(), size, mtime });
    }
  } catch (e) {
    throw new FileViewError(`readdir failed: ${(e as Error).message}`, 500);
  }
  const sortByTime = sortReq !== "name";
  const tdir: "asc" | "desc" = tdirReq === "asc" ? "asc" : "desc";
  ents.sort((a, b) => {
    if (sortByTime) {
      const c = a.mtime - b.mtime;
      return tdir === "desc" ? b.mtime - a.mtime : c;
    }
    return a.isDir === b.isDir
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : a.isDir ? -1 : 1;
  });

  const parent = dirname(rp);
  const parentInRoot = cfg.fileRoots.some((r) => {
    if (!isAbsolute(r)) return false;
    let rr: string;
    try { rr = realpathSync(r); } catch { return false; }
    const rel = relative(rr, parent);
    return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  });

  const enc = encodeURIComponent(rp);
  const rows = ents.map((e) => {
    const href = `/file?path=${encodeURIComponent(join(rp, e.name))}`;
    const icon = e.isDir ? "📁" : "📄";
    const nm = e.isDir ? `${e.name}/` : e.name;
    return `<a class="drow" href="${escapeAttr(href)}"><span class="dicon">${icon}</span><span class="dname">${escapeHtml(nm)}</span><span class="dtime">${fmtMtime(e.mtime)}</span><span class="dsz">${e.isDir ? "" : fmtSize(e.size)}</span></a>`;
  }).join("");
  const parentRow = parentInRoot
    ? `<a class="drow dup" href="/file?path=${encodeURIComponent(parent)}"><span class="dicon">📁</span><span class="dname">..</span><span class="dtime"></span><span class="dsz"></span></a>`
    : "";
  const nameQ = `?path=${enc}&sort=name`;
  const timeDescQ = `?path=${enc}&sort=time&tdir=desc`;
  const timeAscQ = `?path=${enc}&sort=time&tdir=asc`;
  const sortBar = `<div class="dsort"><span class="fv-seg"><a class="${!sortByTime ? "active" : ""}" href="${nameQ}">名称</a><a class="${sortByTime ? "active" : ""}" href="${timeDescQ}">时间</a></span>${sortByTime ? `<span class="fv-seg"><a class="${tdir === "desc" ? "active" : ""}" href="${timeDescQ}">新→旧</a><a class="${tdir === "asc" ? "active" : ""}" href="${timeAscQ}">旧→新</a></span>` : ""}</div>`;

  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(basename(rp) || rp)} · 目录</title>
<style>${THEME_CSS}
.dlist{max-width:900px;margin:0 auto;padding:.4rem 1rem 3rem}
.drow{display:flex;align-items:center;gap:.6rem;padding:.45rem .6rem;border-bottom:1px solid var(--border);color:var(--text);text-decoration:none}
.drow:hover{background:var(--bg-muted);text-decoration:none}
.drow.dup{color:var(--text-muted)}
.dicon{width:1.4rem;flex-shrink:0;font-size:15px}
.dname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all}
.dtime{color:var(--text-muted);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;flex-shrink:0;text-align:right;min-width:3.4rem}
.dsz{color:var(--text-muted);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;flex-shrink:0;text-align:right;min-width:3rem}
.dhdr{max-width:900px;margin:0 auto;padding:.7rem 1rem .3rem;color:var(--text-muted);font-size:13px;word-break:break-all}
.dhdr .fpc{color:var(--accent)}.dhdr .fpc:hover{text-decoration:underline}.dhdr .fpc-sep{color:var(--text-muted);margin:0 .1rem}.dhdr .fpc-last{color:var(--text);font-weight:600}.dhdr .fpc-muted{color:var(--text-muted)}.dhdr .fpc-root{color:var(--text-muted);margin-right:.1rem}
.dsort{max-width:900px;margin:0 auto;padding:.2rem 1rem .4rem;display:flex;gap:.4rem;flex-wrap:wrap}
.fv-seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.fv-seg a{font-size:12px;padding:.22rem .55rem;background:var(--bg-elev);color:var(--text);border:none}
.fv-seg a:hover{background:var(--bg-muted);text-decoration:none}
.fv-seg a.active{background:var(--accent);color:#fff;font-weight:600}
@media(max-width:480px){.drow{gap:.4rem}.dtime{min-width:2.8rem;font-size:10px}.dsz{min-width:2.4rem;font-size:11px}}
</style></head><body>
<header class="nav" style="display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px;flex-wrap:wrap"><a href="/" style="color:var(--header-text)">🏠</a><span style="opacity:.5">/</span><a href="/sessions" style="color:var(--header-text)">会话</a><span style="opacity:.5">/</span><span style="opacity:.85">目录</span></header>
<div class="dhdr">${breadcrumbHTML(rp, cfg)}</div>
${sortBar}
<main class="dlist">${parentRow}${rows || `<div style="padding:2rem;color:var(--text-muted)">空目录</div>`}</main>
</body></html>`;
  return { html };
}

const MEDIA: Record<string, { kind: "audio" | "video" | "image" | "pdf"; mime: string }> = {
  mp3: { kind: "audio", mime: "audio/mpeg" }, wav: { kind: "audio", mime: "audio/wav" },
  ogg: { kind: "audio", mime: "audio/ogg" }, m4a: { kind: "audio", mime: "audio/mp4" },
  flac: { kind: "audio", mime: "audio/flac" }, aac: { kind: "audio", mime: "audio/aac" },
  mp4: { kind: "video", mime: "video/mp4" }, webm: { kind: "video", mime: "video/webm" },
  mov: { kind: "video", mime: "video/quicktime" }, mkv: { kind: "video", mime: "video/x-matroska" },
  avi: { kind: "video", mime: "video/x-msvideo" },
  png: { kind: "image", mime: "image/png" }, jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" }, gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" }, bmp: { kind: "image", mime: "image/bmp" },
  svg: { kind: "image", mime: "image/svg+xml" },
  pdf: { kind: "pdf", mime: "application/pdf" },
};

function mediaKind(p: string): "" | "audio" | "video" | "image" | "pdf" {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  if (i < 0) return "";
  return MEDIA[b.slice(i + 1).toLowerCase()]?.kind ?? "";
}

function mimeOf(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  if (i < 0) return "application/octet-stream";
  return MEDIA[b.slice(i + 1).toLowerCase()]?.mime ?? "application/octet-stream";
}

// Stream a file's raw bytes for /file/raw (inline: media player src) or /file/dl
// (attachment: forced download). Same gate as /file; large files stream via
// Bun.file without buffering into memory.
export function serveRawFile(cfg: Config, rawPath: string, disposition: "inline" | "attachment"): Response {
  const { rp, size } = validateReadableFile(cfg, rawPath);
  const name = basename(rp);
  const headers: Record<string, string> = {
    "content-type": mimeOf(rp),
    "content-length": String(size),
    "cache-control": "private, max-age=0",
  };
  if (disposition === "attachment") {
    // RFC 5987 filename* for non-ASCII; ASCII fallback for older clients.
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    headers["content-disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  } else {
    headers["content-disposition"] = "inline";
  }
  return new Response(Bun.file(rp), { headers });
}

function buildMediaView(cfg: Config, rp: string): { html: string } {
  const kind = mediaKind(rp);
  const enc = encodeURIComponent(rp);
  const rawUrl = `/file/raw?path=${enc}`;
  const dlUrl = `/file/dl?path=${enc}`;
  let player = "";
  if (kind === "audio") player = `<audio controls preload="metadata" src="${rawUrl}" style="width:100%;max-width:640px"></audio>`;
  else if (kind === "video") player = `<video controls preload="metadata" src="${rawUrl}" style="max-width:100%;max-height:70vh"></video>`;
  else if (kind === "image") player = `<img src="${rawUrl}" alt="${escapeAttr(basename(rp))}" style="max-width:100%;max-height:70vh;border:1px solid var(--border);border-radius:8px">`;
  else if (kind === "pdf") player = `<iframe src="${rawUrl}" style="width:100%;height:72vh;border:1px solid var(--border);border-radius:8px"></iframe>`;
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(basename(rp))} · 媒体</title>
<style>${THEME_CSS}
.mv-head{max-width:900px;margin:0 auto;padding:.6rem 1rem;border-bottom:1px solid var(--border)}
.mv-head .fn{font-weight:600;font-size:15px;word-break:break-all;margin-bottom:.3rem}
.mv-head .fp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text-muted);word-break:break-all}
.mv-head .fp .fpc{color:var(--accent)}.mv-head .fp .fpc:hover{text-decoration:underline}.mv-head .fp .fpc-sep{color:var(--text-muted);margin:0 .1rem}.mv-head .fp .fpc-last{color:var(--text);font-weight:600}.mv-head .fp .fpc-muted{color:var(--text-muted)}.mv-head .fp .fpc-root{color:var(--text-muted);margin-right:.1rem}
.mv-body{max-width:900px;margin:1.5rem auto;padding:0 1rem 4rem;text-align:center}
.mv-body audio,.mv-body video,.mv-body img,.mv-body iframe{margin:0 auto}
.dlbtn{display:inline-block;margin-top:1.2rem;background:var(--green);color:#fff;padding:.55rem 1.2rem;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none}
.dlbtn:hover{opacity:.9;text-decoration:none}
</style></head><body>
<header class="nav" style="display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px;flex-wrap:wrap"><a href="/" style="color:var(--header-text)">🏠 ework-web</a><span style="opacity:.5">/</span><span style="opacity:.85">媒体</span></header>
<div class="mv-head"><div class="fn">${escapeHtml(basename(rp))}</div><div class="fp">${breadcrumbHTML(rp, cfg)}</div></div>
<div class="mv-body">${player}<br><a class="dlbtn" href="${dlUrl}">⬇ 下载</a></div>
</body></html>`;
  return { html };
}

function buildDownloadView(cfg: Config, rp: string): { html: string } {
  const dlUrl = `/file/dl?path=${encodeURIComponent(rp)}`;
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(basename(rp))} · 下载</title>
<style>${THEME_CSS}
.dv-head{max-width:900px;margin:0 auto;padding:.6rem 1rem;border-bottom:1px solid var(--border)}
.dv-head .fp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text-muted);word-break:break-all}
.dv-head .fp .fpc{color:var(--accent)}.dv-head .fp .fpc:hover{text-decoration:underline}.dv-head .fp .fpc-sep{color:var(--text-muted);margin:0 .1rem}.dv-head .fp .fpc-last{color:var(--text);font-weight:600}.dv-head .fp .fpc-muted{color:var(--text-muted)}.dv-head .fp .fpc-root{color:var(--text-muted);margin-right:.1rem}
.dv-body{max-width:900px;margin:2rem auto;padding:0 1rem 4rem;text-align:center}
.dv-body .big{font-size:40px;margin-bottom:.5rem}
.dv-body .msg{color:var(--text-muted);margin-bottom:1.2rem}
.dlbtn{display:inline-block;background:var(--green);color:#fff;padding:.6rem 1.4rem;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none}
.dlbtn:hover{opacity:.9;text-decoration:none}
</style></head><body>
<header class="nav" style="display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px;flex-wrap:wrap"><a href="/" style="color:var(--header-text)">🏠 ework-web</a><span style="opacity:.5">/</span><span style="opacity:.85">文件</span></header>
<div class="dv-head"><div class="fp">${breadcrumbHTML(rp, cfg)}</div></div>
<div class="dv-body"><div class="big">📄</div><div class="msg">该文件无法在线预览（二进制）。</div><a class="dlbtn" href="${dlUrl}">⬇ 下载 ${escapeHtml(basename(rp))}</a></div>
</body></html>`;
  return { html };
}

export function buildFileView(
  cfg: Config,
  rawPath: string,
  modeReq: string | undefined,
  orderReq: string | undefined,
  viewReq: string | undefined,
  sortReq: string | undefined,
  tdirReq: string | undefined
): { html: string } {
  const isLog = isLogPath(rawPath);
  const mode: "tail" | "head" = modeReq === "tail" || modeReq === "head"
    ? modeReq
    : isLog ? "tail" : "head";
  const order: "asc" | "desc" = orderReq === "asc" || orderReq === "desc"
    ? orderReq
    : isLog ? "desc" : "asc";

  const resolved = validatePath(cfg, rawPath);
  if (resolved.isDir) return buildDirView(cfg, resolved.rp, sortReq, tdirReq);
  if (mediaKind(rawPath)) return buildMediaView(cfg, resolved.rp);
  let chunk: FileChunk;
  try {
    chunk = readAllowedFile(cfg, rawPath, mode, order);
  } catch (e) {
    if (e instanceof FileViewError && e.status === 415) return buildDownloadView(cfg, resolved.rp);
    throw e;
  }
  const ext = (rawPath.split(".").pop() || "").toLowerCase();
  const isMd = ext === "md" || ext === "markdown";
  const mdRender = isMd && viewReq !== "raw";
  const lang = extToLang(rawPath);
  const shownBytes = chunk.rows.reduce((s, r) => s + r.t.length + 1, 0);
  const fullText = chunk.rows.map((r) => r.t).join("\n");
  const body = mdRender
    ? `<div class="md-render">${renderMarkdown(fullText, "")}</div>`
    : lang && shownBytes <= 100000
      ? renderHighlighted(chunk, lang)
      : `<pre><code>${chunk.rows.map((r) => lineRow(r.t, r.n)).join("")}</code></pre>`;
  const enc = encodeURIComponent(rawPath);
  const ordQ = `&order=${order}`;
  const modeQ = `&mode=${mode}`;
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(basename(rawPath))} · 文件</title>
<link rel="stylesheet" href="/static/highlight.css">
<style>${THEME_CSS}
.fv-head{max-width:1100px;margin:0 auto;padding:.6rem 1rem;border-bottom:1px solid var(--border)}
.fv-head .fp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text-muted);word-break:break-all}
.fv-head .fp .fpc{color:var(--accent)}.fv-head .fp .fpc:hover{text-decoration:underline}.fv-head .fp .fpc-sep{color:var(--text-muted);margin:0 .1rem}.fv-head .fp .fpc-last{color:var(--text);font-weight:600}.fv-head .fp .fpc-muted{color:var(--text-muted)}.fv-head .fp .fpc-root{color:var(--text-muted);margin-right:.1rem}
.fv-head .fn{font-weight:600;font-size:15px;word-break:break-all}
.fv-bar{display:flex;gap:.4rem;align-items:center;margin-top:.4rem;flex-wrap:wrap}
.fv-bar .note{font-size:12px;color:var(--text-muted);margin-right:.3rem}
.fv-seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.fv-seg a{font-size:12px;padding:.25rem .6rem;background:var(--bg-elev);color:var(--text);border:none}
.fv-seg a:hover{background:var(--bg-muted);text-decoration:none}
.fv-seg a.active{background:var(--accent);color:#fff;font-weight:600}
.fv-pre{max-width:1100px;margin:0 auto;padding:.4rem .2rem 5rem}
.fv-pre pre{background:var(--bg-elev);border:1px solid var(--border);border-radius:8px;padding:.6rem 0;overflow:auto;font-size:12.5px;line-height:1.5}
.fv-pre .ln{display:flex}
.fv-pre .lnn{user-select:none;text-align:right;color:var(--text-muted);padding:0 .7rem 0 .8rem;min-width:3.5em;flex-shrink:0;border-right:1px solid var(--border);background:var(--bg-muted)}
.fv-pre .lnc{padding:0 .8rem;white-space:pre;overflow-wrap:anywhere}
.fv-pre .fv-code{display:flex;border:1px solid var(--border);border-radius:8px;overflow:auto;margin:0}
.fv-pre .fv-gutter{background:var(--bg-muted);color:var(--text-muted);text-align:right;padding:.6rem .7rem;font-size:12.5px;line-height:1.5;user-select:none;white-space:pre;flex-shrink:0;border:none;border-radius:0;margin:0}
.fv-pre .fv-src{margin:0;flex:1;overflow:auto;background:var(--bg-elev);padding:.6rem .8rem;font-size:12.5px;line-height:1.5;border:none;border-radius:0}
.fv-pre .fv-src code{background:none;padding:0;white-space:pre;font-size:12.5px}
.fab{position:fixed;right:1.2rem;width:2.4rem;height:2.4rem;border-radius:50%;background:var(--bg-elev);border:1px solid var(--border);color:var(--text);display:flex;align-items:center;justify-content:center;font-size:18px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.18);z-index:50}
.fab:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.fab-top{bottom:3.6rem}
.fab-bot{bottom:.8rem}
.fbtn{font-size:12px;padding:.25rem .7rem;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:6px;cursor:pointer;font:inherit;font-weight:600}
.fbtn:hover{border-color:var(--accent)}
.fbtn.on{background:var(--green);color:#fff;border-color:var(--green)}
.fbtn.flash{background:var(--accent);color:#fff;border-color:var(--accent)}
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
<header class="nav" style="display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px;flex-wrap:wrap">
  <a href="/" style="color:var(--header-text)">🏠 ework-web</a><span style="opacity:.5">/</span>
  <span style="opacity:.85">文件查看</span>
</header>
<div class="fv-head">
  <div class="fn">${escapeHtml(basename(rawPath))} ${isLog ? '<span style="font-size:11px;color:var(--text-muted);font-weight:400">（日志，默认最新在顶）</span>' : ""}</div>
  <div class="fp">${breadcrumbHTML(chunk.realPath, cfg)}</div>
  <div class="fv-bar">
    <span class="note">${escapeHtml(chunk.note)}</span>
    <span class="fv-seg">
      <a class="${mode === "tail" ? "active" : ""}" href="/file?path=${enc}&mode=tail${ordQ}">末尾 ${cfg.fileMaxLines}</a>
      <a class="${mode === "head" ? "active" : ""}" href="/file?path=${enc}&mode=head${ordQ}">开头 ${cfg.fileMaxLines}</a>
    </span>
    <span class="fv-seg">
      <a class="${order === "desc" ? "active" : ""}" href="/file?path=${enc}${modeQ}&order=desc">倒排</a>
      <a class="${order === "asc" ? "active" : ""}" href="/file?path=${enc}${modeQ}&order=asc">正排</a>
    </span>
    ${isMd ? `<span class="fv-seg">
      <a class="${mdRender ? "active" : ""}" href="/file?path=${enc}&view=rendered${modeQ}${ordQ}">渲染</a>
      <a class="${!mdRender ? "active" : ""}" href="/file?path=${enc}&view=raw${modeQ}${ordQ}">原文</a>
    </span>` : ""}
    <button type="button" class="fbtn" id="followBtn" title="实时刷新（tail -f）">🔄 Follow</button>
  </div>
</div>
<div class="fv-pre"><div id="top"></div>${body}<div id="bottom"></div></div>
<a class="fab fab-top" href="#top" title="跳到最上">↑</a>
<a class="fab fab-bot" href="#bottom" title="跳到最下">↓</a>
<script type="application/json" id="file-data">${JSON.stringify({ path: rawPath, size: chunk.size, order, isLog, maxN: chunk.rows.reduce((m, r) => Math.max(m, r.n), 0) })}</script>
<script src="/static/file.js?v=${BUILD_ID}" defer></script>
</body></html>`;
  return { html };
}

function lineRow(line: string, n: number): string {
  return `<span class="ln"><span class="lnn">${n}</span><span class="lnc">${escapeHtml(line)}</span></span>`;
}

function renderHighlighted(chunk: FileChunk, lang: string): string {
  const shown = chunk.rows.map((r) => r.t).join("\n");
  const nums = chunk.rows.map((r) => r.n).join("\n");
  return `<div class="fv-code"><pre class="fv-gutter">${escapeHtml(nums)}</pre><pre class="fv-src"><code class="hljs language-${escapeHtml(lang)}">${hljsHighlight(shown, lang)}</code></pre></div>`;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
