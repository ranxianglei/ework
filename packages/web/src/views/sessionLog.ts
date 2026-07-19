import type { OpencodeClient, SessionListItem, SessionExport, SessionMessage, MessagePart, ToolState } from "../opencode";
import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";
import { renderMarkdown, linkifySessionIDs, linkifyAbsPaths } from "../render/markdown";
import { BUILD_ID } from "../build";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LIST_LIMIT = 100;

export async function buildSessionList(client: OpencodeClient, q: string): Promise<{ html: string }> {
  let sessions = await client.listSessions(LIST_LIMIT);
  const needle = q.trim().toLowerCase();
  if (needle) {
    sessions = sessions.filter((s) => s.title.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle));
  }
  const rows = sessions.map(sessionRow).join("");

  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ework-web · 会话</title>
<link rel="stylesheet" href="/static/highlight.css">
<style>${THEME_CSS}
.sbar{max-width:900px;margin:0 auto;padding:.6rem 1rem;display:flex;gap:.5rem;align-items:center}
.sbar input{flex:1;background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.5rem .7rem;font:inherit;font-size:14px}
.sbar input:focus{outline:none;border-color:var(--accent)}
.slist{max-width:900px;margin:0 auto;padding:0 1rem 3rem}
.srow{display:block;padding:.7rem 1rem;border:1px solid var(--border);border-radius:10px;margin-bottom:.5rem;background:var(--bg-elev);text-decoration:none}
.srow:hover{border-color:var(--accent);text-decoration:none}
.srow .st{font-weight:600;color:var(--text);font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srow .sm{display:flex;gap:1rem;color:var(--text-muted);font-size:12px;margin-top:.25rem;flex-wrap:wrap}
.srow .sid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.empty{padding:2rem;text-align:center;color:var(--text-muted)}
</style></head><body>
<header class="nav" style="display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px"><a href="/" style="color:var(--header-text)">🏠 ework-web</a><span style="opacity:.8"> · OpenCode 会话 ${sessions.length}</span></header>
${tabNavHTML("sessions")}
<form class="sbar" method="get" action="/sessions">
  <input name="q" value="${escapeAttr(q)}" placeholder="按标题或会话 ID 搜索…" autocomplete="off">
</form>
<main class="slist">${rows || `<div class="empty">${needle ? "没有匹配的会话" : "没有会话（确认 opencode CLI 可用）"}</div>`}</main>
</body></html>`;
  return { html };
}

function sessionRow(s: SessionListItem): string {
  const href = `/sessions/${encodeURIComponent(s.id)}`;
  const shortId = s.id.startsWith("ses_") ? s.id.slice(0, 16) + "…" : s.id;
  const badges = [
    s.peakTokens ? `<span>🧮 峰值 ${kfmt(s.peakTokens)}</span>` : "",
    s.msgCount ? `<span>💬 ${s.msgCount}</span>` : "",
  ].join("");
  return `<a class="srow" href="${escapeAttr(href)}">
  <div class="st">${escapeHtml(s.title)}</div>
  <div class="sm"><span class="sid">${escapeHtml(shortId)}</span><span>更新 ${relTimeMs(s.updated)}</span>${badges}</div>
</a>`;
}

export async function buildSessionView(client: OpencodeClient, id: string, desc: boolean, collapseLines: number, limit = 30, all = false): Promise<{ html: string }> {
  const data = await client.exportSession(id);
  const info = data.info;
  const title = info.title || id;
  const created = info.time.created ? relTimeMs(info.time.created) : "";
  const updated = info.time.updated ? relTimeMs(info.time.updated) : "";
  const total = data.messages.length;
  let msgs = desc ? [...data.messages].reverse() : [...data.messages];
  // Show the NEWEST `limit` msgs; desc=newest-first→slice head, asc→slice tail.
  const truncated = !all && total > limit;
  if (truncated) msgs = desc ? msgs.slice(0, limit) : msgs.slice(total - limit);
  const maxMsgTok = computeMaxMsgTok(data.messages);
  const baseDir = info.directory || "";
  const acp = readAcpStats(info.id);
  const anchors = acp && acp.logBlocks.length ? computeBlockAnchors(msgs, acp.logBlocks, desc) : null;
  const bodyParts: string[] = [];
  const pre = anchors && anchors.get(-1);
  if (pre) bodyParts.push(pre.map(compressionMarkerHTML).join(""));
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (!msg) continue;
    bodyParts.push(renderMessage(msg, maxMsgTok, collapseLines, baseDir));
    const mk = anchors && anchors.get(i);
    if (mk) bodyParts.push(mk.map(compressionMarkerHTML).join(""));
  }
  const body = bodyParts.join("");
  const ordQs = desc ? "" : "&asc=1";
  const moreAllHref = `/sessions/${encodeURIComponent(info.id)}?all=1${ordQs}`;
  const moreBar = truncated
    ? `<div class="more-bar" id="moreBar" data-total="${total}">共 ${total} 条，当前显示最新 ${limit} 条 · <button type="button" id="loadMoreBtn" data-offset="${limit}">再加载 30 条</button> · <a href="${escapeAttr(moreAllHref)}">查看全部</a></div>`
    : "";
  const lastCreated = data.messages.reduce((m, msg) => Math.max(m, msg.info.time?.created ?? 0), 0);
  const stats = computeCtxStats(data.messages);
  const bd = acp ? computeCtxBreakdown(data.messages, acp.byMessageId, acp.blocksById) : null;
  const ordAsc = desc ? "" : " on";
  const ordDesc = desc ? " on" : "";
  const followNote = "";

  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(title)} · 会话</title>
<link rel="stylesheet" href="/static/highlight.css">
<style>${THEME_CSS}
.meta-bar .sid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text-muted)}
.mbar{max-width:900px;margin:0 auto;padding:.4rem 1rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.mbar .ord{margin-left:auto;display:flex;gap:.3rem;font-size:12px}
.mbar .ord button{padding:.25rem .55rem;border:1px solid var(--border);border-radius:6px;color:var(--text-muted);background:var(--bg-elev);cursor:pointer;font:inherit}
.mbar .ord button.on{background:var(--bg-muted);color:var(--text);font-weight:600}
.mbar .ord button:hover{border-color:var(--accent)}
.msg-actions{position:absolute;top:.3rem;right:.5rem;display:flex;gap:.3rem;z-index:2}
.msg-actions .tbtn,.msg-actions .cbtn,.msg-actions .ttsbtn{background:var(--bg-muted);border:1px solid var(--border);border-radius:6px;padding:.15rem .4rem;cursor:pointer;font-size:12px;color:var(--text-muted);line-height:1.4}
.msg-actions .tbtn:hover,.msg-actions .cbtn:hover,.msg-actions .ttsbtn:hover{border-color:var(--accent);color:var(--accent)}
.msg-actions .tbtn.loading{opacity:.5;cursor:wait}
.msg-actions .ttsbtn.playing{color:var(--green);border-color:var(--green)}
.msg-actions .cbtn.done{color:var(--green);border-color:var(--green)}
.msg-actions .ttsstop{background:var(--bg-muted);border:1px solid var(--border);border-radius:6px;padding:.15rem .4rem;cursor:pointer;font-size:12px;color:var(--text-muted);line-height:1.4}
.msg-actions .ttsstop:hover{border-color:var(--accent);color:var(--accent)}
.mb .tr-note{font-size:12px;color:var(--text-muted);margin-bottom:.3rem;font-style:italic}
.mb .tr-toggle{font-size:12px;color:var(--accent);cursor:pointer;background:none;border:none;padding:0;text-decoration:underline}
.mb .tr-prog{white-space:pre-wrap;word-break:break-word}
.fbtn{background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.35rem .8rem;font-size:13px;cursor:pointer}
.fbtn:hover{border-color:var(--accent)}
.fbtn.on{background:var(--green);color:#fff;border-color:var(--green)}
.fbtn.flash{background:var(--accent);color:#fff;border-color:var(--accent)}
#mlist{max-width:900px;margin:0 auto;padding:.5rem 1rem 3rem}
.msg{position:relative;background:var(--bg-elev);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:8px;padding:.6rem .9rem;margin-bottom:1rem;overflow:hidden}
.msg.msg-u{border-left-color:var(--human);background:color-mix(in srgb,var(--human) 4%,var(--bg-elev))}
.msg.msg-a{border-left-color:var(--bot);background:color-mix(in srgb,var(--bot) 4%,var(--bg-elev))}
.mh{display:flex;align-items:center;gap:.5rem;font-size:13px;flex-wrap:wrap;margin-bottom:.35rem;padding-right:5.5rem}
.mh .role{font-weight:600;font-size:11px;padding:.05rem .45rem;border-radius:4px;line-height:1.7}
.mh .role-u{background:color-mix(in srgb,var(--human) 18%,transparent);color:var(--human)}
.mh .role-a{background:color-mix(in srgb,var(--bot) 18%,transparent);color:var(--bot)}
.mh .model{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text-muted)}
.mh .when{color:var(--text-muted);font-size:12px;margin-left:auto}
.mh .sz{color:var(--text-muted);font-size:11px}
.mh .tok{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--text-muted)}
.mh,.msg-actions,.tbar,.ttok,.mbar,.ord{user-select:none;-webkit-user-select:none}
.mb{overflow-wrap:anywhere;word-break:break-word;line-height:1.55}
.mb p{margin:.4rem 0}
.mb img{max-width:100%;height:auto;max-height:55vh;border-radius:6px;display:block;margin:.4rem 0}
.mb pre{background:var(--code-bg);padding:.6rem;border-radius:6px;overflow:auto;font-size:12.5px}
.mb code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;font-size:12.5px}
.mb pre code{background:none;padding:0}
.mb details{margin:.3rem 0;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.mb summary{cursor:pointer;padding:.4rem .6rem;background:var(--bg-muted);font-size:13px;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.more-bar{max-width:900px;margin:1rem auto 0;padding:.8rem 1rem;text-align:center;border:1px dashed var(--border);border-radius:8px;color:var(--text-muted);font-size:13px}
.more-bar a{font-weight:600}
.fab{position:fixed;right:1rem;width:40px;height:40px;border-radius:50%;background:var(--bg-elev);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;text-decoration:none;color:var(--text);font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.15);z-index:50}
.fab:hover{border-color:var(--accent);color:var(--accent)}
.fab-top{bottom:3.6rem}
.fab-bot{bottom:.6rem}
.tbar{display:inline-block;width:128px;height:6px;background:var(--border);border-radius:3px;overflow:hidden;flex-shrink:0}
.tbar-fill{display:block;height:100%;border-radius:3px}
.ttok{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--text-muted);min-width:5.5em;text-align:right}
.mb summary .tbar{margin-left:auto}
.mh .tbar{margin-left:.5rem}
.mb details[open] summary{border-bottom:1px solid var(--border)}
.mb details.reasoning{border-left:3px solid color-mix(in srgb,var(--system) 45%,transparent)}
.mb details.reasoning > .tool-io{background:color-mix(in srgb,var(--system) 7%,var(--bg-elev))}
.mb .tool-io{position:relative;padding:.5rem .6rem}
.mb .tool-io pre{margin:.2rem 0}
.pcbtn{position:absolute;top:.3rem;right:.4rem;background:var(--bg-elev);border:1px solid var(--border);border-radius:5px;padding:.1rem .35rem;font-size:12px;line-height:1.4;cursor:pointer;opacity:.55;z-index:1}
.pcbtn:hover{opacity:1;border-color:var(--accent)}
.pcbtn.done{color:var(--green);opacity:1}
.trbtn{position:absolute;top:.3rem;right:2.3rem;background:var(--bg-elev);border:1px solid var(--border);border-radius:5px;padding:.1rem .45rem;font-size:12px;line-height:1.4;cursor:pointer;opacity:.55;z-index:1}
.trbtn:hover{opacity:1;border-color:var(--accent)}
.mb details.reasoning > summary .trbtn,.mb details.reasoning > summary .pcbtn{position:static;top:auto;right:auto;margin-left:.3rem;opacity:.7}
.mb summary .ttsbtn,.mb summary .ttsstop{background:var(--bg-muted);border:1px solid var(--border);border-radius:6px;padding:.05rem .35rem;cursor:pointer;font-size:11px;color:var(--text-muted);opacity:.7}
.mb summary .ttsbtn:hover,.mb summary .ttsstop:hover{opacity:1;border-color:var(--accent);color:var(--accent)}
.mb summary .sum-tools{margin-left:auto;display:inline-flex;align-items:center;gap:.4rem;flex-wrap:wrap;justify-content:flex-end}
.mb summary .sum-tools .tbar{margin-left:0}
.edit-ro{max-width:900px;margin:0 auto .9rem;padding:.7rem 1rem;color:var(--text-muted);font-size:13px;text-align:center;border:1px dashed var(--border);border-radius:8px}
.acp-log{max-width:1100px;margin:0 auto .6rem;padding:0 1rem}
.acp-log>summary{cursor:pointer;font-size:13px;color:var(--text-muted);padding:.3rem 0;user-select:none}
.acp-log>summary:hover{color:var(--accent)}
.acp-log-list{max-height:62vh;overflow:auto;border:1px solid var(--border);border-radius:8px;background:var(--bg-elev);padding:.2rem}
.acp-blk{border-bottom:1px solid var(--border);font-size:12px}
.acp-blk:last-child{border-bottom:none}
.acp-blk>summary{cursor:pointer;padding:.3rem .45rem;color:var(--text);line-height:1.5;user-select:none;word-break:break-all}
.acp-blk>summary:hover{background:var(--bg-muted)}.acp-blk.off>summary{opacity:.5}
.acp-sum{padding:.45rem .8rem;border-top:1px dashed var(--border);font-size:13px;line-height:1.6;overflow-wrap:anywhere;min-width:0}
.acp-sum h1,.acp-sum h2,.acp-sum h3{font-size:1em;margin:.4em 0 .2em}.acp-sum p{margin:.3em 0}
.acp-mark{position:relative;margin:.45rem 0;border-left:3px solid var(--green);background:var(--bg-muted);border-radius:0 6px 6px 0;padding:.3rem .7rem;font-size:12px;min-width:0;max-width:100%}
.acp-mark.off{border-left-color:var(--text-muted);opacity:.7}
.acp-st{display:inline-block;font-size:11px;padding:0 .35em;border-radius:3px;font-weight:600;line-height:1.6;vertical-align:baseline}
.acp-st.on{background:var(--green);color:#fff}
.acp-st.off{background:var(--text-muted);color:#fff}
.acp-mark>summary{cursor:pointer;list-style:none;font-weight:600;color:var(--text);word-break:break-all;line-height:1.5;padding-right:6rem}
.acp-mark>summary::-webkit-details-marker{display:none}
.acp-mark>summary:hover{color:var(--accent)}
.acp-mark .acp-sum{border-top:1px dashed var(--border);margin-top:.35rem;padding-top:.35rem}
.acp-sum ul,.acp-sum ol{margin:.3em 0;padding-left:1.4em}.acp-sum code{font-family:ui-monospace,monospace;font-size:.88em;background:var(--bg-muted);padding:.1em .3em;border-radius:3px;overflow-wrap:break-word}
.acp-sum pre{background:var(--bg-muted);border:1px solid var(--border);border-radius:6px;padding:.5rem .7rem;overflow-x:auto;max-width:100%;font-size:12px}
.acp-sum pre code{background:none;padding:0;overflow-wrap:normal}
.acp-sum table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}
.acp-sum img{max-width:100%}
</style></head><body>
<header class="nav" style="display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px;flex-wrap:wrap">
  <a href="/" style="color:var(--header-text)">🏠</a><span style="opacity:.5">/</span>
  <a href="/sessions" style="color:var(--header-text)">会话</a><span style="opacity:.5">/</span>
  <span style="opacity:.85">${escapeHtml(title)}</span>
</header>
<div class="meta-bar">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta-status">
    <span class="sid">${escapeHtml(info.id)}</span>
    ${info.directory ? `<span>📁 ${escapeHtml(info.directory)}</span>` : ""}
    ${created ? `<span>创建 ${created}</span>` : ""}
    ${updated ? `<span>更新 ${updated}</span>` : ""}
    <span>${data.messages.length} 条消息</span>
    ${stats.peak ? `<span>🧮 当前 ${kfmt(stats.current)} · 峰值 ${kfmt(stats.peak)}${stats.p90 ? ` · P90 ${kfmt(stats.p90)}` : ""}${stats.p50 ? ` · P50 ${kfmt(stats.p50)}` : ""}</span>` : ""}
    ${stats.calls ? `<span>📊 累计 ${kfmt(stats.traffic)} · cache ${stats.cacheHit}% · ${stats.calls} 调用</span>` : ""}
    ${acp ? `<span>🗜 压缩 ${acp.blocks} 段${acp.savedTokens ? ` · 省 ${kfmt(acp.savedTokens)}` : ""}</span>` : ""}
    ${bd && bd.total ? `<span>📂 ${ctxBreakdownStr(bd, stats.current, stats.overhead)}</span>` : ""}
  </div>
</div>
${acp && acp.logBlocks.length ? compressionLogHTML(acp.logBlocks, acp.savedTokens, info.time.created ?? 0) : ""}
<div class="mbar">
  <button type="button" id="followBtn" class="fbtn" title="自动追加新消息（类似 -f）">🔄 Follow</button>
  <button type="button" id="collapseBtn" class="fbtn" title="一键折叠/展开所有 thinking 和工具输出">📂 展开全部</button>
  <span style="font-size:12px;color:var(--text-muted)">📖 只读 · 编辑见第二步${followNote ? ` ${followNote}` : ""}</span>
  <span class="ord">
    <button type="button" class="ord-btn ${ordAsc}" data-ord="asc">正序</button>
    <button type="button" class="ord-btn ${ordDesc}" data-ord="desc">倒序</button>
  </span>
</div>
<main id="mlist"><div id="top"></div>${body || `<div class="empty" style="padding:2rem;text-align:center;color:var(--text-muted)">此会话没有消息</div>`}${moreBar}<div id="bottom"></div></main>
<a class="fab fab-top" href="#top" title="回到顶部">↑</a>
<a class="fab fab-bot" href="#bottom" title="去到底部">↓</a>
<script type="application/json" id="session-data">${JSON.stringify({ id: info.id, lastCreated, desc })}</script>
<script src="/static/tts.js?v=${BUILD_ID}" defer></script>
<script src="/static/session.js?v=${BUILD_ID}" defer></script>
</body></html>`;
  return { html };
}

