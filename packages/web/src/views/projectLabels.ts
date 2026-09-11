import { THEME_CSS, escapeHtml, escapeAttr } from "../render/layout";
import { BUILD_ID } from "../build";
import { projectSettingsTabsHTML } from "./projectUpstreams";
import { listLabels, type ProjectRow, type UserRow, type LabelRow } from "../store";

interface Flash {
  kind: "ok" | "err";
  msg: string;
}

const PALETTE = [
  "#888888", "#e11d48", "#db2777", "#9333ea", "#4f46e5",
  "#2563eb", "#0891b2", "#0d9488", "#16a34a", "#ca8a04",
  "#d97706", "#92400e",
];

function colorDot(c: string): string {
  return `<span class="dot" style="background:${escapeAttr(c)}"></span>`;
}

function labelRowHtml(l: LabelRow, owner: string, repo: string): string {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/settings/labels/${l.id}`;
  const exclusiveBadge = l.exclusive === 1 ? `<span class="tag" title="互斥标签（scope/name）">互斥</span>` : "";
  const archivedBadge = l.is_archived === 1 ? `<span class="tag arch">已归档</span>` : "";
  return `<tr>
    <td class="nm">${colorDot(l.color)}${escapeHtml(l.name)} ${exclusiveBadge}${archivedBadge}</td>
    <td class="desc">${escapeHtml(l.description || "—")}</td>
    <td class="act">
      <form method="POST" action="${escapeAttr(base)}/update" class="inline" data-edit="${l.id}">
        <input type="hidden" name="name" value="${escapeAttr(l.name)}">
        <input type="hidden" name="color" value="${escapeAttr(l.color)}">
        <input type="hidden" name="description" value="${escapeAttr(l.description)}">
        <input type="hidden" name="exclusive" value="${l.exclusive}">
        <button type="button" class="lnk" data-edit-btn="${l.id}">编辑</button>
      </form>
      <form method="POST" action="${escapeAttr(base)}/${l.is_archived === 1 ? "unarchive" : "archive"}" class="inline">
        <button type="submit" class="lnk">${l.is_archived === 1 ? "恢复" : "归档"}</button>
      </form>
      <form method="POST" action="${escapeAttr(base)}/delete" class="inline" onsubmit="return confirm('删除标签「${escapeAttr(l.name)}」？会从所有 issue 上移除。')">
        <button type="submit" class="lnk danger">删除</button>
      </form>
    </td>
  </tr>`;
}

export async function buildProjectLabelsPage(
  _viewer: UserRow,
  project: ProjectRow,
  flash: Flash | null,
): Promise<string> {
  const labels = await listLabels(project.id, true);
  const rowsHtml = labels.length
    ? `<table>
<thead><tr><th>标签</th><th>描述</th><th>操作</th></tr></thead>
<tbody>${labels.map((l) => labelRowHtml(l, project.owner, project.name)).join("")}</tbody>
</table>`
    : `<div class="hint">该项目还没有标签。在下方创建。</div>`;

  const flashHtml = flash ? `<div class="flash ${flash.kind}">${escapeHtml(flash.msg)}</div>` : "";
  const createAction = `/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/settings/labels/add`;
  const paletteHtml = PALETTE.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join("");

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>标签 · ${escapeHtml(project.owner)}/${escapeHtml(project.name)}</title>
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
td.nm{font-weight:500}
td.desc{color:var(--text-muted);font-size:12px}
td.act{white-space:nowrap;text-align:right}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin-right:.4rem;border:1px solid var(--border)}
.chip{display:inline-block;padding:.1rem .5rem;border:1px solid;border-radius:99px;font-size:12px;font-weight:500}
.tag{display:inline-block;margin-left:.3rem;padding:.05rem .35rem;border-radius:4px;font-size:10px;font-weight:600;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.tag.arch{background:color-mix(in srgb,var(--text-muted) 16%,transparent);color:var(--text-muted)}
.hint{color:var(--text-muted);font-size:12px;line-height:1.5;margin:.4rem 0}
label{display:block;font-size:12px;color:var(--text-muted);margin:0 0 .25rem}
input[type=text],input[type=color]{width:100%;box-sizing:border-box;padding:.5rem .65rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:inherit;font-size:13px;margin-bottom:.7rem}
input[type=color]{height:38px;padding:3px;cursor:pointer}
.row{display:flex;gap:.7rem;align-items:flex-start}
.row>div{flex:1}
.swatches{display:flex;flex-wrap:wrap;gap:.3rem;margin:.2rem 0 .7rem}
.swatch{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}
.swatch.sel{border-color:var(--text);box-shadow:0 0 0 2px var(--bg)}
.check{display:flex;align-items:center;gap:.4rem;font-size:13px;color:var(--text);margin-bottom:.7rem;cursor:pointer}
.check input{margin:0}
button.primary{padding:.5rem 1rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer}
.lnk{background:none;border:0;color:var(--accent);font-size:12px;cursor:pointer;padding:.15rem .25rem;text-decoration:underline}
.lnk.danger{color:#f85149}
form.inline{display:inline}
dialog{border:1px solid var(--border);border-radius:10px;background:var(--bg-elev);color:var(--text);padding:1.2rem;max-width:420px}
dialog::backdrop{background:rgba(0,0,0,.5)}
dialog h3{margin:0 0 .7rem;font-size:15px}
dialog .swatches{margin:.4rem 0}
dialog .row2{display:flex;gap:.6rem}
dialog .row2>div{flex:1}
</style></head><body>
<header class="topbar"><span style="font-weight:600">🏷️ ${escapeHtml(project.owner)}/${escapeHtml(project.name)} · 标签</span></header>
<main class="wrap">
<h1><a href="/${escapeAttr(project.owner)}/${escapeAttr(project.name)}/issues">${escapeHtml(project.owner)}/${escapeHtml(project.name)}</a> · 标签</h1>
${projectSettingsTabsHTML(project.owner, project.name, "labels")}
${flashHtml}

<div class="card">
<h2>已有标签（${labels.length}）</h2>
${rowsHtml}
</div>

<form class="card" method="POST" action="${escapeAttr(createAction)}">
<h2>新建标签</h2>
<div class="row">
  <div>
    <label for="f-name">名称（支持 <code>scope/name</code> 互斥语法）</label>
    <input id="f-name" name="name" type="text" required maxlength="63" placeholder="如 bug / priority/high">
  </div>
  <div style="flex:0 0 80px">
    <label for="f-color">颜色</label>
    <input id="f-color" name="color" type="color" value="#888888">
  </div>
</div>
<div class="swatches" id="palette">${paletteHtml}</div>
<label for="f-desc">描述（可选）</label>
<input id="f-desc" name="description" type="text" maxlength="255" placeholder="简短说明">
<label class="check"><input type="checkbox" name="exclusive" value="1"> 互斥标签（同 scope 下只能选一个）</label>
<div class="hint">名称含 <code>/</code> 时，<code>/</code> 前的部分为 scope。同一 scope 下的互斥标签，一个 issue 只能贴一个。</div>
<button class="primary" type="submit">创建标签</button>
</form>
</main>

<dialog id="dlg">
  <h3>编辑标签</h3>
  <form method="POST" id="edit-form">
    <div class="row2">
      <div><label>名称</label><input name="name" type="text" required maxlength="63"></div>
      <div style="flex:0 0 80px"><label>颜色</label><input name="color" type="color"></div>
    </div>
    <div class="swatches" id="dlg-palette"></div>
    <label>描述</label><input name="description" type="text" maxlength="255">
    <label class="check"><input type="checkbox" name="exclusive" value="1"> 互斥</label>
    <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.8rem">
      <button type="button" id="dlg-cancel">取消</button>
      <button type="submit" class="primary">保存</button>
    </div>
  </form>
</dialog>
<script type="application/json" id="label-data">${JSON.stringify({ labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description, exclusive: l.exclusive, is_archived: l.is_archived })), palette: PALETTE })}</script>
<script src="/static/project-labels.js?v=${BUILD_ID}" defer></script>
</body></html>`;
}
