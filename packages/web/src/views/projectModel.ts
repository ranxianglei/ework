import { THEME_CSS, escapeHtml, escapeAttr } from "../render/layout";
import { projectSettingsTabsHTML } from "./projectUpstreams";
import type { ProjectRow, CachedModel } from "../store";

interface Flash {
  kind: "ok" | "err";
  msg: string;
}

export function buildProjectModelPage(
  project: ProjectRow,
  globalDefault: string,
  models: CachedModel[],
  flash: Flash | null,
): { html: string } {
  const base = `/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings`;
  const cur = project.model;
  const effective = cur || globalDefault;
  const effectiveLine = effective
    ? `<p class="hint">实际生效：<code>${escapeHtml(effective)}</code>${cur ? "" : " （继承全局默认）"}</p>`
    : `<p class="hint">实际生效：<em>未配置</em> — daemon 不会加 <code>--model</code>，opencode 按 opencode.json 选；注意环境变量（如 <code>OPENCODE_MODEL</code>）可能污染。建议去 <a href="/settings">全局设置</a> 点「刷新 opencode 模型列表」自动选一个默认。</p>`;
  // Empty cache → free-text input (same degradation as global settings).
  const field = models.length === 0
    ? `<input type="text" name="model" value="${escapeAttr(cur)}" placeholder="provider/model（去 /settings 刷新模型列表）">`
    : (() => {
        const opts = [`<option value=""${cur === "" ? " selected" : ""}>（继承全局默认）</option>`]
          .concat(
            models.map(
              (m) =>
                `<option value="${escapeAttr(m.id)}"${m.id === cur ? " selected" : ""}>${escapeHtml(m.label)}</option>`,
            ),
          )
          .join("");
        return `<select name="model">${opts}</select>`;
      })();
  const banner = flash
    ? `<div class="flash ${flash.kind}">${escapeHtml(flash.msg)}</div>`
    : "";
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(project.owner + "/" + project.name)} · 模型设置</title>
<style>${THEME_CSS}
.nav{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px}
.nav a{color:var(--header-text);opacity:.95}
.wrap{max-width:720px;margin:0 auto;padding:1rem}
.subtabs{display:flex;gap:.4rem;margin-bottom:1rem;flex-wrap:wrap}
.subtab{padding:.35rem .7rem;border:1px solid var(--border);border-radius:6px;background:var(--bg-elev);color:var(--text-muted);font-size:13px;text-decoration:none}
.subtab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
h1{font-size:18px;margin:0 0 .4rem}
.hint{color:var(--text-muted);font-size:13px;margin:0 0 1rem}
.card{border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;background:var(--bg-elev);margin-bottom:.9rem}
.card h2{font-size:14px;margin:0 0 .6rem}
.row{display:flex;align-items:center;gap:.7rem;margin:.45rem 0}
.row label{flex:0 0 120px;color:var(--text-muted);font-size:13px}
.row select,.row input{flex:1;padding:.35rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;font-family:inherit}
button{padding:.5rem 1.2rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer}
.flash{padding:.5rem .8rem;border-radius:6px;font-size:13px;margin-bottom:.9rem}
.flash.ok{background:#1f6feb;color:#fff}
.flash.err{background:#da3633;color:#fff}
</style></head><body>
<header class="nav"><a href="/" title="ework 主页" style="color:var(--header-text)">🏠</a><span style="opacity:.8"> · ${escapeHtml(project.owner + "/" + project.name)}</span></header>
<main class="wrap">
${projectSettingsTabsHTML(project.owner, project.name, "model")}
<h1>🤖 模型设置</h1>
${banner}
${effectiveLine}
<form class="card" method="POST" action="${escapeAttr(base)}/model">
  <h2>项目级模型覆盖</h2>
  <div class="row"><label>model</label>${field}</div>
  <div style="margin-top:.5rem"><button type="submit">保存</button></div>
</form>
<p class="hint">空 = 继承 <a href="/settings">全局默认</a>（当前: <code>${escapeHtml(globalDefault || "(未配置)")}</code>）。<br>模型列表来源：<code>opencode models</code>。要刷新去 <a href="/settings">全局设置</a> 点「刷新 opencode 模型列表」。</p>
</main></body></html>`;
  return { html };
}
