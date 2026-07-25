import { type DeliveryWithWebhookRow } from "../webhooks";
import { type UserRow } from "../store";
import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";

function statusClass(status: number | null): string {
  if (status === null) return "err";
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400 && status < 500) return "warn";
  return "err";
}

function deliveryRowHtml(d: DeliveryWithWebhookRow): string {
  const status = d.response_status === null ? "—" : String(d.response_status);
  const cls = statusClass(d.response_status);
  const project = d.project_owner
    ? `<a href="/${escapeAttr(d.project_owner)}/${escapeAttr(d.project_name ?? "")}">${escapeHtml(d.project_owner + "/" + (d.project_name ?? ""))}</a>`
    : "<em>(deleted)</em>";
  const url = d.webhook_url ? `<code class="url">${escapeHtml(d.webhook_url)}</code>` : "<em>(deleted)</em>";
  const err = d.error ? `<div class="derr">${escapeHtml(d.error)}</div>` : "";
  const body = d.response_body
    ? `<details class="dbody"><summary>响应</summary><pre>${escapeHtml(d.response_body)}</pre></details>`
    : "";
  const payload = `<details class="dpl"><summary>payload</summary><pre>${escapeHtml(d.payload)}</pre></details>`;
  return `<tr>
    <td class="ts">${escapeHtml(d.created_at)}</td>
    <td class="proj">${project}</td>
    <td class="ev">${escapeHtml(d.event)}</td>
    <td class="url">${url}</td>
    <td class="st ${cls}">${status}</td>
    <td class="ms">${d.duration_ms === null ? "—" : d.duration_ms + "ms"}</td>
    <td class="act">${payload}${body}${err}</td>
  </tr>`;
}

export function buildWebhookDeliveriesPage(viewer: UserRow, deliveries: DeliveryWithWebhookRow[]): string {
  const rows = deliveries.length > 0
    ? deliveries.map(deliveryRowHtml).join("")
    : `<tr><td colspan="7" class="empty">暂无投递记录</td></tr>`;

  const ok = deliveries.filter((d) => d.response_status !== null && d.response_status >= 200 && d.response_status < 300).length;
  const fail = deliveries.filter((d) => d.response_status === null || d.response_status >= 400).length;
  const summary = deliveries.length > 0
    ? `<div class="summary"><span class="badge ok">${ok} 成功</span> <span class="badge ${fail > 0 ? "err" : ""}">${fail} 失败</span> <span class="muted">最近 ${deliveries.length} 条</span></div>`
    : "";

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ework-web · Webhook 投递记录</title>
<style>${THEME_CSS}
.nav{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px}
.nav a{color:var(--header-text);opacity:.95}
.wrap{max-width:1100px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .3rem}
.hint{color:var(--text-muted);font-size:13px;margin:0 0 1rem}
.summary{margin-bottom:.8rem;display:flex;gap:.5rem;align-items:center}
.badge{padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}
.badge.ok{background:#3fb95033;color:#3fb950}
.badge.err{background:#f8514933;color:#f85149}
.muted{color:var(--text-muted);font-size:12px}
.dtable{width:100%;border-collapse:collapse;font-size:12px}
.dtable th,.dtable td{border:1px solid var(--border);padding:.3rem .4rem;text-align:left;vertical-align:top}
.dtable th{background:var(--bg);color:var(--text-muted);font-weight:600;position:sticky;top:0}
.dtable .ts{white-space:nowrap;font-family:ui-monospace,monospace}
.dtable .proj{white-space:nowrap}
.dtable .proj a{color:var(--accent)}
.dtable .ev{white-space:nowrap;font-family:ui-monospace,monospace}
.dtable .url{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dtable .url code{font-family:ui-monospace,monospace;font-size:11px;color:var(--text-muted)}
.dtable .st.ok{color:#3fb950;font-weight:600}
.dtable .st.warn{color:#d29922;font-weight:600}
.dtable .st.err{color:#f85149;font-weight:600}
.dtable .ms{color:var(--text-muted);white-space:nowrap}
.dbody pre,.dpl pre{font-size:11px;max-height:240px;overflow:auto;background:var(--bg);padding:.4rem;border-radius:5px;border:1px solid var(--border);white-space:pre-wrap;word-break:break-all}
.derr{color:#f85149;font-size:11px;margin-top:.2rem}
.empty{color:var(--text-muted);text-align:center;padding:.6rem}
.tabs{display:flex;gap:.3rem;padding:.5rem 1rem;border-bottom:1px solid var(--border);font-size:13px}
.tab{padding:.3rem .7rem;border-radius:6px 6px 0 0;text-decoration:none;color:var(--text-muted)}
.tab.active{background:var(--accent);color:#fff}
</style></head><body>
<header class="nav"><a href="/" style="color:var(--header-text)">🏠 ework-web</a></header>
${tabNavHTML("projects", viewer)}
<main class="wrap">
<h1>Webhook 投递记录</h1>
<p class="hint">所有项目的 webhook 投递历史。用于排查 "AI 没回应" 类问题 — 如果投递失败（红色状态码），daemon 根本没收到事件。</p>
${summary}
<table class="dtable"><thead><tr>
  <th>时间</th><th>项目</th><th>事件</th><th>目标 URL</th><th>状态</th><th>耗时</th><th>详情</th>
</tr></thead><tbody>${rows}</tbody></table>
</main></body></html>`;
}