export function renderBatchHTML(data: SessionExport, offset: number, limit: number, desc: boolean, collapseLines: number): { html: string; total: number; hasMore: boolean } {
  const total = data.messages.length;
  const maxMsgTok = computeMaxMsgTok(data.messages);
  const ordered = desc ? [...data.messages].reverse() : [...data.messages];
  const slice = ordered.slice(offset, offset + limit);
  const html = slice.map((m) => renderMessage(m, maxMsgTok, collapseLines, data.info?.directory || "")).join("");
  return { html, total, hasMore: offset + limit < total };
}

export interface NewMessage {
  id: string;
  html: string;
  created: number;
}

// For the follow endpoint: messages whose created-time is newer than sinceMs,
// each server-rendered to the same HTML renderMessage produces. Returning HTML
// (not raw data) lets the client append without duplicating the render logic.
//
// Empty placeholders are skipped WITHOUT advancing lastCreated — advancing past
// them would freeze them empty (cursor moves on); leaving them ahead of the
// cursor means the next poll re-checks and emits them once content streams in.
export function renderNewMessages(data: SessionExport, sinceMs: number, collapseLines: number): { items: NewMessage[]; lastCreated: number } {
  let last = sinceMs;
  const maxMsgTok = computeMaxMsgTok(data.messages);
  const items: NewMessage[] = [];
  for (const m of data.messages) {
    const c = m.info.time?.created ?? 0;
    if (c <= sinceMs) continue;
    if (!messageHasContent(m)) continue;
    if (c > last) last = c;
    items.push({ id: m.info.id, html: renderMessage(m, maxMsgTok, collapseLines, data.info?.directory || ""), created: c });
  }
  return { items, lastCreated: last };
}

