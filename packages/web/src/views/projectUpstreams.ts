import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";
import {
  getDefaultUpstreamUrl,
  getProjectUpstreamUrls,
  setProjectUpstreamUrls,
  upsertUpstreamSync,
  StoreError,
  type ProjectRow,
  type UpstreamSyncRow,
  type UserRow,
} from "../store";

interface Flash {
  kind: "ok" | "err";
  msg: string;
}

export function projectSettingsTabsHTML(
  owner: string,
  name: string,
  active: "webhooks" | "members" | "upstreams" | "model" | "labels" | "ai",
): string {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/settings`;
  const cls = (which: typeof active) => (active === which ? " active" : "");
  return `<nav class="subtabs">
    <a class="subtab${cls("webhooks")}" href="${escapeAttr(base)}/webhooks">Webhooks</a>
    <a class="subtab${cls("members")}" href="${escapeAttr(base)}/members">成员</a>
    <a class="subtab${cls("upstreams")}" href="${escapeAttr(base)}/upstreams">上游</a>
    <a class="subtab${cls("labels")}" href="${escapeAttr(base)}/labels">🏷️ 标签</a>
    <a class="subtab${cls("ai")}" href="${escapeAttr(base)}/ai">🤖 AI</a>
    <a class="subtab${cls("model")}" href="${escapeAttr(base)}/model">⚙️ 模型</a>
  </nav>`;
}

// Try to convert a Git clone URL into a clickable web URL. Returns null if the
// protocol can't be reliably mapped (e.g. SSH SCP form `git@host:o/r`).
function webUrlFromClone(cloneUrl: string): string | null {
  if (/^https?:\/\//i.test(cloneUrl)) {
    return cloneUrl.replace(/\.git$/i, "");
  }
  if (/^ssh:\/\/([^/]+)\/(.+)$/i.test(cloneUrl)) {
    // ssh://user@host:port/owner/repo → https://host/owner/repo
    const m = cloneUrl.match(/^ssh:\/\/(?:[^@]*@)?([^:/]+)(?::\d+)?\/(.+)$/i);
    if (m && m[1] && m[2]) return `https://${m[1]}/${m[2].replace(/\.git$/i, "")}`;
  }
  return null;
}

