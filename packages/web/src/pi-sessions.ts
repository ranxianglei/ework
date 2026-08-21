import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { THEME_CSS, escapeHtml } from "./render/layout";

interface PiEvent {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; thinking?: string; name?: string }>;
  };
}

export function findPiSessionFile(sessionId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const root = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(homedir(), ".pi/agent/sessions");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = join(root, dir.name);
    try {
      const hit = readdirSync(full).find((f) => f.endsWith(`_${sessionId}.jsonl`));
      if (hit) return join(full, hit);
    } catch {
      // unreadable project dir — skip
    }
  }
  return null;
}

export function buildPiSessionPage(sessionId: string, limit = 200): string | null {
  const file = findPiSessionFile(sessionId);
  if (!file) return null;

  const entries: { ts: string; role: string; text: string }[] = [];
  const raw = readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: PiEvent;
    try {
      ev = JSON.parse(line) as PiEvent;
    } catch {
      continue;
    }
    if (ev.type !== "message" || !ev.message?.role) continue;
    const role = ev.message.role;
    const parts = ev.message.content ?? [];
    let text = "";
    for (const p of parts) {
      if (p.type === "text" && p.text) text += p.text + "\n";
      else if (p.type === "toolCall") text += `→ [tool] ${p.name ?? "?"}\n`;
    }
    if (role === "toolResult") text = text || "[tool output]\n";
    if (!text.trim()) continue;
    entries.push({ ts: (ev.timestamp ?? "").slice(11, 19), role, text: text.trim() });
  }
  const tail = entries.slice(-limit);
  const rows = tail
    .map(
      (e) =>
        `<div class="pi-row pi-${escapeHtml(e.role)}"><span class="pi-ts">${escapeHtml(e.ts)}</span><span class="pi-role">${escapeHtml(e.role)}</span><pre>${escapeHtml(e.text.slice(0, 4000))}</pre></div>`,
    )
    .join("\n");
  const shown = tail.length;
  const total = entries.length;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi session ${escapeHtml(sessionId)}</title>
<style>${THEME_CSS}
.pi-wrap{max-width:980px;margin:0 auto;padding:.6rem 1rem 3rem}
.pi-row{border:1px solid var(--border);border-radius:8px;padding:.5rem .7rem;margin:.45rem 0;background:var(--bg-elev)}
.pi-row pre{margin:.3rem 0 0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace}
.pi-ts{color:var(--text-muted);font-size:11px;margin-right:.6rem}
.pi-role{font-size:11px;font-weight:600;color:var(--accent)}
.pi-assistant{border-left:3px solid var(--accent)}
.pi-user{border-left:3px solid var(--green)}
.pi-toolResult{border-left:3px solid var(--border);opacity:.85}
</style></head><body>
<header class="topbar"><a href="/" title="ework 主页" style="color:var(--header-text)">🏠</a></header>
<div class="pi-wrap">
<h2>pi 会话 <code>${escapeHtml(sessionId)}</code></h2>
<p style="color:var(--text-muted);font-size:12px">显示最近 ${shown} / 共 ${total} 条消息事件 · <a href="?limit=2000">加载更多</a></p>
${rows || '<p style="color:var(--text-muted)">（会话文件为空）</p>'}
</div></body></html>`;
}