// opencode writes the message row before its parts stream in, so export can
// transiently contain empty placeholders mid-generation.
function messageHasContent(msg: SessionMessage): boolean {
  for (const p of msg.parts) {
    if (p.type === "text" || p.type === "reasoning") {
      if ((p.text || "").trim()) return true;
    } else if (p.type === "tool" && p.tool) {
      return true;
    }
  }
  return false;
}

function renderMessage(msg: SessionMessage, maxMsgTok: number, collapseLines: number, baseDir = ""): string {
  const info = msg.info;
  const isUser = info.role === "user";
  const msgClass = isUser ? "msg msg-u" : "msg msg-a";
  const roleClass = isUser ? "role-u" : "role-a";
  const roleLabel = isUser ? "👤 User" : "🤖 Assistant";
  const agent = info.agent && info.agent !== "build" ? ` <span class="model">(${escapeHtml(info.agent)})</span>` : "";
  const model = info.modelID ? ` <span class="model">${escapeHtml(info.modelID)}</span>` : "";
  const when = info.time?.created ? fmtMs(info.time.created) : "";
  const sz = formatSize(messageSize(msg));
  const tok = formatTokens(info.tokens);
  const parts = msg.parts.map((p) => renderPart(p, maxMsgTok, collapseLines, baseDir)).join("");
  const msgPartTok = msg.parts.reduce((s, p) => s + partTokens(p), 0);
  const mbar = tokBarHTML(msgPartTok, maxMsgTok, false);
  const actions = `<div class="msg-actions"><button type="button" class="cbtn" title="复制可见文本">📋</button><button type="button" class="linkbtn" title="复制楼层链接">🔗</button><button type="button" class="ttsstop" title="停止朗读">⏹</button><button type="button" class="ttsbtn" title="朗读（选中起点）">🔊</button><button type="button" class="tbtn" title="翻译成中文">翻译</button></div>`;
  return `<div class="${msgClass}" id="m${info.id}">
  ${actions}
  <div class="mh">
    <span class="role ${roleClass}">${roleLabel}</span>${agent}${model}
    ${tok ? `<span class="tok">${tok}</span>` : ""}
    <span class="when">${escapeHtml(when)}</span>
    <span class="sz">${sz}</span>
    ${mbar}
  </div>
  <div class="mb">${parts}</div>
</div>`;
}

