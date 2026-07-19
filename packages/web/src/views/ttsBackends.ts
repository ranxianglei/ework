import { THEME_CSS, escapeHtml, escapeAttr, tabNavHTML } from "../render/layout";
import type { TtsBackend } from "../config";
import type { UserRow } from "../store";

interface Flash {
  kind: "ok" | "err";
  msg: string;
}

function backendCard(b: TtsBackend, defaultId: string): string {
  const isDefault = b.id === defaultId;
  const idAttr = escapeAttr(b.id);
  const action = `/admin/tts-backends/${encodeURIComponent(b.id)}/update`;
  const deleteForm = isDefault
    ? `<span class="muted">默认后端不能删除（先在<a href="/settings">设置</a>里改默认）</span>`
    : `<form method="POST" action="/admin/tts-backends/${encodeURIComponent(b.id)}/delete" class="inline">
         <button type="submit" class="btn-danger" onclick="return confirm('删除后端 ${escapeAttr(b.id)}？')">删除</button>
       </form>`;
  return `<div class="card backend">
    <div class="backend-head">
      <code>${escapeHtml(b.id)}</code>
      ${isDefault ? `<span class="badge default">默认</span>` : ""}
    </div>
    <form method="POST" action="${action}" class="grid-form">
      <label class="sf"><span>ID</span><input type="text" name="id" value="${idAttr}" required pattern="[A-Za-z0-9_-]+"></label>
      <label class="sf"><span>显示名</span><input type="text" name="label" value="${escapeAttr(b.label)}" required></label>
      <label class="sf"><span>API URL</span><input type="text" name="url" value="${escapeAttr(b.url)}" placeholder="http://localhost:9880/v1"></label>
      <label class="sf"><span>voice</span><input type="text" name="voice" value="${escapeAttr(b.voice)}"></label>
      <div class="actions">
        <button type="submit">保存</button>
        ${deleteForm}
      </div>
    </form>
  </div>`;
}

export function buildTtsBackendsPage(
  viewer: UserRow,
  backends: TtsBackend[],
  defaultId: string,
  flash: Flash | null,
): string {
  const flashHtml = flash ? `<div class="flash ${flash.kind}">${escapeHtml(flash.msg)}</div>` : "";
  const listHtml = backends.length
    ? backends.map((b) => backendCard(b, defaultId)).join("")
    : `<div class="hint">还没有任何后端，先添加一个。</div>`;

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>朗读后端管理 · ework</title>
<style>${THEME_CSS}
.flash{padding:.5rem .7rem;border-radius:6px;font-size:13px;margin-bottom:.8rem}
.flash.ok{background:color-mix(in srgb,var(--green) 18%,transparent);color:var(--green)}
.flash.err{background:color-mix(in srgb,#f85149 18%,transparent);color:#f85149}
.wrap{max-width:760px;margin:0 auto;padding:1rem}
h1{font-size:18px;margin:0 0 .4rem}
.hint{color:var(--text-muted);font-size:13px;line-height:1.55;margin:0 0 1rem}
.hint code{background:var(--bg-muted);padding:.05rem .3rem;border-radius:3px;font-size:12px;color:var(--text-muted)}
.card{background:var(--bg-elev);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;margin-bottom:.9rem}
.card h2{font-size:14px;margin:0 0 .7rem;font-weight:600}
.backend .backend-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem}
.backend code{background:var(--bg-muted);padding:.15rem .45rem;border-radius:4px;font-size:13px;color:var(--text-muted)}
.badge.default{background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);font-size:11px;font-weight:600;padding:.1rem .45rem;border-radius:4px}
.grid-form{display:grid;grid-template-columns:1fr 1fr;gap:.55rem .8rem}
.sf{display:flex;flex-direction:column;gap:.2rem;font-size:12px;color:var(--text-muted)}
.sf input{padding:.35rem .5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;font-family:inherit}
.sf input:focus{outline:none;border-color:var(--accent)}
.actions{grid-column:1 / -1;display:flex;gap:.6rem;align-items:center;margin-top:.2rem}
.actions button,.btn-danger{padding:.4rem .9rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;font-size:13px;cursor:pointer}
.btn-danger{background:#f85149}
.inline{display:inline}
.muted{color:var(--text-muted);font-size:12px}
.muted a{color:var(--text-muted);text-decoration:underline}
</style></head><body>
<header class="topbar"><span style="font-weight:600">🔊 朗读后端管理（管理员）</span></header>
${tabNavHTML("projects", { login: viewer.login, is_admin: viewer.is_admin })}
<main class="wrap">
<h1>朗读 (TTS) 后端</h1>
<p class="hint">每个后端四个字段：<code>id</code>（机器标识，仅 <code>A-Z a-z 0-9 _ -</code>）、<code>label</code>（用户可见名）、<code>url</code>（OpenAI-compatible TTS API）、<code>voice</code>（声纹名）。改完保存立即生效，不入 .env、不重启。</p>
${flashHtml}

<div class="card add">
  <h2>添加新后端</h2>
  <form method="POST" action="/admin/tts-backends/add" class="grid-form">
    <label class="sf"><span>ID</span><input type="text" name="id" required pattern="[A-Za-z0-9_-]+" placeholder="kokoro"></label>
    <label class="sf"><span>显示名</span><input type="text" name="label" required placeholder="Kokoro（快）"></label>
    <label class="sf"><span>API URL</span><input type="text" name="url" placeholder="http://localhost:9880/v1"></label>
    <label class="sf"><span>voice</span><input type="text" name="voice" placeholder="zf_001"></label>
    <div class="actions"><button type="submit">添加</button></div>
  </form>
</div>

<h2 style="font-size:14px;margin:1rem 0 .55rem">现有后端（${backends.length}）</h2>
${listHtml}
</main></body></html>`;
}
