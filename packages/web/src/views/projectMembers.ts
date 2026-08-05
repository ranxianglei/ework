import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";
import {
  countProjectAdmins,
  listProjectMembersWithUsers,
  listUsers,
  type ProjectMemberWithUser,
  type ProjectRole,
  type ProjectRow,
  type UserRow,
} from "../store";
import { projectSettingsTabsHTML } from "./projectUpstreams";

interface Flash {
  kind: "ok" | "err";
  msg: string;
}

const ALL_ROLES: ProjectRole[] = ["reader", "writer", "admin"];

function roleBadge(role: ProjectRole): string {
  const cls = role === "admin" ? "admin" : role === "writer" ? "writer" : "reader";
  return `<span class="badge role-${cls}">${escapeHtml(role)}</span>`;
}

export async function buildProjectMembersPage(
  viewer: UserRow,
  project: ProjectRow,
  flash: Flash | null,
  dispatchOff: boolean,
): Promise<string> {
  const members = await listProjectMembersWithUsers(project.id);
  const users = await listUsers();
  const memberLogins = new Set(members.map((m) => m.user_login));
  const candidates = users.filter((u) => u.is_active === 1 && !memberLogins.has(u.login));

  const flashHtml = flash ? `<div class="flash ${flash.kind}">${escapeHtml(flash.msg)}</div>` : "";

  const memberRows = await Promise.all(members.map((m) => memberRowHtml(m, viewer, project)));
  const rowsHtml = members.length
    ? `<table>
<thead><tr><th>用户</th><th>角色</th><th>加入时间</th><th>操作</th></tr></thead>
<tbody>
${memberRows.join("")}
</tbody>
</table>`
    : `<div class="hint">该项目还没有成员记录（site-admin 已自动获得 admin 权限，可在下方添加）。</div>`;

  const candOptions = candidates
    .map((u) => `<option value="${escapeAttr(u.login)}">${escapeHtml(u.login)} (${escapeHtml(u.kind)})</option>`)
    .join("");
  const addFormHtml = candidates.length
    ? `<form class="card" method="POST" action="${escapeAttr(`/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/members/add`)}">
<h2>添加成员</h2>
<div class="form-grid">
<div><label for="n-login">用户</label><select id="n-login" name="login" required>${candOptions}</select></div>
<div><label for="n-role">角色</label><select id="n-role" name="role">${ALL_ROLES.map((r) => `<option value="${r}"${r === "writer" ? " selected" : ""}>${r}</option>`).join("")}</select></div>
</div>
<div class="hint">reader = 只读（预留）；writer = 可创建 issue、评论、关闭、上传；admin = 可管理 webhook 和成员。</div>
<button class="primary" type="submit">添加</button>
</form>`
    : `<div class="card"><h2>添加成员</h2><div class="hint">没有可添加的候选用户。先在 <a href="/admin/users">用户管理</a> 创建账户。</div></div>`;

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>成员 · ${escapeHtml(project.owner)}/${escapeHtml(project.name)}</title>
<style>${THEME_CSS}
.flash{padding:.5rem .7rem;border-radius:6px;font-size:13px;margin-bottom:.8rem}
.flash.ok{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.flash.err{background:color-mix(in srgb,#f85149 18%,transparent);color:#f85149}
.wrap{max-width:920px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .4rem}
h1 a{color:var(--text)}
.subtabs{display:flex;gap:.4rem;padding:.4rem 0 0;border-bottom:1px solid var(--border);margin-bottom:.9rem}
.subtab{padding:.35rem .8rem;border-radius:6px 6px 0 0;font-size:13px;color:var(--text-muted)}
.subtab.active{background:var(--bg-muted);color:var(--text);font-weight:600}
.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;margin-bottom:.9rem}
.card h2{font-size:14px;margin:0 0 .7rem;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:.55rem .45rem;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--text-muted);font-weight:600;font-size:12px}
td.login{font-weight:600}
td.muted{color:var(--text-muted);font-size:12px;white-space:nowrap}
td.act{white-space:nowrap}
td.act form{display:inline-flex;gap:.3rem;align-items:center}
select{padding:.3rem .4rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font:inherit;font-size:12px}
button.btn-mini,.btn-mini{padding:.3rem .55rem;border:0;border-radius:4px;background:var(--bg-muted);color:var(--text);font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--border)}
button.btn-mini:hover{border-color:var(--accent)}
button.btn-danger{padding:.3rem .55rem;border:0;border-radius:4px;background:#f85149;color:#fff;font:inherit;font-size:12px;cursor:pointer}
button[disabled]{opacity:.4;cursor:not-allowed}
.badge{font-size:11px;font-weight:600;padding:.1rem .45rem;border-radius:4px;line-height:1.5;background:var(--bg-muted);color:var(--text-muted)}
.badge.role-admin{background:color-mix(in srgb,var(--system) 18%,transparent);color:var(--system)}
.badge.role-writer{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.badge.role-reader{background:var(--bg-muted);color:var(--text-muted)}
.badge.bot{background:color-mix(in srgb,var(--bot) 18%,transparent);color:var(--bot)}
.badge.inactive{background:#f85149;color:#fff}
.hint{color:var(--text-muted);font-size:12px;line-height:1.5;margin:.4rem 0}
label{display:block;font-size:12px;color:var(--text-muted);margin:0 0 .25rem}
select{width:100%;box-sizing:border-box;padding:.5rem .65rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:14px;margin-bottom:.7rem}
button.primary{padding:.5rem 1rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
</style></head><body>
<header class="topbar"><span style="font-weight:600">👥 ${escapeHtml(project.owner)}/${escapeHtml(project.name)} · 成员</span></header>
${tabNavHTML("projects")}
<main class="wrap">
<h1><a href="/${escapeAttr(project.owner)}/${escapeAttr(project.name)}/issues">${escapeHtml(project.owner)}/${escapeHtml(project.name)}</a> · 成员</h1>
${projectSettingsTabsHTML(project.owner, project.name, "members")}
${flashHtml}

<form class="card" method="POST" action="${escapeAttr(`/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/visibility`)}}">
<h2>可见性</h2>
<div class="form-grid">
<div>
<label for="vis">项目可见性</label>
<select id="vis" name="visibility">
<option value="public"${project.visibility === "public" ? " selected" : ""}>🌐 公开 — 所有登录用户可见</option>
<option value="private"${project.visibility === "private" ? " selected" : ""}>🔒 私有 — 仅项目成员可见</option>
</select>
</div>
</div>
<div class="hint">公开 = 任何登录用户都能查看 issue 和评论；私有 = 需要项目成员（reader+）权限。Bot 用户已自动获得 writer 角色，不受影响。</div>
<button class="primary" type="submit">保存</button>
</form>

<form class="card" method="POST" action="${escapeAttr(`/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/dispatch`)}">
<h2>AI 自动接单</h2>
<div class="hint">关闭后，本项目新建 issue 不会自动派给 AI；评论仍可显式召唤。</div>
<button type="submit" class="${dispatchOff ? "primary" : "secondary"}">${dispatchOff ? "🔔 开启自动接单" : "🔕 关闭自动接单"}</button>
</form>

<div class="card">
<h2>当前成员（${members.length}）</h2>
${rowsHtml}
</div>

${addFormHtml}
</main></body></html>`;
}

async function memberRowHtml(m: ProjectMemberWithUser, viewer: UserRow, project: ProjectRow): Promise<string> {
  const isSelf = m.user_login === viewer.login;
  const isAdminCountOne = m.role === "admin" && (await countProjectAdmins(project.id)) <= 1;
  const kindBadge = m.user_kind === "bot" ? `<span class="badge bot">bot</span>` : m.user_kind === "system" ? `<span class="badge">system</span>` : "";
  const inactiveBadge = m.user_is_active === 1 ? "" : `<span class="badge inactive">禁用</span>`;
  const selfNote = isSelf ? `<span class="meta">(你)</span>` : "";
  const disableRole = isSelf && isAdminCountOne;
  const disableRemove = isAdminCountOne;

  const roleSelect = `<form method="POST" action="${escapeAttr(`/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/members/${encodeURIComponent(m.user_login)}/role`)}">
<select name="role" onchange="this.form.submit()">
${ALL_ROLES.map((r) => `<option value="${r}"${r === m.role ? " selected" : ""}>${r}</option>`).join("")}
</select>
${disableRole ? `<span class="meta" title="最后一个 admin 不能改自己">🔒</span>` : ""}
</form>`;

  const removeBtn = `<form method="POST" action="${escapeAttr(`/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/members/${encodeURIComponent(m.user_login)}/remove`)}" onsubmit="return confirm('移除成员 ${escapeAttr(m.user_login)}？')">
<button type="submit" class="btn-danger"${disableRemove ? " disabled title='最后一个 admin 不能移除'" : ""}>移除</button>
</form>`;

  return `<tr>
<td class="login">${escapeHtml(m.user_login)} ${selfNote} ${kindBadge} ${inactiveBadge}</td>
<td>${roleBadge(m.role)}</td>
<td class="muted">${escapeHtml((m.created_at || "").slice(0, 10))}</td>
<td class="act">${roleSelect} ${removeBtn}</td>
</tr>`;
}