function formatTokens(t?: { total?: number; input?: number; output?: number; reasoning?: number }): string {
  if (!t) return "";
  const parts: string[] = [];
  if (t.input) parts.push(`in:${t.input}`);
  if (t.output) parts.push(`out:${t.output}`);
  if (t.reasoning) parts.push(`think:${t.reasoning}`);
  return parts.length ? `[${parts.join(", ")}]` : "";
}

function renderPart(p: MessagePart, maxTok: number, collapseLines: number, baseDir = ""): string {
  if (p.type === "text") {
    const t = (p.text || "").trim();
    return t ? `<div data-md="${escapeAttr(t)}">${renderMarkdown(t, baseDir)}</div>` : "";
  }
  if (p.type === "reasoning") {
    const t = (p.text || "").trim();
    if (!t) return "";
    const bar = tokBarHTML(partTokens(p), maxTok);
    const open = lineCount(t) <= collapseLines;
    return `<details class="reasoning"${open ? " open" : ""}><summary>💭 Reasoning<span class="sum-tools">${bar}<button type="button" class="pcbtn" title="复制此段">📋</button></span></summary><div class="tool-io" data-md="${escapeAttr(t)}">${renderMarkdown(t, baseDir)}</div></details>`;
  }
  if (p.type === "tool") {
    return renderToolPart(p, maxTok, collapseLines, baseDir);
  }
  return "";
}

