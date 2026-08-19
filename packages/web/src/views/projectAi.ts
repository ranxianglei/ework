import { THEME_CSS, escapeHtml, escapeAttr } from "../render/layout";
import { projectSettingsTabsHTML } from "./projectUpstreams";
import type { ProjectRow } from "../store";

export function buildProjectAiPage(
  project: ProjectRow,
  dispatchOff: boolean,
  globalDispatchOff: boolean,
  processingCount: number,
): { html: string } {
  const aiBase = `/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/ai`;
  const dispatchAction = `/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/dispatch`;
  const haltAllAction = `${aiBase}/halt-all`;

  const dispatchCard = (() => {
    const disabled = globalDispatchOff;
    const hint = disabled
      ? `<div class="hint">⚠️ 全局自动接单已<a href="/settings">关闭</a>。项目级开关在此状态下无效——需先开启全局。</div>`
      : `<div class="hint">关闭后，本项目新建 issue 不会自动派给 AI（评论仍可显式召唤）。<b>不影响已在运行的会话。</b></div>`;
    return `<form class="card" method="POST" action="${escapeAttr(dispatchAction)}">
<h2>🔔 自动接单</h2>
${hint}
<div class="status-line">
  <span class="status-dot ${dispatchOff ? "off" : "on"}"></span>
  <span class="status-text">${dispatchOff ? "🔕 不接单" : "🔔 接单中"}</span>
</div>
<button type="submit" class="${dispatchOff ? "primary" : "secondary"}" ${disabled ? "disabled" : ""}>${dispatchOff ? "🔔 开启自动接单" : "🔕 关闭自动接单"}</button>
</form>`;
  })();

  const haltCard = (() => {
    const hint = processingCount > 0
      ? `当前有 <b>${processingCount}</b> 个 AI 会话正在运行。点击下方按钮将全部停止（向 daemon 发送 halt 信号）。`
      : `当前没有正在运行的 AI 会话。`;
    return `<form class="card" method="POST" action="${escapeAttr(haltAllAction)}">
<h2>⏹️ 停止所有运行中AI</h2>
<div class="hint">${hint} <b>不影响自动接单状态。</b></div>
<div class="status-line">
  <span class="status-dot ${processingCount > 0 ? "on" : "off"}"></span>
  <span class="status-text">${processingCount > 0 ? `${processingCount} 个会话运行中` : "空闲"}</span>
</div>
<button type="submit" class="danger" ${processingCount === 0 ? "disabled" : ""}>⏹️ 停止全部</button>
</form>`;
  })();

  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(project.owner + "/" + project.name)} · AI 设置</title>
<style>${THEME_CSS}
.nav{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px}
.nav a{color:var(--header-text);opacity:.95}
.wrap{max-width:720px;margin:0 auto;padding:1rem}
.subtabs{display:flex;gap:.4rem;margin-bottom:1rem;flex-wrap:wrap}
.subtab{padding:.35rem .7rem;border:1px solid var(--border);border-radius:6px;background:var(--bg-elev);color:var(--text-muted);font-size:13px;text-decoration:none}
.subtab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
h1{font-size:18px;margin:0 0 .4rem}
.hint{color:var(--text-muted);font-size:13px;margin:.3rem 0 .6rem;line-height:1.5}
.card{border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;background:var(--bg-elev);margin-bottom:.9rem}
.card h2{font-size:14px;margin:0 0 .5rem}
.status-line{display:flex;align-items:center;gap:.5rem;margin-bottom:.7rem}
.status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.status-dot.on{background:var(--green,#3fb950)}
.status-dot.off{background:var(--text-muted)}
.status-text{font-size:13px;font-weight:600}
button{padding:.5rem 1.2rem;border:0;border-radius:6px;font-size:13px;cursor:pointer}
button.primary{background:var(--accent);color:#fff}
button.secondary{background:var(--bg-muted);color:var(--text);border:1px solid var(--border)}
button.danger{background:#da3633;color:#fff}
button:disabled{opacity:.5;cursor:not-allowed}
.future{opacity:.5;pointer-events:none}
</style></head><body>
<header class="nav"><a href="/" title="ework 主页" style="color:var(--header-text)">🏠</a><span style="opacity:.8"> · ${escapeHtml(project.owner + "/" + project.name)}</span></header>
<main class="wrap">
${projectSettingsTabsHTML(project.owner, project.name, "ai")}
<h1>🤖 AI 设置</h1>
<p class="hint">两个独立控制：<b>🔔 自动接单</b>控制是否自动派新单（不影响运行中）；<b>⏹️ 停止</b>杀死当前所有运行中AI会话（不影响接单状态）。模型选择请去 <a href="${escapeAttr(`/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/model`)}">⚙️ 模型</a> 标签页。</p>
${dispatchCard}
${haltCard}

<div class="card future">
<h2>更多配置（规划中）</h2>
<div class="hint">后续版本将在此标签页增加：项目级唤醒策略、Nudge 间隔、Observer 开关等。</div>
</div>
</main></body></html>`;
  return { html };
}
