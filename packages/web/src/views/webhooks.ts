// Webhook management page for a project: list existing webhooks, add new ones,
// toggle active, delete, send test ping, view recent delivery history per hook.

import {
  type WebhookRow,
  type WebhookDeliveryRow,
} from "../webhooks";
import { type ProjectRow } from "../store";
import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";
import { projectSettingsTabsHTML } from "./projectUpstreams";

function statusClass(status: number | null): string {
  if (status === null) return "err";
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400 && status < 500) return "warn";
  return "err";
}

function deliveryRowHtml(d: WebhookDeliveryRow): string {
  const status = d.response_status === null ? "—" : String(d.response_status);
  const cls = statusClass(d.response_status);
  const err = d.error ? `<div class="derr">${escapeHtml(d.error)}</div>` : "";
  const body = d.response_body
    ? `<details class="dbody"><summary>响应</summary><pre>${escapeHtml(d.response_body)}</pre></details>`
    : "";
  const payload = `<details class="dpl"><summary>payload</summary><pre>${escapeHtml(d.payload)}</pre></details>`;
  return `<tr>
    <td class="ts">${escapeHtml(d.created_at)}</td>
    <td class="ev">${escapeHtml(d.event)}</td>
    <td class="uuid" title="${escapeAttr(d.delivery_uuid)}">${escapeHtml(d.delivery_uuid.slice(0, 8))}</td>
    <td class="st ${cls}">${status}</td>
    <td class="ms">${d.duration_ms === null ? "—" : d.duration_ms + "ms"}</td>
    <td class="act">${payload}${body}${err}</td>
  </tr>`;
}

function webhookCardHtml(wh: WebhookRow, deliveries: WebhookDeliveryRow[]): string {
  const recent = deliveries.slice(0, 10);
  const rows = recent.map(deliveryRowHtml).join("") || `<tr><td colspan="6" class="empty">暂无投递记录</td></tr>`;
  const events = (() => {
    try {
      return (JSON.parse(wh.events) as string[]).join(", ") || "(none)";
    } catch {
      return "(invalid)";
    }
  })();
  return `<section class="wh">
    <header class="wh-head">
      <h3>#${wh.id} · <code>${escapeHtml(wh.url)}</code></h3>
      <div class="wh-meta">
        <span class="badge ${wh.active ? "on" : "off"}">${wh.active ? "启用" : "停用"}</span>
        <span class="ev-list">订阅: ${escapeHtml(events)}</span>
        <span class="secret">secret: ${wh.secret ? "•••• (" + wh.secret.length + " chars)" : "<em>无</em>"}</span>
      </div>
    </header>
    <form class="wh-actions" method="POST" action="/__wh/${wh.id}/toggle">
      <input type="hidden" name="_method" value="toggle">
      <button type="submit" name="active" value="${wh.active ? "0" : "1"}">${wh.active ? "停用" : "启用"}</button>
    </form>
    <form class="wh-actions" method="POST" action="/__wh/${wh.id}/test">
      <button type="submit">发送测试 ping</button>
    </form>
    <form class="wh-actions" method="POST" action="/__wh/${wh.id}/delete" onsubmit="return confirm('删除 webhook #${wh.id}?')">
      <button type="submit" class="danger">删除</button>
    </form>
    <details class="deliv">
      <summary>近期投递（最多 10 条）</summary>
      <table class="dtable"><thead><tr>
        <th>时间</th><th>事件</th><th>delivery</th><th>状态</th><th>耗时</th><th>详情</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </details>
  </section>`;
}

export interface WebhooksPageInput {
  project: ProjectRow;
  webhooks: WebhookRow[];
  deliveriesByWebhook: Map<number, WebhookDeliveryRow[]>;
}