function renderToolPart(p: MessagePart, maxTok: number, collapseLines: number, baseDir = ""): string {
  const tool = p.tool || "tool";
  const state = p.state || {};
  const title = state.title || tool;
  const inputJson = state.input !== undefined ? truncJson(state.input, 4000) : "";
  const outputStr = formatOutput(state.output, 4000);
  const bar = tokBarHTML(partTokens(p), maxTok);
  const tok = bar ? ` ${bar}` : "";
  const inputBlock = inputJson
    ? `<div class="tool-io"><button type="button" class="pcbtn" title="复制此段">📋</button><div style="font-size:12px;color:var(--text-muted);margin-bottom:.2rem">Input</div><pre><code class="hljs language-json">${linkifyAbsPaths(linkifySessionIDs(escapeHtml(inputJson)), baseDir)}</code></pre></div>`
    : "";
  const outputBlock = outputStr
    ? `<div class="tool-io"><button type="button" class="pcbtn" title="复制此段">📋</button><div style="font-size:12px;color:var(--text-muted);margin-bottom:.2rem">Output</div><pre><code>${linkifyAbsPaths(linkifySessionIDs(escapeHtml(outputStr)), baseDir)}</code></pre></div>`
    : "";
  const open = lineCount(inputJson) + lineCount(outputStr) <= collapseLines;
  const openAttr = open ? " open" : "";
  if (!inputBlock && !outputBlock) {
    return `<details><summary>🔧 ${escapeHtml(tool)}${tok}</summary><div class="tool-io" style="color:var(--text-muted);font-size:13px">（无输入/输出）</div></details>`;
  }
  return `<details class="tool"${openAttr}><summary>🔧 ${escapeHtml(title)}${tok}</summary>${inputBlock}${outputBlock}</details>`;
}

// opencode export carries only per-message token totals, not per-tool; this
// estimates per-tool tokens from input+output byte size (≈ bytes/4).
function toolBytes(state: ToolState): number {
  let n = 0;
  if (state.input !== undefined) n += Buffer.byteLength(JSON.stringify(state.input), "utf-8");
  const out = state.output;
  if (typeof out === "string") n += Buffer.byteLength(out, "utf-8");
  else if (out !== undefined) n += Buffer.byteLength(JSON.stringify(out), "utf-8");
  return n;
}

