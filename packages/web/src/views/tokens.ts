import { THEME_CSS, escapeHtml, tabNavHTML } from "../render/layout";
import { parsePatIpAllowlist, type PatRow, type UserRow } from "../store";

interface Flash {
  kind: "ok" | "err";
  msg: string;
}

function statusBadge(row: PatRow): string {
  if (row.revoked_at) return `<span class="badge revoked">已吊销</span>`;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return `<span class="badge expired">已过期</span>`;
  }
  return `<span class="badge active">生效中</span>`;
}

function ipBadge(row: PatRow): string {
  const list = parsePatIpAllowlist(row.ip_allowlist ?? "[]");
  if (list.length === 0) return `<span class="muted">全部</span>`;
  return list.map((c) => `<code class="cidr">${escapeHtml(c)}</code>`).join(" ");
}

export function buildTokensPage(
  viewer: UserRow,
  rows: PatRow[],
  flash: Flash | null
): string {
  const flashHtml = flash ? `<div class="flash ${flash.kind}">${escapeHtml(flash.msg)}</div>` : "";
  const rowsHtml = rows.length
    ? `<table>
<thead><tr><th>名称</th><th>token</th><th>状态</th><th>IP 限制</th><th>最近使用</th><th>创建</th><th>过期</th><th>操作</th></tr></thead>
<tbody>
${rows
  .map((r) => {
    const lastUsed = r.last_used_at ? escapeHtml(r.last_used_at.slice(0, 16).replace("T", " ")) : "—";
    const expires = r.expires_at ? escapeHtml(r.expires_at.slice(0, 10)) : "—";
    const revoked = !!r.revoked_at;
    return `<tr>
<td class="name">${escapeHtml(r.name)}</td>
<td class="tok"><code>…${escapeHtml(r.token_last_eight)}</code></td>
<td>${statusBadge(r)}</td>
<td class="ip">${ipBadge(r)}</td>
<td class="muted">${lastUsed}</td>
<td class="muted">${escapeHtml(r.created_at.slice(0, 10))}</td>
<td class="muted">${expires}</td>
<td class="act">${
      revoked
        ? ""
        : `<form method="POST" action="/me/tokens/${r.id}/revoke"><button type="submit" class="btn-danger" onclick="return confirm('吊销此 token？使用它的 agent 会立即失去权限。')">吊销</button></form>`
    }</td>
</tr>`;
  })
  .join("")}
</tbody>
</table>`
    : `<div class="hint">还没有 token。下方创建一个给 agent / CLI 用。</div>`;
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>Tokens · ${escapeHtml(viewer.login)}</title>
<style>${THEME_CSS}
.flash{padding:.5rem .7rem;border-radius:6px;font-size:13px;margin-bottom:.8rem}
.flash.ok{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.flash.err{background:color-mix(in srgb,#f85149 18%,transparent);color:#f85149}
.wrap{max-width:920px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .4rem}
.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;margin-bottom:.9rem}
.card h2{font-size:14px;margin:0 0 .7rem;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:.55rem .45rem;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--text-muted);font-weight:600;font-size:12px}
td.tok code{background:var(--bg);padding:.1rem .35rem;border-radius:4px;border:1px solid var(--border);font-size:12px}
td.name{font-weight:600}
td.muted{color:var(--text-muted);font-size:12px;white-space:nowrap}
td.act button,.btn-danger{padding:.3rem .65rem;border:0;border-radius:4px;background:#f85149;color:#fff;font:inherit;font-size:12px;cursor:pointer}
.badge{font-size:11px;font-weight:600;padding:.1rem .45rem;border-radius:4px;line-height:1.5}
.badge.active{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.badge.revoked{background:var(--bg-muted);color:var(--text-muted)}
.badge.expired{background:color-mix(in srgb,#f85149 18%,transparent);color:#f85149}
.hint{color:var(--text-muted);font-size:12px;line-height:1.5;margin:.4rem 0}
label{display:block;font-size:12px;color:var(--text-muted);margin:0 0 .25rem}
input[type=text],input[type=date]{width:100%;box-sizing:border-box;padding:.5rem .65rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:14px;margin-bottom:.7rem}
textarea{width:100%;box-sizing:border-box;padding:.5rem .65rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:14px;margin-bottom:.7rem;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
input:focus,textarea:focus{outline:none;border-color:var(--accent)}
.ip code.cidr{background:var(--bg-muted);padding:.05rem .3rem;border-radius:3px;font-size:11px;color:var(--text-muted);margin-right:.2rem}
.ip .muted{color:var(--text-muted);font-size:12px}
button.primary{padding:.5rem 1rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
</style></head><body>
<header class="topbar"><span style="font-weight:600">🔑 Tokens · ${escapeHtml(viewer.login)}</span></header>
${tabNavHTML("me", { login: viewer.login, is_admin: viewer.is_admin })}
<main class="wrap">
<h1>Personal Access Tokens</h1>
${flashHtml}

<div class="card">
<h2>已有 token（${rows.length}）</h2>
${rowsHtml}
</div>

<form class="card" method="POST" action="/me/tokens/create">
<h2>新建 token</h2>
<div class="form-grid">
<div><label for="n-name">名称（用于识别用途，例如 "echo-bot"）</label><input id="n-name" name="name" type="text" required maxlength="64" pattern="[A-Za-z0-9_\\u4e00-\\u9fa5 .\\-()]{1,64}"></div>
<div><label for="n-expires">过期日期（可选，留空=永久）</label><input id="n-expires" name="expires_at" type="date"></div>
</div>
<label for="n-ip">IP 白名单（可选，留空=不限制）</label>
<textarea id="n-ip" name="ip_allowlist" rows="2" placeholder="203.0.113.0/24, 198.51.100.5（逗号或换行分隔，仅 IPv4）"></textarea>
<div class="hint">创建后明文只显示一次。scopes 暂未启用细粒度（token 等同账户全部权限），细粒度权限走 <a href="/projects">项目成员</a> 控制。</div>
<button class="primary" type="submit">生成 token</button>
</form>
</main></body></html>`;
}

export function buildTokenCreatedPage(viewer: UserRow, plaintext: string, name: string): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>Token 已创建 · ${escapeHtml(viewer.login)}</title>
<style>${THEME_CSS}
.wrap{max-width:680px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .4rem}
.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:1rem;margin-bottom:.9rem}
.card h2{font-size:14px;margin:0 0 .6rem;font-weight:600}
.warn{background:color-mix(in srgb,#f85149 12%,transparent);border:1px solid #f85149;color:#f85149;padding:.7rem .9rem;border-radius:8px;font-size:13px;margin-bottom:.7rem}
.tok-box{display:flex;gap:.5rem;align-items:flex-start;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.6rem;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all}
.tok-box code{flex:1;color:var(--text)}
.tok-box button{padding:.3rem .6rem;border:0;border-radius:4px;background:var(--accent);color:#fff;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.hint{color:var(--text-muted);font-size:12px;line-height:1.5;margin-top:.6rem}
.btn-primary{padding:.5rem 1rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer;text-decoration:none;display:inline-block;margin-top:.6rem}
</style></head><body>
<header class="topbar"><span style="font-weight:600">🔑 Token 已创建</span></header>
${tabNavHTML("me", { login: viewer.login, is_admin: viewer.is_admin })}
<main class="wrap">
<h1>${escapeHtml(name)}</h1>
<div class="card">
<div class="warn">⚠️ 这是 token 的明文，<b>仅显示这一次</b>。关闭此页后无法再次查看。请立即复制到密码管理器或 agent 配置中。</div>
<h2>token</h2>
<div class="tok-box"><code id="t">${escapeHtml(plaintext)}</code><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('t').innerText).then(()=>{this.textContent='已复制 ✓';setTimeout(()=>this.textContent='复制',1500)})">复制</button></div>
<div class="hint">用法：HTTP 请求加 <code>Authorization: Bearer &lt;token&gt;</code>。任何接受登录 cookie 的端点都接受这个 header。</div>
</div>
<a class="btn-primary" href="/me/tokens">← 返回 token 列表</a>
</main></body></html>`;
}
