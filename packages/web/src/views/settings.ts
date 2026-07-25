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

function buildDbSection(viewer: UserRow): string {
  if (viewer.is_admin !== 1) return "";
  const driver = process.env.WORK_DB_DRIVER || "sqlite";
  const isMysql = driver === "mysql";
  const currentTarget = isMysql
    ? `${process.env.WORK_DB_HOST ?? "?"}:${process.env.WORK_DB_PORT ?? "3306"}/${process.env.WORK_DB_NAME ?? "?"}`
    : `SQLite · ${process.env.WORK_DB_PATH ?? "默认路径"}`;
  return `<section class="sg db-section">
<h2>数据库后端</h2>
<p class="db-badge">当前后端: <strong>${escapeHtml(driver.toUpperCase())}</strong> · ${escapeHtml(currentTarget)}</p>
<div class="db-warn">⚠ 切换到 MySQL 后 Web 进程会重启并以 MySQL 为存储。若 MySQL 不可达，进程无法启动——需手动编辑 <code>.env</code> 将 <code>WORK_DB_DRIVER</code> 改回 <code>sqlite</code> 才能恢复。流程：先 ① 测试连接、再 ② 迁移数据、最后 ③ 启用。</div>
<label class="sf"><span>MySQL 主机</span><input type="text" id="db-host" placeholder="127.0.0.1" autocomplete="off"></label>
<label class="sf"><span>端口</span><input type="number" id="db-port" value="3306" min="1" max="65535" autocomplete="off"></label>
<label class="sf"><span>用户名</span><input type="text" id="db-user" placeholder="ework" autocomplete="off"></label>
<label class="sf"><span>密码</span><input type="password" id="db-password" placeholder="••••••" autocomplete="new-password"></label>
<label class="sf"><span>数据库名</span><input type="text" id="db-database" placeholder="ework" autocomplete="off"></label>
<label class="sf"><span>表前缀（可选）</span><input type="text" id="db-prefix" placeholder="留空 = 无前缀" autocomplete="off"></label>
<div class="db-controls">
<button type="button" id="db-test">① 测试连接</button>
<button type="button" id="db-migrate" class="secondary">② 迁移数据</button>
<button type="button" id="db-daemon" class="secondary">③ 配置 daemon</button>
<button type="button" id="db-enable" class="secondary">④ 启用并重启</button>
</div>
<div id="db-result" class="db-result"></div>
${isMysql ? `<hr style="border:0;border-top:1px solid var(--border);margin:1rem 0"><div class="db-controls"><button type="button" id="db-revert" class="secondary">⚠ 切回 SQLite（安全网）</button></div><div id="db-revert-result" class="db-result"></div>` : ""}
<script src="/static/db-wizard.js"></script>
</section>`;
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
.db-badge{font-size:13px;color:var(--text-muted);margin:0 0 .5rem}
.db-badge strong{color:var(--text)}
.db-warn{background:rgba(255,193,7,.12);color:#d4a942;padding:.5rem .7rem;border-radius:6px;font-size:12px;margin:0 0 .7rem;line-height:1.5}
.db-warn code{background:var(--bg);padding:.1rem .3rem;border-radius:3px;font-size:11px}
.db-controls{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.6rem}
.db-result{margin-top:.6rem;padding:.5rem .7rem;border-radius:6px;font-size:13px;white-space:pre-wrap;min-height:1.2rem;line-height:1.5}
.db-result:empty{display:none}
.db-result.db-loading{background:var(--bg);color:var(--text-muted)}
.db-result.db-ok{background:rgba(40,167,69,.15);color:#5eb88a}
.db-result.db-err{background:rgba(220,53,69,.15);color:#e87c7c}
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
${buildDbSection(viewer)}
</main></body></html>`;
  return { html };
}
