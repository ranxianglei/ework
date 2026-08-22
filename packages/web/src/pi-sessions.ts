import { readFileSync } from "fs";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { THEME_CSS, escapeHtml, escapeAttr } from "./render/layout";
import { renderMarkdown } from "./render/markdown";

interface PiEvent {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown; toolCallId?: string; output?: unknown }>;
    usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number };
    model?: string;
  };
  cwd?: string;
}

interface PiToolCall {
  id: string;
  name: string;
  args: string;
  result?: string;
}

interface PiCard {
  ts: string;
  role: "user" | "assistant";
  model?: string;
  textParts: string[];
  reasoning: string[];
  tools: PiToolCall[];
  tok?: string;
}

function sessionsRoot(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR
    ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
}

function findPiSessionFile(sessionId: string): string | null {
  if (!/^[0-9a-f-]{16,64}$/i.test(sessionId)) return null;
  const root = sessionsRoot();
  if (!existsSync(root)) return null;
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (st.isFile() && e.includes(sessionId) && e.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root, 0);
  out.sort();
  return out[out.length - 1] ?? null;
}

function fmtTs(ts: string): string {
  return ts ? ts.replace("T", " ").replace(/\.\d+Z$/, "Z").slice(5, 19) : "";
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function resultText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output.slice(0, 4000);
  try { return JSON.stringify(output).slice(0, 4000); } catch { return String(output); }
}

function toolCard(t: PiToolCall): string {
  const argStr = t.args.length > 600 ? t.args.slice(0, 600) + "…" : t.args;
  return `<details class="pi-tool"><summary>🔧 ${escapeHtml(t.name)}<span class="pi-tool-args">${escapeHtml(argStr)}</span></summary><div class="tool-io"><pre>${escapeHtml(t.result ? resultText(t.result).slice(0, 4000) : "(无返回)")}</pre></div></details>`;
}

function renderCard(c: PiCard): string {
  const isUser = c.role === "user";
  const parts: string[] = [];
  for (const r of c.reasoning) {
    if (!r.trim()) continue;
    parts.push(`<details class="reasoning"><summary>💭 Reasoning</summary><div class="tool-io" data-md="${escapeAttr(r.slice(0, 8000))}">${renderMarkdown(r.slice(0, 8000))}</div></details>`);
  }
  for (const t of c.tools) parts.push(toolCard(t));
  for (const tx of c.textParts) {
    if (!tx.trim()) continue;
    parts.push(`<div data-md="${escapeAttr(tx.slice(0, 20000))}">${renderMarkdown(tx.slice(0, 20000))}</div>`);
  }
  return `<div class="msg ${isUser ? "msg-u" : "msg-a"}">
  <div class="mh">
    <span class="role ${isUser ? "role-u" : "role-a"}">${isUser ? "👤 User" : "🤖 Assistant"}</span>
    ${c.model ? `<span class="model">${escapeHtml(c.model)}</span>` : ""}
    ${c.tok ? `<span class="tok">${c.tok}</span>` : ""}
    <span class="when">${escapeHtml(fmtTs(c.ts))}</span>
  </div>
  <div class="mb">${parts.join("") || "<p><em>(无文本输出)</em></p>"}</div>
</div>`;
}

