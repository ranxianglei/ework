import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";
import { parsePatIpAllowlist, type PatWithUser, type UserRow } from "../store";

interface Flash {
  kind: "ok" | "err";
  msg: string;
}

function statusBadge(row: PatWithUser): string {
  if (row.revoked_at) return `<span class="badge revoked">已吊销</span>`;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return `<span class="badge expired">已过期</span>`;
  }
  return `<span class="badge active">生效中</span>`;
}

function parseScopes(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function buildAdminTokensPage(
  viewer: UserRow,
  rows: PatWithUser[],
  flash: Flash | null,
): string {
  const flashHtml = flash ? `<div class="flash ${flash.kind}">${escapeHtml(flash.msg)}</div>` : "";
  const activeCount = rows.filter((r) => !r.revoked_at && !(r.expires_at && Date.parse(r.expires_at) < Date.now())).length;
  const revokedCount = rows.length - activeCount;
  const rowsHtml = rows.length
    ? `<table>
<thead><tr><th>名称</th><th>用户</th><th>token</th><th>scopes</th><th>IP</th><th>状态</th><th>最近使用</th><th>创建</th><th>操作</th></tr></thead>
<tbody>
${rows
  .map((r) => {
    const lastUsed = r.last_used_at ? escapeHtml(r.last_used_at.slice(0, 16).replace("T", " ")) : "—";
    const scopes = parseScopes(r.scopes).map((s) => `<code>${escapeHtml(s)}</code>`).join(" ") || "—";
    const ipList = parsePatIpAllowlist(r.ip_allowlist ?? "[]");
    const ipCell = ipList.length === 0
      ? `<span class="muted">全部</span>`
      : ipList.map((c) => `<code class="cidr">${escapeHtml(c)}</code>`).join(" ");
    const userBadges: string[] = [];
    if (r.user_is_admin === 1) userBadges.push(`<span class="badge admin">admin</span>`);
    if (r.user_kind === "bot") userBadges.push(`<span class="badge bot">bot</span>`);
    else if (r.user_kind === "system") userBadges.push(`<span class="badge">system</span>`);
    if (r.user_is_active === 0) userBadges.push(`<span class="badge inactive">禁用</span>`);
    const revoked = !!r.revoked_at;
    const ownerNote = r.user_login === viewer.login ? `<span class="meta">(你)</span>` : "";
    return `<tr>
<td class="name">${escapeHtml(r.name)}</td>
<td class="user">${escapeHtml(r.user_login)} ${ownerNote} ${userBadges.join(" ")}</td>
<td class="tok"><code>…${escapeHtml(r.token_last_eight)}</code></td>
<td class="scopes">${scopes}</td>
<td class="ip">${ipCell}</td>
<td>${statusBadge(r)}</td>
<td class="muted">${lastUsed}</td>
<td class="muted">${escapeHtml(r.created_at.slice(0, 10))}</td>
<td class="act">${
      revoked
        ? ""
        : `<form method="POST" action="/admin/tokens/${r.id}/revoke"><button type="submit" class="btn-danger" onclick="return confirm('吊销此 token？用户 ${escapeAttr(r.user_login)} 的 agent 会立即失去权限。')">吊销</button></form>`
    }</td>
</tr>`;
  })
  .join("")}
</tbody>
</table>`
    : `<div class="hint">系统里还没有任何 PAT。</div>`;
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>Token 管理 · ework</title>
<style>${THEME_CSS}
.flash{padding:.5rem .7rem;border-radius:6px;font-size:13px;margin-bottom:.8rem}
.flash.ok{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.flash.err{background:color-mix(in srgb,#f85149 18%,transparent);color:#f85149}
.wrap{max-width:1180px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .4rem}
.summary{color:var(--text-muted);font-size:13px;margin:0 0 .8rem}
.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;margin-bottom:.9rem}
.card h2{font-size:14px;margin:0 0 .7rem;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:.55rem .45rem;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--text-muted);font-weight:600;font-size:12px}
td.tok code{background:var(--bg);padding:.1rem .35rem;border-radius:4px;border:1px solid var(--border);font-size:12px}
td.scopes code{background:var(--bg-muted);padding:.05rem .3rem;border-radius:3px;font-size:11px;color:var(--text-muted);margin-right:.2rem}
td.ip code.cidr{background:var(--bg-muted);padding:.05rem .3rem;border-radius:3px;font-size:11px;color:var(--text-muted);margin-right:.2rem}
td.ip .muted{color:var(--text-muted);font-size:12px}
td.name{font-weight:600}
td.user{font-weight:600;white-space:nowrap}
td.muted{color:var(--text-muted);font-size:12px;white-space:nowrap}
td.act button,.btn-danger{padding:.3rem .65rem;border:0;border-radius:4px;background:#f85149;color:#fff;font:inherit;font-size:12px;cursor:pointer}
.badge{font-size:11px;font-weight:600;padding:.1rem .45rem;border-radius:4px;line-height:1.5}
.badge.active{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.badge.revoked{background:var(--bg-muted);color:var(--text-muted)}
.badge.expired{background:color-mix(in srgb,#f85149 18%,transparent);color:#f85149}
.badge.admin{background:color-mix(in srgb,var(--system) 18%,transparent);color:var(--system)}
.badge.bot{background:color-mix(in srgb,var(--bot) 18%,transparent);color:var(--bot)}
.badge.inactive{background:#f85149;color:#fff}
.hint{color:var(--text-muted);font-size:12px;line-height:1.5;margin:.4rem 0}
.meta{color:var(--text-muted);font-size:11px;font-weight:400}
</style></head><body>
<header class="topbar"><span style="font-weight:600">🔑 Token 管理（管理员）</span></header>
${tabNavHTML("projects", { login: viewer.login, is_admin: viewer.is_admin })}
<main class="wrap">
<h1>所有 Personal Access Tokens</h1>
<p class="summary">共 ${rows.length} 个（生效中 ${activeCount}，已吊销/过期 ${revokedCount}）</p>
${flashHtml}

<div class="card">
<h2>Token 列表</h2>
${rowsHtml}
</div>

<div class="hint">吊销任意 token 后，使用该 token 的 agent / CLI 会立即失去权限（verifyPat 检查 revoked_at）。用户自己的 token 仍由 <a href="/me/tokens">/me/tokens</a> 自助管理。</div>
</main></body></html>`;
}