function estFromBytes(bytes: number): number {
  return bytes > 0 ? Math.max(1, Math.round(bytes / 4)) : 0;
}

function fmtTok(n: number): string {
  if (n <= 0) return "";
  if (n >= 1000) return `≈${(n / 1000).toFixed(1)}k tok`;
  return `≈${n} tok`;
}

function kfmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

interface CtxStats {
  current: number; peak: number; p50: number; p90: number; p99: number;
  calls: number; traffic: number; cacheHit: number; overhead: number;
}
function computeCtxStats(messages: SessionMessage[]): CtxStats {
  const totals: number[] = [];
  let traffic = 0, cacheRead = 0, inputSum = 0, current = 0;
  // Fixed overhead (system prompt + tool defs) derived from the first API call:
  // first call ctx − first user message content (mirrors acp-inspect derive_fixed_overhead).
  let firstCtx = 0, firstUserEst = 0, userSeen = false;
  for (const m of messages) {
    if (m.info.role === "user" && !userSeen) {
      userSeen = true;
      let chars = 0;
      for (const p of m.parts) if (p.type === "text") chars += (p.text ?? "").length;
      firstUserEst = Math.max(1, Math.floor(chars / 4));
    }
    const t = m.info.tokens;
    if (!t) continue;
    const ctx = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    if (ctx <= 0) continue;
    if (!firstCtx) firstCtx = ctx;
    totals.push(ctx);
    current = ctx;
    traffic += ctx + (t.output ?? 0) + (t.reasoning ?? 0);
    cacheRead += t.cache?.read ?? 0;
    inputSum += t.input ?? 0;
  }
  if (!totals.length) return { current: 0, peak: 0, p50: 0, p90: 0, p99: 0, calls: 0, traffic: 0, cacheHit: 0, overhead: 0 };
  totals.sort((a, b) => a - b);
  const at = (p: number): number => totals[Math.min(totals.length - 1, Math.floor((p / 100) * totals.length))] ?? 0;
  const denom = cacheRead + inputSum;
  return {
    current,
    peak: totals[totals.length - 1] ?? 0,
    p50: at(50), p90: at(90), p99: at(99),
    calls: totals.length, traffic,
    cacheHit: denom > 0 ? Math.round((cacheRead / denom) * 100) : 0,
    overhead: Math.max(0, firstCtx - firstUserEst),
  };
}

interface AcpLogBlock {
  blockId: number; active: boolean; createdAt: number;
  startId: string; endId: string; direct: number; effective: number;
  directMessageIds: string[];
  compressedTokens: number; summaryTokens: number; topic: string; summary: string;
}

function readAcpStats(id: string): {
  blocks: number; savedTokens: number;
  byMessageId: Record<string, { activeBlockIds?: unknown[] }>;
  blocksById: Record<string, { active?: boolean; summary?: string }>;
  logBlocks: AcpLogBlock[];
} | null {
  try {
    const p = join(homedir(), ".local/share/opencode/storage/plugin/acp", `${id}.json`);
    const d = JSON.parse(readFileSync(p, "utf-8")) as {
      stats?: { totalPruneTokens?: unknown };
      prune?: {
        messages?: {
          activeBlockIds?: unknown;
          byMessageId?: Record<string, { activeBlockIds?: unknown[] }>;
          blocksById?: Record<string, {
            blockId?: unknown; active?: boolean; createdAt?: unknown;
            startId?: string; endId?: string;
            directMessageIds?: unknown[]; effectiveMessageIds?: unknown[];
            compressedTokens?: unknown; summaryTokens?: unknown;
            topic?: string; summary?: string;
          }>;
        };
      };
    };
    const pm = d?.prune?.messages;
    const active = pm?.activeBlockIds;
    const blocks = Array.isArray(active) ? active.length : 0;
    const savedTokens = typeof d?.stats?.totalPruneTokens === "number" ? d.stats.totalPruneTokens : 0;
    const byMessageId = pm?.byMessageId ?? {};
    const blocksById = pm?.blocksById ?? {};
    const num = (v: unknown): number => typeof v === "number" && v > 0 ? v : 0;
    const logBlocks: AcpLogBlock[] = Object.entries(blocksById).map(([k, b]) => ({
      blockId: Number(k) || num(b?.blockId) || 0,
      active: b?.active !== false,
      createdAt: num(b?.createdAt),
      startId: b?.startId ?? "?",
      endId: b?.endId ?? "?",
      direct: Array.isArray(b?.directMessageIds) ? (b?.directMessageIds?.length ?? 0) : 0,
      effective: Array.isArray(b?.effectiveMessageIds) ? (b?.effectiveMessageIds?.length ?? 0) : 0,
      directMessageIds: Array.isArray(b?.directMessageIds) ? b.directMessageIds.filter((x): x is string => typeof x === "string") : [],
      compressedTokens: num(b?.compressedTokens),
      summaryTokens: num(b?.summaryTokens),
      topic: b?.topic ?? "",
      summary: b?.summary ?? "",
    })).sort((a, b) => a.blockId - b.blockId);
    return blocks || savedTokens ? { blocks, savedTokens, byMessageId, blocksById, logBlocks } : null;
  } catch {
    return null;
  }
}

