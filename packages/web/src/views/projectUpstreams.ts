import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";
import {
  getDefaultUpstreamUrl,
  getProjectUpstreamUrls,
  setProjectUpstreamUrls,
  StoreError,
  type ProjectRow,
  type UserRow,
} from "../store";

interface Flash {
  kind: "ok" | "err";
  msg: string;
}

export function projectSettingsTabsHTML(
  owner: string,
  name: string,
  active: "webhooks" | "members" | "upstreams" | "model",
): string {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/settings`;
  const cls = (which: typeof active) => (active === which ? " active" : "");
  return `<nav class="subtabs">
    <a class="subtab${cls("webhooks")}" href="${escapeAttr(base)}/webhooks">Webhooks</a>
    <a class="subtab${cls("members")}" href="${escapeAttr(base)}/members">成员</a>
    <a class="subtab${cls("upstreams")}" href="${escapeAttr(base)}/upstreams">上游</a>
    <a class="subtab${cls("model")}" href="${escapeAttr(base)}/model">🤖 模型</a>
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

export function buildProjectUpstreamsPage(
  _viewer: UserRow,
  project: ProjectRow,
  flash: Flash | null,
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
</main></body></html>`;
}

export function parseUpstreamUrlsForm(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
