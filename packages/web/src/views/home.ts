import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";
import { listProjectsWithCounts, createProject, canAdminProject, StoreError, type ProjectWithCounts, type UserRow } from "../store";
import { relTime } from "../render/components";
import { getDefaultUpstreamUrl, webUrlFromClone } from "./projectUpstreams";

async function projectCard(p: ProjectWithCounts, viewer: UserRow | null): Promise<string> {
  const issuesHref = `/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}/issues`;
  const settingsHref = `/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}/settings/upstreams`;
  const desc = p.description ? `<div class="pcard-desc">${escapeHtml(p.description)}</div>` : "";
  const upstreamClone = getDefaultUpstreamUrl(p);
  const upstreamWebUrl = upstreamClone ? webUrlFromClone(upstreamClone) : null;
  const upstreamIcon = upstreamWebUrl
    ? `<a class="pcard-icon" href="${escapeAttr(upstreamWebUrl)}" target="_blank" rel="noopener noreferrer" title="查看上游：${escapeAttr(upstreamWebUrl)}" aria-label="查看上游">🔗</a>`
    : "";
  const adminIcon = await canAdminProject(p.id, viewer)
    ? `<a class="pcard-icon" href="${escapeAttr(settingsHref)}" title="项目设置（上游 / Webhooks / 成员）" aria-label="项目设置">⚙️</a>`
    : "";
  const iconsHtml = (upstreamIcon || adminIcon)
    ? `<span class="pcard-icons">${upstreamIcon}${adminIcon}</span>`
    : "";
  return `<div class="pcard">
    <a class="pcard-stretched" href="${escapeAttr(issuesHref)}" aria-label="${escapeAttr(p.owner + "/" + p.name)} issues"></a>
    <div class="pcard-title">${escapeHtml(p.owner)}<span style="opacity:.55">/</span>${escapeHtml(p.name)}</div>
    ${desc}
    <div class="pcard-meta">
      <span class="pcard-stats">📂 ${p.total_count} · 🟢 ${p.open_count} · ${relTime(p.updated_at)}</span>
      ${iconsHtml}
    </div>
  </div>`;
}

export async function buildHome(
  viewer: UserRow | null,
  flash: { kind: "ok" | "err"; msg: string } | null = null
): Promise<string> {
  const projects = await listProjectsWithCounts(viewer);
  const cards = await Promise.all(projects.map((p) => projectCard(p, viewer)));
  const list = projects.length
    ? cards.join("")
    : `<div class="empty">还没有项目。在下面创建一个：</div>`;
  const flashHtml = flash
    ? `<div class="flash ${flash.kind === "ok" ? "ok" : "err"}">${escapeHtml(flash.msg)}</div>`
    : "";
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>ework-web · 项目</title>
<style>${THEME_CSS}
.home-wrap{max-width:900px;margin:0 auto;padding:.6rem 1rem 3rem}
.pcard{position:relative;display:block;padding:.7rem .9rem;background:var(--bg-elev);border:1px solid var(--border);border-radius:8px;margin-bottom:.5rem;color:var(--text)}
.pcard:hover{text-decoration:none;border-color:var(--accent)}
.pcard-stretched{position:absolute;inset:0;z-index:1}
.pcard-title{font-weight:600;font-size:15px;overflow-wrap:anywhere}
.pcard-desc{color:var(--text-muted);font-size:13px;margin-top:.2rem;line-height:1.4;overflow-wrap:anywhere}
.pcard-meta{color:var(--text-muted);font-size:12px;margin-top:.3rem;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.pcard-stats{min-width:0}
.pcard-icons{display:inline-flex;gap:.3rem;align-items:center;position:relative;z-index:2;margin-left:auto}
.pcard-icon{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 .35rem;border:1px solid var(--border);border-radius:5px;background:var(--bg-elev);color:var(--text-muted);font-size:13px;text-decoration:none}
.pcard-icon:hover{text-decoration:none;border-color:var(--accent);color:var(--accent)}
.empty{color:var(--text-muted);text-align:center;padding:2rem;font-size:13px}
.section{margin-top:1.6rem}
.section h2{font-size:14px;margin:0 0 .6rem;color:var(--text-muted);font-weight:600}
.new-form{display:flex;flex-direction:column;gap:.5rem;max-width:480px}
.new-form input,.new-form textarea{background:var(--bg-elev);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.5rem .7rem;font:inherit}
.new-form textarea{min-height:4em;resize:vertical}
.new-form button{align-self:flex-start;background:var(--green);color:#fff;border:none;border-radius:8px;padding:.5rem 1rem;font:600 13px system-ui,sans-serif;cursor:pointer}
.err{color:#f85149;font-size:13px}
.flash{padding:.55rem .8rem;border-radius:6px;font-size:13px;margin-bottom:.6rem;border:1px solid var(--border)}
.flash.ok{background:rgba(63,185,80,.12);color:#3fb950;border-color:rgba(63,185,80,.4)}
.flash.err{background:rgba(248,81,73,.12);color:#f85149;border-color:rgba(248,81,73,.4)}
</style></head><body>
<header class="topbar"><span style="font-weight:600">📦 ework</span></header>
${tabNavHTML("projects")}
<main class="home-wrap">
  ${flashHtml}
  <div class="section">
    <h2>项目</h2>
    <div class="pcards">${list}</div>
  </div>
  <div class="section">
    <h2>新建项目</h2>
    <form class="new-form" method="POST" action="/projects">
      <input type="text" name="owner" placeholder="owner（必填，字母数字 . _ -）" required pattern="[A-Za-z0-9_.-]+" maxlength="64">
      <input type="text" name="name" placeholder="name（必填，字母数字 . _ -）" required pattern="[A-Za-z0-9_.-]+" maxlength="64">
      <textarea name="description" placeholder="一句话描述（可选）"></textarea>
      <button type="submit">创建</button>
    </form>
  </div>
</main>
</body></html>`;
}

export async function handleCreateProject(
  form: Record<string, string | undefined>,
  defaultModel: string,
): Promise<{ location: string; error?: string; projectId?: number }> {
  const owner = (form.owner ?? "").trim();
  const name = (form.name ?? "").trim();
  const description = (form.description ?? "").trim();
  if (!owner || !name) return { location: "/projects", error: "owner 和 name 必填" };
  try {
    const p = await createProject(owner, name, description, defaultModel);
    return { location: `/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}/issues`, projectId: p.id };
  } catch (e) {
    return {
      location: "/projects",
      error: e instanceof StoreError ? e.message : e instanceof Error ? e.message : "创建失败",
    };
  }
}