function compressionLogHTML(blocks: AcpLogBlock[], savedTokens: number, sessionStart: number): string {
  const activeN = blocks.filter((b) => b.active).length;
  const elapsed = (b: AcpLogBlock): string => {
    if (!b.createdAt || !sessionStart) return "?";
    const m = Math.round((b.createdAt - sessionStart) / 60000);
    return m > 0 ? `+${m}m` : "?";
  };
  const row = (b: AcpLogBlock): string => {
    const est = Math.max(1, Math.floor(b.summary.length / 4));
    const rto = b.compressedTokens > 0 ? `${Math.round(b.compressedTokens / est)}:1` : "?";
    const msgN = b.direct === b.effective ? `${b.direct}` : b.direct === 0 ? `0→${b.effective}` : `${b.direct}→${b.effective}`;
    const st = b.active ? '<span class="acp-st on">活跃</span>' : '<span class="acp-st off">失效</span>';
    const line = `b${b.blockId} · ${st} · ${elapsed(b)} · ${escapeHtml(b.startId)}–${escapeHtml(b.endId)} · ${msgN}条 · 省${kfmt(b.compressedTokens)} · ${rto} · ${escapeHtml(b.topic.slice(0, 42))}`;
    return `<details class="acp-blk${b.active ? " on" : " off"}"><summary>${line}</summary>` +
      `<div class="acp-sum">${b.summary ? renderMarkdown(b.summary) : "<p><em>(空摘要)</em></p>"}</div></details>`;
  };
  return `<details class="acp-log"><summary>🗜 压缩日志 · ${blocks.length} 段（${activeN} 活跃 / ${blocks.length - activeN} 失效）· 共省 ${kfmt(savedTokens)}</summary>` +
    `<div class="acp-log-list">${blocks.map(row).join("")}</div></details>`;
}

// Anchor each block at its compression time (createdAt): everything above the marker
// (asc) is context that existed when the compression fired, the marker is the event,
// everything below is post-compression. This matches the "see what was there, then it
// got compressed" intent — anchoring at the last direct message instead splits the
// pre-compression context (non-compressed msgs that also predate createdAt end up after
// the marker). Falls back to last direct message only if createdAt is missing.
function computeBlockAnchors(
  msgs: SessionMessage[],
  blocks: AcpLogBlock[],
  desc: boolean,
): Map<number, AcpLogBlock[]> {
  const m = new Map<number, AcpLogBlock[]>();
  for (const b of blocks) {
    let anchor = -1;
    if (b.createdAt) {
      for (let i = 0; i < msgs.length; i++) {
        const mt = msgs[i]?.info.time?.created ?? 0;
        const beforeSeam = desc ? mt >= b.createdAt : mt <= b.createdAt;
        if (beforeSeam) anchor = i; else break;
      }
    }
    if (anchor < 0) {
      const id2idx = new Map<string, number>();
      for (let i = 0; i < msgs.length; i++) { const id = msgs[i]?.info?.id; if (id) id2idx.set(id, i); }
      for (const id of b.directMessageIds) {
        const idx = id2idx.get(id);
        if (idx !== undefined && idx > anchor) anchor = idx;
      }
    }
    if (anchor < 0) continue;
    const arr = m.get(anchor);
    if (arr) arr.push(b); else m.set(anchor, [b]);
  }
  return m;
}

function compressionMarkerHTML(b: AcpLogBlock): string {
  const est = Math.max(1, Math.floor(b.summary.length / 4));
  const rto = b.compressedTokens > 0 ? `${Math.round(b.compressedTokens / est)}:1` : "?";
  const msgN = b.direct === b.effective ? `${b.direct}` : b.direct === 0 ? `0→${b.effective}` : `${b.direct}→${b.effective}`;
  const st = b.active ? '<span class="acp-st on">活跃</span>' : '<span class="acp-st off">失效</span>';
  const line = `b${b.blockId} · ${st} · ${escapeHtml(b.startId)}–${escapeHtml(b.endId)} · ${msgN}条 · 省${kfmt(b.compressedTokens)} · ${rto}`;
  const sumMd = b.summary ? escapeAttr(b.summary) : "";
  const sumHtml = b.summary ? renderMarkdown(b.summary) : "<p><em>(空摘要)</em></p>";
  const acts = `<div class="msg-actions acp-acts"><button type="button" class="cbtn" title="复制摘要">📋</button><button type="button" class="ttsstop" title="停止朗读">⏹</button><button type="button" class="ttsbtn" title="朗读摘要">🔊</button><button type="button" class="tbtn" title="翻译摘要">翻译</button></div>`;
  return `<details class="acp-mark${b.active ? " on" : " off"}"><summary>🗜 压缩 ${line}${b.topic ? ` · ${escapeHtml(b.topic.slice(0, 48))}` : ""}</summary>` +
    `<div class="acp-sum"><div data-md="${sumMd}">${sumHtml}</div></div>${acts}</details>`;
}

interface CtxBreakdown {
  tool: number; code: number; text: number; summary: number; total: number;
  topTools: { name: string; tokens: number }[];
}

