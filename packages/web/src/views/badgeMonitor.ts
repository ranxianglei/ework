import type { UserRow } from "../store";
import type { AiStatusBadgeRow } from "../store";
import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";

export interface DaemonBadgeEntry {
  owner: string;
  repo: string;
  number: number;
  aiStatus: string;
  since: number | null;
  engineRecord: boolean;
  ownedByMe: boolean;
  sessions: number;
  pidAlive: boolean;
  outputAgeSec: number | null;
  modelAgeSec: number | null;
  verdict: "alive" | "stale" | "orphan" | "skipped";
  action?: string;
}

export interface DaemonBadgeReport {
  daemonId: number;
  endpoint: string;
  reachable: boolean;
  checkedAt: number;
  intervalMs: number;
  entries: DaemonBadgeEntry[];
}

const VERDICT_LABEL: Record<DaemonBadgeEntry["verdict"], { text: string; cls: string }> = {
  alive: { text: "存活", cls: "ok" },
  stale: { text: "卡死", cls: "err" },
  orphan: { text: "孤儿", cls: "warn" },
  skipped: { text: "跳过", cls: "" },
};

function ageText(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

function signalCell(v: boolean | null): string {
  if (v === null) return `<span class="muted">—</span>`;
  return v ? `<span class="sig ok">✓</span>` : `<span class="sig err">✗</span>`;
}

function entryRow(e: DaemonBadgeEntry): string {
  const v = VERDICT_LABEL[e.verdict] ?? VERDICT_LABEL.skipped;
  const issue = `/issues/${escapeAttr(e.owner)}/${escapeAttr(e.repo)}/${e.number}`;
  const action = e.action ? `<div class="act">${escapeHtml(e.action)}</div>` : "";
  return `<tr>
    <td><a href="${issue}">${escapeHtml(e.owner + "/" + e.repo + "#" + e.number)}</a></td>
    <td>${escapeHtml(e.aiStatus || "(空)")}</td>
    <td>${e.engineRecord ? "有" : "<span class='err'>无</span>"}</td>
    <td>${e.sessions}</td>
    <td>${signalCell(e.pidAlive)}</td>
    <td title="会话输出年龄">${ageText(e.outputAgeSec)}</td>
    <td title="模型流量年龄">${ageText(e.modelAgeSec)}</td>
    <td><span class="badge ${v.cls}">${v.text}</span></td>
    <td>${action}</td>
  </tr>`;
}

function daemonSection(d: DaemonBadgeReport): string {
  if (!d.reachable) {
    return `<section class="daemon">
      <h2>daemon #${d.daemonId} <span class="badge err">不可达</span></h2>
      <p class="hint">GET ${escapeHtml(d.endpoint)}/api/badges 失败</p>
    </section>`;
  }
  const rows = d.entries.length > 0
    ? d.entries.map(entryRow).join("")
    : `<tr><td colspan="9" class="empty">该 daemon 视角下没有 processing 徽标</td></tr>`;
  const stale = d.entries.filter((e) => e.verdict === "stale" || e.verdict === "orphan").length;
  return `<section class="daemon">
    <h2>daemon #${d.daemonId}
      <span class="badge ${stale > 0 ? "err" : "ok"}">${stale > 0 ? stale + " 异常" : "正常"}</span>
      <span class="muted">扫描间隔 ${Math.round(d.intervalMs / 1000)}s · 上次 ${new Date(d.checkedAt).toLocaleString()}</span>
    </h2>
    <table class="tbl">
      <thead><tr><th>issue</th><th>状态</th><th>引擎记录</th><th>会话数</th><th>pid</th><th>输出</th><th>模型</th><th>判定</th><th>动作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

export function buildBadgeMonitorPage(
  viewer: UserRow,
  webBadges: AiStatusBadgeRow[],
  daemons: DaemonBadgeReport[],
  nowMs: number,
): string {
  const webRows = webBadges.length > 0
    ? webBadges.map((b) => {
        const since = b.since ? Date.parse(b.since) : null;
        const age = since ? ageText((nowMs - since) / 1000) : "未知";
        return `<tr>
          <td><a href="/issues/${escapeAttr(b.owner)}/${escapeAttr(b.repo)}/${b.number}">${escapeHtml(b.owner + "/" + b.repo + "#" + b.number)}</a></td>
          <td>${escapeHtml(b.aiStatus)}</td>
          <td>${b.since ? escapeHtml(b.since) : "—"}</td>
          <td>${age}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" class="empty">web 侧当前没有 processing 徽标</td></tr>`;

  const daemonSections = daemons.length > 0
    ? daemons.map(daemonSection).join("\n")
    : `<p class="hint">没有活跃 daemon(心跳超过 2 分钟)</p>`;

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ework-web · Processing 徽标监控</title>
<style>${THEME_CSS}
.nav{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px}
.nav a{color:var(--header-text);opacity:.95}
.wrap{max-width:1200px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .3rem}
.hint{color:var(--text-muted);font-size:13px;margin:0 0 1rem}
h2{font-size:15px;margin:1.2rem 0 .4rem}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th,.tbl td{border-bottom:1px solid var(--border);padding:.4rem .5rem;text-align:left;vertical-align:top}
.tbl th{color:var(--text-muted);font-weight:600}
.badge{padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}
.badge.ok{background:#3fb95033;color:#3fb950}
.badge.err{background:#f8514933;color:#f85149}
.badge.warn{background:#d2992233;color:#d29922}
.sig.ok{color:#3fb950}.sig.err{color:#f85149}
.muted{color:var(--text-muted);font-size:12px}
.empty{color:var(--text-muted);text-align:center;padding:1rem}
.act{font-size:12px;color:var(--text-muted)}
section.daemon{margin-bottom:1.5rem}
</style></head>
<body>
<nav class="nav">${tabNavHTML("projects", viewer)}</nav>
<div class="wrap">
<h1>Processing 徽标监控</h1>
<p class="hint">web 侧全部 processing 徽标 + 各 daemon 卡死探测器的三信号状态(pid 存活 / 会话输出 / 模型流量)。卡死探测器每分钟扫描,孤儿徽标自动仲裁。</p>
<h2>Web 侧 processing 列表(${webBadges.length})</h2>
<table class="tbl">
<thead><tr><th>issue</th><th>状态</th><th>写入时间</th><th>徽标年龄</th></tr></thead>
<tbody>${webRows}</tbody>
</table>
${daemonSections}
</div>
</body></html>`;
}