export function buildPiSessionPage(sessionId: string, limit: number, asc = false): string | null {
  const file = findPiSessionFile(sessionId);
  if (!file) return null;
  const raw = readFileSync(file, "utf8");
  const events: PiEvent[] = [];
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try { events.push(JSON.parse(l) as PiEvent); } catch { /* skip torn tail line */ }
  }

  const cards: PiCard[] = [];
  const openTools = new Map<string, PiToolCall>();
  const seenContent = new Set<string>();
  let inputTok = 0, outputTok = 0, cacheTok = 0, peakTok = 0;
  let cwd = "";
  let first = "", last = "";
  for (const e of events) {
    if (e.type === "session" && e.cwd) cwd = e.cwd;
    if (e.timestamp) {
      if (!first) first = e.timestamp;
      last = e.timestamp;
    }
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    // pi re-emits identical message content as new events (streaming steps,
    // re-persisted context, repeated tool results). Collapse exact repeats —
    // usage excluded from the key so re-emissions still merge, and their
    // (identical) usage is only counted once.
    const contentKey = `${m.role ?? ""}\u0000${JSON.stringify(m.content ?? [])}`;
    if (seenContent.has(contentKey)) continue;
    seenContent.add(contentKey);
    const u = m.usage;
    if (u) {
      inputTok += u.input ?? 0;
      outputTok += u.output ?? 0;
      cacheTok += u.cacheRead ?? 0;
      peakTok = Math.max(peakTok, u.totalTokens ?? 0);
    }
    if (m.role === "user") {
      const text = (m.content ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join("\n");
      cards.push({ ts: e.timestamp ?? "", role: "user", textParts: text ? [text] : [], reasoning: [], tools: [] });
    } else if (m.role === "assistant") {
      const card: PiCard = { ts: e.timestamp ?? "", role: "assistant", model: m.model, textParts: [], reasoning: [], tools: [], tok: u?.output ? `↗ ${fmtNum(u.output)}` : undefined };
      for (const p of m.content ?? []) {
        if (p.type === "thinking" && p.thinking) card.reasoning.push(p.thinking);
        else if (p.type === "text" && p.text) card.textParts.push(p.text);
        else if (p.type === "toolCall") {
          const tc: PiToolCall = {
            id: p.toolCallId ?? `t${openTools.size}`,
            name: p.name ?? "?",
            args: (() => { try { return typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {}); } catch { return "{}"; } })(),
          };
          card.tools.push(tc);
          openTools.set(tc.id, tc);
        }
      }
      cards.push(card);
    } else {
      for (const p of m.content ?? []) {
        if (p.type === "toolResult") {
          const key = p.toolCallId ?? [...openTools.keys()].pop();
          const tc = key ? openTools.get(key) : undefined;
          if (tc) tc.result = resultText(p.output);
        }
      }
    }
  }

  const total = cards.length;
  const shown = asc ? cards.slice(Math.max(0, total - limit)) : cards.slice(Math.max(0, total - limit)).reverse();
  const truncated = total > limit;
  const title = `pi · ${sessionId.slice(0, 13)}…`;

  const qs = (over: Record<string, string>) => {
    const params = new URLSearchParams(over);
    return `?${params.toString()}`;
  };
  const moreHref = qs({ limit: String(Math.min(5000, limit * 3)) });
  const allHref = qs({ limit: "5000" });
  const ordBtn = (mode: "asc" | "desc") =>
    `<a class="ord-btn ${asc === (mode === "asc") ? "active" : ""}" href="${qs({ limit: String(limit), asc: mode === "asc" ? "1" : "0" })}">${mode === "asc" ? "正序" : "倒序"}</a>`;

  const body = shown.map(renderCard).join("");
  const moreBar = truncated
    ? `<div class="more-bar">共 ${total} 条，当前显示最新 ${limit} 条 · <a href="${moreHref}">加载更多</a> · <a href="${allHref}">查看全部</a></div>`
    : "";

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${THEME_CSS}
.meta-bar{max-width:900px;margin:0 auto;padding:.8rem 1rem .2rem}
.meta-bar h1{font-size:17px;margin:0 0 .35rem;overflow-wrap:anywhere}
.meta-status{display:flex;gap:.6rem;flex-wrap:wrap;font-size:12px;color:var(--text-muted)}
.meta-status .sid{font-family:ui-monospace,monospace}
.mbar{max-width:900px;margin:.6rem auto;padding:0 1rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.mbar .note{font-size:12px;color:var(--text-muted)}
.ord{margin-left:auto;display:flex;gap:.3rem}
.ord-btn{padding:.25rem .7rem;border-radius:6px;border:1px solid var(--border);font-size:12px;color:var(--text-muted);text-decoration:none}
.ord-btn.active{background:var(--bg-muted);color:var(--text);font-weight:600}
#mlist{max-width:900px;margin:0 auto;padding:.5rem 1rem 3rem}
.msg{position:relative;background:var(--bg-elev);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:8px;padding:.6rem .9rem;margin-bottom:1rem;overflow:hidden}
.msg.msg-u{border-left-color:var(--human);background:color-mix(in srgb,var(--human) 4%,var(--bg-elev))}
.msg.msg-a{border-left-color:var(--bot);background:color-mix(in srgb,var(--bot) 4%,var(--bg-elev))}
.mh{display:flex;align-items:center;gap:.5rem;font-size:13px;flex-wrap:wrap;margin-bottom:.35rem}
.mh .role{font-weight:600;font-size:11px;padding:.05rem .45rem;border-radius:4px;line-height:1.7}
.mh .role-u{background:color-mix(in srgb,var(--human) 18%,transparent);color:var(--human)}
.mh .role-a{background:color-mix(in srgb,var(--bot) 18%,transparent);color:var(--bot)}
.mh .model{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text-muted)}
.mh .when{color:var(--text-muted);font-size:12px;margin-left:auto}
.mh .tok{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--text-muted)}
.mb{overflow-wrap:anywhere;word-break:break-word;line-height:1.55}
.mb p{margin:.4rem 0}
.mb pre{background:var(--code-bg);padding:.6rem;border-radius:6px;overflow:auto;font-size:12.5px}
.mb code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;font-size:12.5px}
.mb details{margin:.3rem 0;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.mb summary{cursor:pointer;padding:.4rem .6rem;background:var(--bg-muted);font-size:13px;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.mb details.reasoning{border-left:3px solid color-mix(in srgb,var(--system) 45%,transparent)}
.mb details.reasoning>.tool-io{background:color-mix(in srgb,var(--system) 7%,var(--bg-elev))}
.mb .tool-io{position:relative;padding:.5rem .6rem}
.mb .tool-io pre{margin:.2rem 0}
.pi-tool summary .pi-tool-args{font-family:ui-monospace,monospace;font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.more-bar{max-width:900px;margin:1rem auto 0;padding:.8rem 1rem;text-align:center;border:1px dashed var(--border);border-radius:8px;color:var(--text-muted);font-size:13px}
.more-bar a{font-weight:600}
</style></head><body>
<header class="nav" style="display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px;flex-wrap:wrap">
  <a href="/" style="color:var(--header-text)">🏠</a><span style="opacity:.5">/</span>
  <a href="/sessions" style="color:var(--header-text)">会话</a><span style="opacity:.5">/</span>
  <span style="opacity:.85">${escapeHtml(title)}</span>
</header>
<div class="meta-bar">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta-status">
    <span class="sid">${escapeHtml(sessionId)}</span>
    ${cwd ? `<span>📁 ${escapeHtml(dirname(cwd))}</span>` : ""}
    ${first ? `<span>创建 ${escapeHtml(fmtTs(first))}</span>` : ""}
    ${last ? `<span>更新 ${escapeHtml(fmtTs(last))}</span>` : ""}
    <span>${total} 条消息</span>
    <span>🧮 峰值 ${fmtNum(peakTok)} · 累计 ↗ ${fmtNum(outputTok)} · cache ${fmtNum(cacheTok)}</span>
  </div>
</div>
<div class="mbar">
  <span class="note">📖 只读 · pi 运行时会话</span>
  <span class="ord">${ordBtn("asc")}${ordBtn("desc")}</span>
</div>
<main id="mlist">${body || `<div style="padding:2rem;text-align:center;color:var(--text-muted)">此会话没有消息</div>`}${moreBar}</main>
</body></html>`;
}
