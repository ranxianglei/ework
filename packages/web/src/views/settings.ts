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
          return `<label class="sf"><span>${escapeHtml(f.label)}</span><input type="text" name="${escapeAttr(String(f.key))}" value="${escapeAttr(cur)}" placeholder="provider/model（点下方刷新拉列表）"></label>`;
        }
        // No empty "use opencode default" option: empty default lets env
        // vars pollute the model slot (see M-1 in index.ts refresh handler).
        // If cur is empty, the browser auto-selects the first option.
        const opts = models
          .map(
            (m) =>
              `<option value="${escapeAttr(m.id)}"${m.id === cur ? " selected" : ""}>${escapeHtml(m.label)}</option>`
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

function buildDaemonSection(viewer: UserRow): string {
  if (viewer.is_admin !== 1) return "";
  return `<section class="sg daemon-section">
<h2>Daemon 集群</h2>
<p class="db-badge">运行中的 daemon 实例。新 daemon 通过 <code>ework-aio add-daemon</code> 启动；停止只标记为 drained，需手动结束进程。</p>
<div id="daemon-list" class="daemon-list">加载中…</div>
<div class="db-controls">
<label class="sf" style="margin:0"><span>端口（可选）</span><input type="number" id="daemon-port" min="1" max="65535" placeholder="自动分配" autocomplete="off"></label>
<button type="button" id="daemon-add">添加 Daemon</button>
</div>
<div id="daemon-result" class="db-result"></div>
<details style="margin-top:.7rem">
<summary style="cursor:pointer;font-size:13px;color:var(--text-muted)">📡 SSH 远程部署</summary>
<div style="margin-top:.5rem">
<label class="sf"><span>SSH 用户</span><input type="text" id="deploy-user" placeholder="root" value="root" autocomplete="off"></label>
<label class="sf"><span>SSH 端口</span><input type="number" id="deploy-ssh-port" value="22" min="1" max="65535" autocomplete="off"></label>
<label class="sf"><span>SSH 密钥</span><input type="text" id="deploy-key" placeholder="~/.ssh/id_rsa" autocomplete="off"></label>
<label class="sf"><span>MySQL 主机（远程可见）</span><input type="text" id="deploy-mysql-host" placeholder="192.168.1.1" autocomplete="off"></label>
<label class="sf"><span>超时（秒）</span><input type="number" id="deploy-timeout" value="180" min="30" max="600" autocomplete="off"></label>
<label class="sf" style="align-items:flex-start"><span>目标机器</span><textarea id="deploy-targets" rows="4" style="flex:1;padding:.35rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px;font-family:ui-monospace,monospace" placeholder="每行一个，格式：&#10;192.168.1.100&#10;192.168.1.101:3201&#10;10.0.0.5:3202&#10;（不带端口则用默认 3101）"></textarea></label>
<div class="db-controls"><button type="button" id="daemon-deploy">部署（支持批量）</button></div>
</div>
</details>
<div id="deploy-result" class="db-result" style="max-height:400px;overflow-y:auto;font-family:ui-monospace,monospace;font-size:11px"></div>
<script src="/static/daemon-mgr.js"></script>
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
  const modelRefreshForm = `<section class="sg"><h2>opencode 模型列表</h2><p class="hint" style="margin:0 0 .6rem">从 <code>opencode models</code> 拉取可用模型并刷新上方下拉列表。刷新后自动选定一个具体模型作为默认（不会留空）。</p><form method="POST" action="/settings/models/refresh"><button type="submit" class="secondary">🔄 刷新 opencode 模型列表</button></form></section>`;
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
.daemon-list{margin-bottom:.7rem}
.daemon-list table{width:100%;border-collapse:collapse;font-size:12px}
.daemon-list th,.daemon-list td{padding:.35rem .4rem;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.daemon-list th{color:var(--text-muted);font-weight:normal;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.daemon-list td.endpoint{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all}
.daemon-list td.cap{text-align:right;font-variant-numeric:tabular-nums}
.daemon-list td.heartbeat,.daemon-list td.registered{color:var(--text-muted);font-size:11px;white-space:nowrap}
.daemon-list .pill{display:inline-block;padding:.12rem .5rem;border-radius:99px;font-size:11px;line-height:1.4}
.daemon-list .pill.active{background:rgba(40,167,69,.18);color:#5eb88a}
.daemon-list .pill.drained{background:rgba(255,193,7,.18);color:#d4a942}
.daemon-list .pill.dead,.daemon-list .pill.unknown{background:rgba(220,53,69,.18);color:#e87c7c}
.daemon-list .pill.loc-local{background:rgba(40,167,69,.18);color:#5eb88a}
.daemon-list .pill.loc-remote{background:rgba(13,110,253,.18);color:#6ea8fe}
.daemon-list td.loc{white-space:nowrap}
.daemon-list button.stop{padding:.25rem .6rem;font-size:11px;background:transparent;color:#e87c7c;border:1px solid rgba(220,53,69,.4)}
.daemon-list button.stop:hover{background:rgba(220,53,69,.12)}
.daemon-list button.restart{padding:.25rem .6rem;font-size:11px;background:transparent;color:#5eb88a;border:1px solid rgba(40,167,69,.4);margin-right:.3rem}
.daemon-list button.restart:hover{background:rgba(40,167,69,.12)}
.daemon-list button.remove{padding:.25rem .6rem;font-size:11px;background:transparent;color:var(--text-muted);border:1px solid var(--border)}
.daemon-empty{color:var(--text-muted);font-size:13px;padding:.5rem 0}
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
${buildDaemonSection(viewer)}
${viewer.is_admin === 1 ? buildGroupsSection() : ""}
</main></body></html>`;
  return { html };
}

function buildGroupsSection(): string {
  return `
<section class="sg" id="groups-section">
  <h2>Daemon 分组与路由策略</h2>
  <p class="hint">配置 daemon 分组和 webhook 派发策略。Router 自动摘除心跳超时的节点（120s）。</p>
  <div class="sf">
    <span>路由策略</span>
    <select id="strategy-select">
      <option value="least-loaded">least-loaded（负载最低优先）</option>
      <option value="round-robin">round-robin（轮询）</option>
      <option value="first-available">first-available（按 ID 顺序）</option>
      <option value="group">group（按分组路由）</option>
    </select>
  </div>
  <div id="daemon-groups-editor" style="margin-top:.7rem">
    <table class="daemon-list" id="groups-table">
      <thead><tr><th>ID</th><th>节点</th><th>状态</th><th>分组</th></tr></thead>
      <tbody id="groups-tbody"></tbody>
    </table>
  </div>
  <div id="bindings-editor" style="margin-top:.7rem">
    <h2 style="margin-bottom:.5rem">Repo → 分组绑定</h2>
    <div id="bindings-list"></div>
    <div class="db-controls">
      <input type="text" id="binding-repo" placeholder="owner/repo" style="padding:.35rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;flex:1">
      <input type="text" id="binding-group" placeholder="group-name" style="padding:.35rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;flex:1">
      <button type="button" id="binding-add" class="secondary">添加绑定</button>
    </div>
  </div>
  <div class="db-controls" style="margin-top:.7rem">
    <button type="button" id="strategy-save">保存策略</button>
  </div>
  <div class="db-result" id="strategy-result"></div>
</section>
<script src="/static/daemon-groups.js"></script>`;
}
