import type { Config, SettingGroup } from "../config";
import { SETTINGS_GROUPS } from "../config";
import { THEME_CSS, escapeHtml, escapeAttr } from "../render/layout";
import type { UserRow, CachedModel } from "../store";

function fieldInput(group: SettingGroup, cfg: Config, models: CachedModel[]): string {
  return group.fields
    .map((f) => {
      const cur = String(cfg[f.key] ?? "");
      if (f.type === "backend") {
        const opts = cfg.ttsBackends
          .map(
            (b) =>
              `<option value="${escapeAttr(b.id)}"${b.id === cur ? " selected" : ""}>${escapeHtml(b.label)}</option>`
          )
          .join("");
        return `<label class="sf"><span>${escapeHtml(f.label)}</span><select name="${escapeAttr(String(f.key))}">${opts}</select></label>`;
      }
      if (f.type === "model") {
        // If the cache is empty (opencode not yet polled), fall back to a free
        // text input so the user can still type a known provider/model id.
        if (models.length === 0) {
          return `<label class="sf"><span>${escapeHtml(f.label)}</span><input type="text" name="${escapeAttr(String(f.key))}" value="${escapeAttr(cur)}" placeholder="provider/model（点下面的刷新拉列表）"></label>`;
        }
        const opts = [`<option value=""${cur === "" ? " selected" : ""}>（用 opencode 默认）</option>`]
          .concat(
            models.map(
              (m) =>
                `<option value="${escapeAttr(m.id)}"${m.id === cur ? " selected" : ""}>${escapeHtml(m.label)}</option>`
            )
          )
          .join("");
        return `<label class="sf"><span>${escapeHtml(f.label)}</span><select name="${escapeAttr(String(f.key))}">${opts}</select></label>`;
      }
      const inp = f.type === "number" ? "number" : "text";
      return `<label class="sf"><span>${escapeHtml(f.label)}</span><input type="${inp}" name="${escapeAttr(String(f.key))}" value="${escapeAttr(cur)}"></label>`;
    })
    .join("");
}

export function buildSettingsPage(cfg: Config, saved: boolean, viewer: UserRow, models: CachedModel[]): { html: string } {
  const groups = SETTINGS_GROUPS.map(
    (g) =>
      `<section class="sg"><h2>${escapeHtml(g.title)}</h2>${fieldInput(g, cfg, models)}</section>`
  ).join("");
  const banner = saved ? `<div class="saved">✓ 已保存，立即生效</div>` : "";
  const ttsLink = viewer.is_admin === 1
    ? `<p class="hint">要增删朗读后端（kokoro / cosyvoice3 等），去 <a href="/admin/tts-backends">朗读后端管理</a>。</p>`
    : "";
  const modelRefreshForm = `<form method="POST" action="/settings/models/refresh" style="margin-top:.4rem"><button type="submit" class="secondary">🔄 刷新 opencode 模型列表</button></form>`;
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ework-web · 设置</title>
<style>${THEME_CSS}
.nav{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;background:var(--header-bg);color:var(--header-text);font-size:13px}
.nav a{color:var(--header-text);opacity:.95}
.wrap{max-width:680px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .4rem}
.hint{color:var(--text-muted);font-size:13px;margin:0 0 1rem}
.sg{border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;margin-bottom:.9rem;background:var(--bg-elev)}
.sg h2{font-size:14px;margin:0 0 .7rem;color:var(--text)}
.sf{display:flex;align-items:center;gap:.7rem;margin:.45rem 0}
.sf span{flex:0 0 150px;color:var(--text-muted);font-size:13px}
.sf input,.sf select{flex:1;padding:.35rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;font-family:inherit}
.sf input:focus,.sf select:focus{outline:none;border-color:var(--accent)}
.saved{background:#1f6feb;color:#fff;padding:.5rem .8rem;border-radius:6px;font-size:13px;margin-bottom:.9rem}
.bar{display:flex;gap:.6rem;align-items:center;margin-top:.4rem}
button{padding:.5rem 1.2rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer}
button.secondary{background:transparent;color:var(--text-muted);border:1px solid var(--border)}
.a-back{color:var(--text-muted);font-size:13px}
</style></head><body>
<header class="nav"><a href="/" style="color:var(--header-text)">🏠 ework-web</a><span style="opacity:.8"> · 设置</span></header>
<main class="wrap">
<h1>后台配置</h1>
<p class="hint">改完保存立即生效，无需重启。密钥/启动项（token、端口等）仍在 <code>.env</code>，不在此处。</p>
${banner}
<form method="POST" action="/settings">${groups}
<div class="bar"><button type="submit">保存</button><a class="a-back" href="/">返回</a></div>
</form>
${modelRefreshForm}
${ttsLink}
</main></body></html>`;
  return { html };
}
