import { THEME_CSS, escapeHtml, tabNavHTML } from "../render/layout";
import type { UserRow } from "../store";

export function buildMePage(user: UserRow, flash: { kind: "ok" | "err"; msg: string } | null): string {
  const flashHtml = flash
    ? `<div class="flash ${flash.kind}">${escapeHtml(flash.msg)}</div>`
    : "";
  const adminBadge = user.is_admin ? ` <span class="badge admin">admin</span>` : "";
  const lastUpdated = user.updated_at ? `<span class="meta">资料更新于 ${escapeHtml(user.updated_at)}</span>` : "";
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escapeHtml(user.login)} · 我的</title>
<style>${THEME_CSS}
.flash{padding:.5rem .7rem;border-radius:6px;font-size:13px;margin-bottom:.8rem}
.flash.ok{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.flash.err{background:color-mix(in srgb,#f85149 18%,transparent);color:#f85149}
.wrap{max-width:560px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .4rem}
.meta{color:var(--text-muted);font-size:12px;margin-left:.5rem}
.badge{font-size:11px;font-weight:600;padding:.05rem .4rem;border-radius:4px;line-height:1.5;background:var(--bg-muted);color:var(--text-muted)}
.badge.admin{background:color-mix(in srgb,var(--system) 18%,transparent);color:var(--system)}
.badge.bot{background:color-mix(in srgb,var(--bot) 18%,transparent);color:var(--bot)}
.badge.inactive{background:#f85149;color:#fff}
.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;margin-bottom:.9rem}
.card h2{font-size:14px;margin:0 0 .7rem;font-weight:600}
label{display:block;font-size:12px;color:var(--text-muted);margin:0 0 .25rem}
input{width:100%;box-sizing:border-box;padding:.5rem .65rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:14px;margin-bottom:.7rem}
input:focus{outline:none;border-color:var(--accent)}
button{padding:.5rem 1rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer}
.hint{color:var(--text-muted);font-size:12px;line-height:1.5;margin-top:.5rem}
</style></head><body>
<header class="topbar"><span style="font-weight:600">👤 我的账户</span></header>
${tabNavHTML("projects")}
<main class="wrap">
<h1>${escapeHtml(user.login)}${adminBadge}${user.is_active ? "" : ' <span class="badge inactive">未激活</span>'}</h1>
${lastUpdated}
${flashHtml}

<form class="card" method="POST" action="/me/password">
<h2>修改密码</h2>
${user.password_hash ? `<label for="old">当前密码</label><input id="old" name="old" type="password" autocomplete="current-password" required>` : `<div class="hint">当前账户没有设置密码（通过共享 token 登录）。下面设置一个新密码后即可使用用户名+密码登录。</div>`}
<label for="new">新密码（≥ 8 位）</label><input id="new" name="new" type="password" autocomplete="new-password" minlength="8" required>
<label for="confirm">确认新密码</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
<button type="submit">保存</button>
</form>

<div class="card">
<h2>账户信息</h2>
<div>登录名：<code>${escapeHtml(user.login)}</code></div>
<div>类型：<span class="badge ${user.kind === "bot" ? "bot" : ""}">${escapeHtml(user.kind)}</span></div>
${user.email ? `<div>邮箱：${escapeHtml(user.email)}</div>` : ""}
${user.display_name ? `<div>显示名：${escapeHtml(user.display_name)}</div>` : ""}
<div class="hint">PAT (Personal Access Token) 用于 agent / CLI 认证，<a href="/me/tokens">前往管理 →</a></div>
</div>
</main></body></html>`;
}

interface AdminFlash {
  kind: "ok" | "err";
  msg: string;
}

export function buildAdminUsersPage(viewer: UserRow, users: UserRow[], flash: AdminFlash | null): string {
  const flashHtml = flash ? `<div class="flash ${flash.kind}">${escapeHtml(flash.msg)}</div>` : "";
  const rows = users
    .map((u) => {
      const adminBadge = u.is_admin ? `<span class="badge admin">admin</span>` : "";
      const inactiveBadge = u.is_active ? "" : `<span class="badge inactive">禁用</span>`;
      const pwState = u.password_hash
        ? `<span class="pw yes">已设密码</span>`
        : `<span class="pw no">无密码（token 登录）</span>`;
      const kindBadge = u.kind === "bot" ? `<span class="badge bot">bot</span>` : u.kind === "system" ? `<span class="badge">system</span>` : "";
      const toggleAdminLabel = u.is_admin ? "取消 admin" : "设为 admin";
      const toggleActiveLabel = u.is_active ? "禁用账户" : "启用账户";
      const isSelf = u.login === viewer.login;
      const selfNote = isSelf ? `<span class="meta">(你)</span>` : "";
      return `<tr>
<td class="login">${escapeHtml(u.login)} ${selfNote} ${kindBadge} ${adminBadge} ${inactiveBadge}</td>
<td class="pw-cell">${pwState}</td>
<td class="created">${escapeHtml(u.created_at.slice(0, 10))}</td>
<td class="actions">
<form method="POST" action="/admin/users/${encodeURIComponent(u.login)}/reset-password"><input type="password" name="password" placeholder="新密码（≥8）" minlength="8" required><button type="submit">重置密码</button></form>
<button type="submit" formaction="/admin/users/${encodeURIComponent(u.login)}/toggle-admin" formmethod="POST" class="btn-mini" ${isSelf ? "disabled title='不能改自己'" : ""}>${toggleAdminLabel}</button>
<button type="submit" formaction="/admin/users/${encodeURIComponent(u.login)}/toggle-active" formmethod="POST" class="btn-mini" ${isSelf ? "disabled title='不能改自己'" : ""}>${toggleActiveLabel}</button>
</td>
</tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>用户管理 · ework</title>
<style>${THEME_CSS}
.flash{padding:.5rem .7rem;border-radius:6px;font-size:13px;margin-bottom:.8rem}
.flash.ok{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.flash.err{background:color-mix(in srgb,#f85149 18%,transparent);color:#f85149}
.wrap{max-width:960px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .4rem}
.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;margin-bottom:.9rem}
.card h2{font-size:14px;margin:0 0 .7rem;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:.5rem .4rem;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--text-muted);font-weight:600;font-size:12px}
td.login{font-weight:600}
td.pw-cell{color:var(--text-muted);font-size:12px;white-space:nowrap}
td.created{color:var(--text-muted);font-size:12px;white-space:nowrap}
td.actions{display:flex;flex-direction:column;gap:.3rem;align-items:flex-start}
td.actions form{display:flex;gap:.3rem;align-items:center}
td.actions input{padding:.3rem .4rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font:inherit;font-size:12px;width:140px}
td.actions button, .btn-mini{padding:.3rem .55rem;border:0;border-radius:4px;background:var(--bg-muted);color:var(--text);font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--border)}
td.actions button:hover, .btn-mini:hover{border-color:var(--accent)}
td.actions button[disabled]{opacity:.4;cursor:not-allowed}
.pw.yes{color:var(--green)}
.pw.no{color:var(--text-muted)}
.badge{font-size:11px;font-weight:600;padding:.05rem .4rem;border-radius:4px;line-height:1.5;background:var(--bg-muted);color:var(--text-muted)}
.badge.admin{background:color-mix(in srgb,var(--system) 18%,transparent);color:var(--system)}
.badge.bot{background:color-mix(in srgb,var(--bot) 18%,transparent);color:var(--bot)}
.badge.inactive{background:#f85149;color:#fff}
.meta{color:var(--text-muted);font-size:11px;font-weight:400}
label{display:block;font-size:12px;color:var(--text-muted);margin:0 0 .25rem}
input[type=text],input[type=password],input[type=email]{width:100%;box-sizing:border-box;padding:.5rem .65rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:14px;margin-bottom:.7rem}
input:focus{outline:none;border-color:var(--accent)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
button.primary{padding:.5rem 1rem;border:0;border-radius:6px;background:var(--green);color:#fff;font-size:13px;cursor:pointer}
.admin-nav{display:flex;gap:.5rem;margin-bottom:.9rem}
.admin-nav a{padding:.35rem .8rem;border-radius:6px;background:var(--bg-elev);border:1px solid var(--border);font-size:13px;color:var(--text)}
.admin-nav a:hover{border-color:var(--accent)}
</style></head><body>
<header class="topbar"><span style="font-weight:600">👥 用户管理</span></header>
${tabNavHTML("projects")}
<main class="wrap">
<h1>用户</h1>
${flashHtml}

<div class="admin-nav">
  <a href="/admin/users">用户</a>
  <a href="/admin/tokens">所有 Token</a>
  <a href="/admin/deliveries">Webhook 投递</a>
</div>

<form class="card" method="POST" action="/admin/users/create">
<h2>新建用户</h2>
<div class="form-grid">
<div><label for="n-login">登录名（A-Za-z0-9_-，1-64）</label><input id="n-login" name="login" type="text" pattern="[A-Za-z0-9_-]{1,64}" required></div>
<div><label for="n-pw">初始密码（≥ 8 位）</label><input id="n-pw" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
<div><label for="n-email">邮箱（可选）</label><input id="n-email" name="email" type="email"></div>
<div><label for="n-kind">类型</label><select id="n-kind" name="kind" style="width:100%;padding:.5rem .65rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:14px"><option value="human" selected>human</option><option value="bot">bot</option><option value="system">system</option></select></div>
</div>
<label><input type="checkbox" name="is_admin" value="1" style="width:auto;margin-right:.4rem">设为管理员</label>
<button class="primary" type="submit">创建用户</button>
</form>

<div class="card">
<h2>已有用户（${users.length}）</h2>
<table>
<thead><tr><th>用户</th><th>认证</th><th>注册</th><th>操作</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>
</main></body></html>`;
}