// Post-prune context composition (mirrors acp-inspect --breakdown): a message
// covered by an active block is hidden; its summary replaces the range. Reasoning
// is skipped (runtime-stripped); tokens are chars/4 (no per-part API counts).
function computeCtxBreakdown(
  messages: SessionMessage[],
  byMessageId: Record<string, { activeBlockIds?: unknown[] }>,
  blocksById: Record<string, { active?: boolean; summary?: string }>,
): CtxBreakdown {
  let toolC = 0, codeC = 0, textC = 0;
  const toolByName = new Map<string, number>();
  for (const m of messages) {
    const active = byMessageId[m.info.id]?.activeBlockIds;
    if (Array.isArray(active) && active.length > 0) continue;
    for (const p of m.parts) {
      if (p.type === "reasoning") continue;
      if (p.type === "tool") {
        const out = typeof p.state?.output === "string" ? p.state.output : JSON.stringify(p.state?.output ?? "");
        const inp = JSON.stringify(p.state?.input ?? "");
        const c = out.length + inp.length;
        toolC += c;
        const name = p.tool || "?";
        toolByName.set(name, (toolByName.get(name) ?? 0) + c);
      } else if (p.type === "text") {
        const t = p.text ?? "";
        if (t.includes("```")) codeC += t.length; else textC += t.length;
      }
    }
  }
  let summaryC = 0;
  for (const key of Object.keys(blocksById)) {
    const b = blocksById[key];
    if (b?.active !== false) summaryC += (b?.summary ?? "").length;
  }
  const tok = (c: number): number => Math.max(1, Math.floor(c / 4));
  const tool = tok(toolC), code = tok(codeC), text = tok(textC), summary = tok(summaryC);
  const total = tool + code + text + summary;
  const topTools = [...toolByName.entries()]
    .map(([name, c]) => ({ name, tokens: tok(c) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);
  return { tool, code, text, summary, total, topTools };
}

function ctxBreakdownStr(bd: CtxBreakdown, current: number, overhead: number): string {
  const denom = current > 0 ? current : bd.total;
  const pct = (v: number) => (denom > 0 ? Math.round((v * 100) / denom) : 0);
  const cats = [
    { label: "工具", v: bd.tool },
    { label: "摘要", v: bd.summary },
    { label: "代码", v: bd.code },
    { label: "文本", v: bd.text },
  ].filter((x) => x.v > 0).sort((a, b) => b.v - a.v)
    .map((x) => `${x.label} ${pct(x.v)}%`)
    .join(" · ");
  const ohStr = overhead > 0 ? ` · 系统/工具定义 ${pct(overhead)}%` : "";
  const top = bd.topTools.filter((t) => t.tokens > 0)
    .map((t) => `${t.name} ${pct(t.tokens)}%`).join(" · ");
  return `${cats}${ohStr}${top ? ` · top: ${top}` : ""}`;
}

function lineCount(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function partTokens(p: MessagePart): number {
  if (p.type === "reasoning") return estFromBytes(Buffer.byteLength(p.text || "", "utf-8"));
  if (p.type === "tool" && p.state) return estFromBytes(toolBytes(p.state));
  return 0;
}

function computeMaxMsgTok(messages: SessionMessage[]): number {
  let max = 0;
  for (const m of messages) {
    const n = m.parts.reduce((s, p) => s + partTokens(p), 0);
    if (n > max) max = n;
  }
  return max;
}

// Bar width ∝ n/maxTok (session max = full); hue goes green(120)→red(0) as it grows.
function tokBarHTML(n: number, maxTok: number, withText = true): string {
  if (n <= 0 || maxTok <= 0) return "";
  const pct = Math.max(4, Math.min(100, Math.round((n / maxTok) * 100)));
  const hue = Math.round(120 * (1 - pct / 100));
  const text = withText ? `<span class="ttok">${fmtTok(n)}</span>` : "";
  return `<span class="tbar"><span class="tbar-fill" style="width:${pct}%;background:hsl(${hue},65%,45%)"></span></span>${text}`;
}

function formatOutput(out: unknown, limit: number): string {
  if (out === undefined || out === null || out === "") return "";
  if (typeof out === "string") return truncate(out, limit);
  return truncate(JSON.stringify(out, null, 2), limit);
}

function truncJson(v: unknown, limit: number): string {
  return truncate(JSON.stringify(v, null, 2), limit);
}

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n… (truncated, ${s.length} total)`;
}

function messageSize(msg: SessionMessage): number {
  let total = 0;
  for (const p of msg.parts) {
    if (p.type === "text" || p.type === "reasoning") {
      total += Buffer.byteLength(p.text || "", "utf-8");
    } else if (p.type === "tool" && p.state) {
      if (p.state.input !== undefined) total += Buffer.byteLength(JSON.stringify(p.state.input), "utf-8");
      const out = p.state.output;
      if (typeof out === "string") total += Buffer.byteLength(out, "utf-8");
      else if (out !== undefined) total += Buffer.byteLength(JSON.stringify(out), "utf-8");
    }
  }
  return total;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtMs(ms: number): string {
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return String(ms);
  }
}

function relTimeMs(ms: number): string {
  if (!ms) return "";
  const d = (Date.now() - ms) / 1000;
  if (d < 3600) return Math.max(1, Math.floor(d / 60)) + "分前";
  if (d < 86400) return Math.floor(d / 3600) + "时前";
  if (d < 86400 * 30) return Math.floor(d / 86400) + "天前";
  return new Date(ms).toISOString().slice(0, 10);
}

export { LIST_LIMIT };