function urlRowHtml(url: string, idx: number): string {
  const isDefault = idx === 0;
  const webUrl = webUrlFromClone(url);
  const link = webUrl
    ? `<a href="${escapeAttr(webUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
    : `<code>${escapeHtml(url)}</code>`;
  return `<tr>
    <td class="idx">${isDefault ? '<span class="badge default">默认</span>' : String(idx + 1)}</td>
    <td class="url">${link}</td>
  </tr>`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleString("zh-CN", { hour12: false });
}

function syncCardHtml(project: ProjectRow, sync: UpstreamSyncRow | null): string {
  const action = `/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/upstream-sync`;
  const enabled = sync?.enabled === 1;
  const statusHtml = sync
    ? `<table>
<thead><tr><th>状态</th><th>最近轮询</th><th>进度游标</th></tr></thead>
<tbody><tr>
<td>${enabled ? '<span class="badge default">运行中</span>' : "已停用"}</td>
<td>${escapeHtml(fmtDate(sync.last_poll_at))}${sync.last_error ? `<div class="err-text">⚠️ ${escapeHtml(sync.last_error)}</div>` : ""}</td>
<td>issue #${sync.issue_cursor ? String(sync.issue_cursor).slice(0, 10) : "未同步"} · 评论 #${sync.comment_cursor ? String(sync.comment_cursor).slice(0, 10) : "未同步"}</td>
</tr></tbody></table>`
    : `<div class="hint">尚未配置。填写下方表单后，web 会定时从上游 Gitea 拉取 issue/评论（单向同步：上游 → 本地），首次会静默回填全部开放 issue，之后新事件按正常消息分发。</div>`;
  const baseUrl = sync?.base_url ?? guessUpstreamBase(project) ?? "";
  return `<form class="card" method="POST" action="${escapeAttr(action)}">
<h2>🔄 上游 Gitea 同步（单向拉取）</h2>
${statusHtml}
<div class="form-grid">
<div><label for="s-base">上游地址（Gitea 根地址，如 http://host:3000）</label>
<input id="s-base" name="base_url" type="url" placeholder="http://192.168.1.100:3300" value="${escapeAttr(baseUrl)}" required></div>
<div><label for="s-owner">上游 owner</label>
<input id="s-owner" name="upstream_owner" value="${escapeAttr(sync?.upstream_owner ?? project.owner)}" required></div>
<div><label for="s-repo">上游 repo</label>
<input id="s-repo" name="upstream_repo" value="${escapeAttr(sync?.upstream_repo ?? project.name)}" required></div>
<div><label for="s-token">访问 token（留空保持不变）</label>
<input id="s-token" name="token" type="password" placeholder="${sync?.token ? "已保存（留空不变）" : "可选，私有仓库必填"}"></div>
<div><label for="s-interval">轮询间隔（秒，最小 10）</label>
<input id="s-interval" name="poll_interval" type="number" min="10" step="1" value="${sync ? Math.round(sync.poll_interval_ms / 1000) : 60}"></div>
</div>
<label class="check"><input type="checkbox" name="enabled" value="1"${enabled ? " checked" : ""}> 启用同步</label>
<div class="hint">注意：上游需为 Gitea。地址填站点根地址即可（带不带 <code>/api/v1</code> 都可以，会自动归一）。回填阶段不触发 AI；之后的 opened/评论 事件会按正常策略唤醒 AI。</div>
<button class="primary" type="submit">保存同步配置</button>
</form>`;
}

// Heuristic: http(s) clone URL → Gitea host root; null otherwise.
function guessUpstreamBase(project: ProjectRow): string | null {
  const url = getDefaultUpstreamUrl(project);
  if (!url) return null;
  const m = url.match(/^(https?:\/\/[^\/]+)\//i);
  return m && m[1] ? m[1] : null;
}

export function buildProjectUpstreamsPage(
  _viewer: UserRow,
  project: ProjectRow,
  flash: Flash | null,
  sync: UpstreamSyncRow | null = null,
): string {
  const urls = getProjectUpstreamUrls(project);
  const rowsHtml = urls.length
    ? `<table>
<thead><tr><th>序</th><th>URL</th></tr></thead>
<tbody>${urls.map((u, i) => urlRowHtml(u, i)).join("")}</tbody>
</table>`
    : `<div class="hint">该项目还没有绑定上游 Git 仓库。在下方添加（每行一个 URL，第一个为默认上游）。</div>`;

  const flashHtml = flash ? `<div class="flash ${flash.kind}">${escapeHtml(flash.msg)}</div>` : "";
  const formAction = `/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/upstreams`;
  const textareaContent = escapeHtml(urls.join("\n"));

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>上游 · ${escapeHtml(project.owner)}/${escapeHtml(project.name)}</title>
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
td.url{word-break:break-all}
td.url code{font-family:ui-monospace,monospace;font-size:12px}
td.idx{width:60px;color:var(--text-muted);white-space:nowrap}
.badge.default{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);font-size:11px;font-weight:600;padding:.1rem .45rem;border-radius:4px}
.hint{color:var(--text-muted);font-size:12px;line-height:1.5;margin:.4rem 0}
label{display:block;font-size:12px;color:var(--text-muted);margin:0 0 .25rem}
textarea{width:100%;box-sizing:border-box;padding:.5rem .65rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-family:ui-monospace,monospace;font-size:13px;margin-bottom:.7rem;min-height:120px;resize:vertical}
button.primary{padding:.5rem 1rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.6rem;margin:.6rem 0}
.form-grid label{margin:0 0 .25rem}
input[type=url],input[type=text],input[type=password],input[type=number]{width:100%;box-sizing:border-box;padding:.45rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:13px}
label.check{display:flex;align-items:center;gap:.4rem;font-size:13px;color:var(--text);margin:.4rem 0 .6rem}
.err-text{color:#f85149;font-size:12px;margin-top:.3rem;word-break:break-all}
</style></head><body>
<header class="topbar"><span style="font-weight:600">🔗 ${escapeHtml(project.owner)}/${escapeHtml(project.name)} · 上游</span></header>
${tabNavHTML("projects")}
<main class="wrap">
<h1><a href="/${escapeAttr(project.owner)}/${escapeAttr(project.name)}/issues">${escapeHtml(project.owner)}/${escapeHtml(project.name)}</a> · 上游 Git 仓库</h1>
${projectSettingsTabsHTML(project.owner, project.name, "upstreams")}
${flashHtml}

<div class="card">
<h2>当前绑定的上游（${urls.length}）</h2>
${rowsHtml}
</div>

<form class="card" method="POST" action="${escapeAttr(formAction)}">
<h2>编辑上游 URL</h2>
<label for="f-urls">每行一个 URL；第一个为<strong>默认上游</strong>（webhook payload 的 <code>repository.clone_url</code> 会用它）</label>
<textarea id="f-urls" name="urls" placeholder="https://gitea.example.com/owner/repo.git&#10;git@github.com:owner/repo.git">${textareaContent}</textarea>
<div class="hint">支持协议：<code>http(s)://</code>、<code>ssh://</code>、<code>git@host:owner/repo</code>。最多 10 个。空行会被忽略，重复会被去重。</div>
<button class="primary" type="submit">保存</button>
</form>

${syncCardHtml(project, sync)}
</main></body></html>`;
}

export function parseUpstreamUrlsForm(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface UpstreamSyncFormInput {
  baseUrl: string;
  upstreamOwner: string;
  upstreamRepo: string;
  token?: string;
  enabled: boolean;
  pollIntervalMs: number;
}

export function parseUpstreamSyncForm(form: { get(name: string): string | File | null }): UpstreamSyncFormInput {
  const val = (name: string): string => {
    const v = form.get(name);
    return typeof v === "string" ? v.trim() : "";
  };
  const intervalRaw = Number.parseInt(val("poll_interval") || "60", 10);
  const intervalSec = Number.isFinite(intervalRaw) && intervalRaw >= 10 ? intervalRaw : 60;
  const token = val("token");
  return {
    baseUrl: val("base_url"),
    upstreamOwner: val("upstream_owner"),
    upstreamRepo: val("upstream_repo"),
    token: token.length ? token : undefined,
    enabled: val("enabled") === "1",
    pollIntervalMs: intervalSec * 1000,
  };
}

export async function trySetUpstreamSync(
  projectId: number,
  input: UpstreamSyncFormInput,
): Promise<{ ok: true } | { ok: false; msg: string }> {
  try {
    await upsertUpstreamSync(projectId, input);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof StoreError ? e.message : e instanceof Error ? e.message : "保存失败";
    return { ok: false, msg };
  }
}

export async function trySetUpstreamUrls(
  projectId: number,
  raw: string,
): Promise<{ ok: true; urls: string[] } | { ok: false; msg: string }> {
  try {
    const urls = parseUpstreamUrlsForm(raw);
    const cleaned = await setProjectUpstreamUrls(projectId, urls);
    return { ok: true, urls: cleaned };
  } catch (e) {
    const msg = e instanceof StoreError ? e.message : e instanceof Error ? e.message : "保存失败";
    return { ok: false, msg };
  }
}

export { getDefaultUpstreamUrl, webUrlFromClone };