export function buildWebhooksPage(input: WebhooksPageInput): string {
  const { project, webhooks, deliveriesByWebhook } = input;
  const cards =
    webhooks
      .map((wh) => webhookCardHtml(wh, deliveriesByWebhook.get(wh.id) ?? []))
      .join("") || `<p class="empty-page">这个项目还没有 webhook。<br>用下面的表单添加一个。</p>`;

  const formAction = `/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/webhooks`;
  const settingsTabs = projectSettingsTabsHTML(project.owner, project.name, "webhooks");
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ework-web · ${escapeHtml(project.owner + "/" + project.name)} · Webhooks</title>
<style>${THEME_CSS}
.nav{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px}
.nav a{color:var(--header-text);opacity:.95}
.wrap{max-width:920px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .3rem}
h2{font-size:15px;margin:1.2rem 0 .5rem}
h3{font-size:14px;margin:0 0 .3rem}
.hint{color:var(--text-muted);font-size:13px;margin:0 0 1rem}
.crumb{font-size:13px;color:var(--text-muted);margin-bottom:.6rem}
.crumb a{color:var(--text-muted)}
.wh{border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;margin-bottom:.9rem;background:var(--bg-elev)}
.wh-head{display:flex;flex-direction:column;gap:.3rem;margin-bottom:.5rem}
.wh-head h3 code{font-family:ui-monospace,monospace;font-size:13px;color:var(--text);word-break:break-all}
.wh-meta{display:flex;flex-wrap:wrap;gap:.6rem;font-size:12px;color:var(--text-muted)}
.badge{padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600}
.badge.on{background:#1f6feb33;color:#58a6ff}
.badge.off{background:#88888833;color:var(--text-muted)}
.wh-actions{display:inline-block;margin:.3rem .6rem 0 0}
.wh-actions button{padding:.3rem .8rem;font-size:12px;border-radius:5px;background:var(--accent);color:#fff;border:0;cursor:pointer}
.wh-actions button.danger{background:#da3633}
.deliv{margin-top:.6rem;font-size:12px}
.deliv summary{cursor:pointer;color:var(--text-muted)}
.dtable{width:100%;border-collapse:collapse;margin-top:.4rem;font-size:12px}
.dtable th,.dtable td{border:1px solid var(--border);padding:.3rem .4rem;text-align:left;vertical-align:top}
.dtable th{background:var(--bg);color:var(--text-muted);font-weight:600}
.dtable .ts{white-space:nowrap;font-family:ui-monospace,monospace}
.dtable .uuid{font-family:ui-monospace,monospace;color:var(--text-muted)}
.dtable .st.ok{color:#3fb950;font-weight:600}
.dtable .st.warn{color:#d29922;font-weight:600}
.dtable .st.err{color:#f85149;font-weight:600}
.dtable .ms{color:var(--text-muted);white-space:nowrap}
.dbody pre,.dpl pre{font-size:11px;max-height:240px;overflow:auto;background:var(--bg);padding:.4rem;border-radius:5px;border:1px solid var(--border);white-space:pre-wrap;word-break:break-all}
.derr{color:#f85149;font-size:11px;margin-top:.2rem}
.empty{color:var(--text-muted);text-align:center;padding:.6rem}
.empty-page{color:var(--text-muted);padding:1.2rem;text-align:center;background:var(--bg-elev);border-radius:8px;margin:.6rem 0}
form.add-form{background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:1rem;margin-top:1rem}
form.add-form label{display:block;margin:.5rem 0}
form.add-form input[type=text],form.add-form input[type=password]{width:100%;padding:.4rem .55rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;font-family:inherit}
form.add-form .checks{display:flex;gap:1rem;font-size:13px}
form.add-form .checks label{display:inline-flex;align-items:center;gap:.3rem;margin:0}
.bar{display:flex;gap:.6rem;align-items:center;margin-top:.8rem}
button[type=submit]{padding:.5rem 1.2rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer}
.a-back{color:var(--text-muted);font-size:13px}
.tabs{display:flex;gap:.3rem;padding:.5rem 1rem;border-bottom:1px solid var(--border);font-size:13px}
.tab{padding:.3rem .7rem;border-radius:6px 6px 0 0;text-decoration:none;color:var(--text-muted)}
.tab.active{background:var(--accent);color:#fff}
.subtabs{display:flex;gap:.4rem;padding:.4rem 0 0;border-bottom:1px solid var(--border);margin-bottom:.9rem}
.subtab{padding:.35rem .8rem;border-radius:6px 6px 0 0;font-size:13px;color:var(--text-muted)}
.subtab.active{background:var(--bg-muted);color:var(--text);font-weight:600}
</style></head><body>
<header class="nav"><a href="/" title="ework 主页" style="color:var(--header-text)">🏠</a></header>
${tabNavHTML("projects")}
<main class="wrap">
<div class="crumb"><a href="/projects">项目</a> · <a href="/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}">${escapeHtml(project.owner + "/" + project.name)}</a> · 设置</div>
<h1>Webhooks</h1>
${settingsTabs}
<p class="hint">Payload 协议兼容 Gitea（<code>X-Gitea-Signature</code> HMAC-SHA256 hex），下游 Action 不用改。<br>事件: <code>issues</code> (opened/closed/reopened), <code>issue_comment</code> (created)。</p>
${cards}
<form class="add-form" method="POST" action="${escapeAttr(formAction)}">
  <h2>添加 webhook</h2>
  <label>目标 URL <input type="text" name="url" required placeholder="http://localhost:8099/hook"></label>
  <label>Secret (留空=不签名) <input type="password" name="secret" placeholder="任意随机串"></label>
  <div class="checks">
    <span>订阅:</span>
    <label><input type="checkbox" name="events" value="issues" checked> issues</label>
    <label><input type="checkbox" name="events" value="issue_comment" checked> issue_comment</label>
  </div>
  <div class="bar"><button type="submit">添加</button><a class="a-back" href="/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}">返回项目</a></div>
</form>
</main></body></html>`;
  return html;
}
