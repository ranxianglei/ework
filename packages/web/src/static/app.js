"use strict";
(function () {
  // Initial data is in a <script type="application/json" id="initial-data"> block,
  // NOT an inline executable script — CSP script-src 'self' blocks inline scripts, so
  // a plain <script>window.__INITIAL__=...</script> would be stripped and we'd bail.
  const initialEl = document.getElementById("initial-data");
  const P = initialEl ? JSON.parse(initialEl.textContent) : null;
  if (!P) return;
  const MAX_DOM = 300;
  const POLL_MS = 5000;
  const NEW_FADE_MS = 4500;

  // Reverse-chronological: items[0] = newest (top), last = oldest (bottom).
  // P.commentSort drives display order: 'desc' (default) renders items as-is;
  // 'asc' renders reversed so oldest sits at top. Internal state stays canonical DESC.
  const commentSort = P.commentSort === "asc" ? "asc" : "desc";
  const state = {
    items: P.comments.slice(),
    owner: P.owner,
    repo: P.repo,
    number: P.number,
    totalComments: P.totalComments,
    oldestPage: P.currentPage,
    hasOlder: P.hasOlder,
    sinceISO: P.sinceISO,
    seenIds: new Set(P.comments.map((c) => c.id)),
    newIds: new Set(),
    booted: false,
  };

  const $ = (id) => document.getElementById(id);
  const itemsEl = $("items");
  const countEl = $("count");
  const olderWrap = $("loadOlderWrap");
  const olderBtn = $("loadOlder");
  const composer = $("composer");
  const composerInput = $("composerInput");
  const composerSubmit = $("composerSubmit");
  const composerClose = $("composerClose");
  const composerFile = $("composerFile");
  const descToggle = $("descToggle");

  // Track the last text selection per comment root: clicking 🔊 clears the live
  // selection, so we remember the selection's Range and use it when the button fires.
  let ttsSelRoot = null;
  let ttsSelRange = null;
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const n = r.startContainer;
    const el = n.nodeType === 3 ? n.parentElement : n;
    const cb = el && el.closest ? el.closest(".card-b") : null;
    if (cb) { ttsSelRoot = cb; ttsSelRange = r.cloneRange(); }
  });
  const issueDesc = $("issueDesc");
  const toLatest = ensureToLatest();

  function ensureToLatest() {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "↑ 最新";
    const s = b.style;
    s.position = "fixed";
    s.right = "14px";
    s.bottom = "14px";
    s.zIndex = "50";
    s.border = "1px solid var(--border)";
    s.borderRadius = "999px";
    s.padding = ".45rem .9rem";
    s.background = "var(--bg-elev)";
    s.color = "var(--text)";
    s.boxShadow = "0 2px 10px rgba(0,0,0,.18)";
    s.font = "600 13px system-ui,sans-serif";
    s.cursor = "pointer";
    b.classList.add("hidden");
    b.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    document.body.appendChild(b);
    return b;
  }

  function api(kind, params) {
    const q = new URLSearchParams(params).toString();
    return fetch(`/api/${state.owner}/${state.repo}/issues/${state.number}/${kind}?${q}`).then((r) =>
      r.json()
    );
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const d = (Date.now() - t) / 1000;
    if (d < 60) return "刚刚";
    if (d < 3600) return Math.floor(d / 60) + "分钟前";
    if (d < 86400) return Math.floor(d / 3600) + "小时前";
    if (d < 86400 * 30) return Math.floor(d / 86400) + "天前";
    return new Date(t).toISOString().slice(0, 10);
  }

  const TAG_LABEL = { human: "👤", bot: "🤖", system: "⚙️" };

  function cardHTML(c) {
    const tag = c.tag || "human";
    const label = TAG_LABEL[tag] || "👤";
    const isNew = state.newIds.has(c.id) ? " new-marker" : "";
    const rx = c.reactions && c.reactions.length
      ? `<span class="rx">` + c.reactions.map(function (r) { return `<span class="rxc">${r.e}<span class="rxn">${r.n}</span></span>`; }).join("") + `</span>`
      : "";
    return (
      `<div class="item item-${esc(tag)}${isNew}" id="comment-${c.id}" data-id="${c.id}">` +
      `<div class="card"><div class="card-h">` +
      `<span class="tag tag-${esc(tag)}">${label} ${esc(tag)}</span>` +
      `<span class="who">${esc(c.login)}</span>` +
      `<span class="when" data-ts="${esc(c.created_at)}" title="${esc(c.created_at)}">${relTime(c.created_at)}</span>` +
      rx +
      `<span class="card-actions">` +
      `<button type="button" class="cbtn" data-cid="${c.id}" title="复制">📋</button>` +
      `<button type="button" class="clink" data-cid="${c.id}" title="复制楼层链接">🔗</button>` +
      `<button type="button" class="tbtn" data-cid="${c.id}" title="翻译">翻译</button>` +
      `<button type="button" class="ttsstop" data-cid="${c.id}" title="停止朗读">⏹</button>` +
      `<button type="button" class="ttsbtn" data-cid="${c.id}" title="朗读（选中起点）">🔊</button>` +
      `</span>` +
      `</div><div class="card-b">${c.body_html}</div></div></div>`
    );
  }

  // Rebuilding innerHTML destroys the DOM nodes under an active text selection, which
  // cancels it (felt as "select then immediately deselected" on active issues that poll
  // every few seconds). When the user is mid-selection, skip the rebuild — state/cursor
  // still update, the view refreshes on the next non-selecting render.
  function hasTextSelection() {
    const s = window.getSelection();
    return !!s && !s.isCollapsed && s.toString().length > 0;
  }

  let trActive = 0;

  function render(preserveScroll) {
    const prevH = preserveScroll ? document.body.scrollHeight : 0;
    const prevTop = preserveScroll ? window.scrollY : 0;
    const over = state.items.length - MAX_DOM;
    if (over > 0) state.items.splice(state.items.length - over, over);
    if (trActive > 0 || (window.TTS && window.TTS.isActive()) || hasTextSelection()) return;
    const displayItems = commentSort === "asc" ? state.items.slice().reverse() : state.items;
    itemsEl.innerHTML = displayItems.map(cardHTML).join("");
    if (countEl) countEl.textContent = `已加载 ${state.items.length} · 共 ${state.totalComments}`;
    olderWrap.classList.toggle("hidden", !state.hasOlder);
    if (preserveScroll && prevTop > 0) {
      window.scrollTo(0, prevTop + (document.body.scrollHeight - prevH));
    } else if (!state.booted) {
      state.booted = true;
      requestAnimationFrame(() => window.scrollTo(0, 0));
    }
    if (state.newIds.size) {
      const ids = state.newIds;
      state.newIds = new Set();
      setTimeout(() => {
        ids.forEach((id) => {
          const el = itemsEl.querySelector(`.item[data-id="${id}"]`);
          if (el) el.classList.remove("new-marker");
        });
      }, NEW_FADE_MS);
    }
    refreshToLatest();
  }

  function isNearTop() {
    return window.scrollY <= 120;
  }

  function refreshToLatest() {
    toLatest.classList.toggle("hidden", isNearTop());
  }

  function mergeFront(views, markNew) {
    let added = 0;
    for (const c of views) {
      if (state.seenIds.has(c.id)) continue;
      state.seenIds.add(c.id);
      state.items.unshift(c);
      if (markNew) state.newIds.add(c.id);
      added++;
    }
    return added;
  }

  function mergeBack(views, markNew) {
    let added = 0;
    for (const c of views) {
      if (state.seenIds.has(c.id)) continue;
      state.seenIds.add(c.id);
      state.items.push(c);
      if (markNew) state.newIds.add(c.id);
      added++;
    }
    return added;
  }

  olderBtn.addEventListener("click", async () => {
    olderBtn.disabled = true;
    olderBtn.textContent = "加载中…";
    try {
      const page = state.oldestPage - 1;
      const data = await api("page", { page });
      if (data.error) throw new Error(data.error);
      mergeBack((data.comments || []).slice().reverse(), false);
      state.oldestPage = page;
      state.hasOlder = data.hasOlder !== false && page > 1;
      render(false);
    } catch (e) {
      olderBtn.textContent = "重试加载更早";
    } finally {
      olderBtn.disabled = false;
      olderBtn.textContent = "加载更早";
    }
  });

  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }
  // Shared action toolbar (📋 copy / 🔗 link / 翻译 translate): comments live in
  // itemsEl (re-rendered each poll → delegate), issue description lives in .desc-wrap.
  const inlineMd = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const miniMd = (s) => {
    const lines = s.split("\n");
    let out = "", inUl = false, inCode = false, codeBuf = "", tableBuf = [];
    const flushUl = () => { if (inUl) { out += "</ul>"; inUl = false; } };
    const isRow = (l) => /^\|.+\|$/.test(l);
    const isSep = (l) => /^\|[\s:|-]+\|$/.test(l);
    const cell = (r) => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
    const renderTable = (buf) => {
      if (buf.length < 2 || !isSep(buf[1])) return buf.map(l => inlineMd(l) + "<br>").join("");
      let h = "<table><thead><tr>" + cell(buf[0]).map(c => "<th>" + inlineMd(c) + "</th>").join("") + "</tr></thead>";
      if (buf.length > 2) h += "<tbody>" + buf.slice(2).map(r => "<tr>" + cell(r).map(c => "<td>" + inlineMd(c) + "</td>").join("") + "</tr>").join("") + "</tbody>";
      return h + "</table>";
    };
    const flushTable = () => { if (tableBuf.length) { out += renderTable(tableBuf); tableBuf = []; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (/^```/.test(line)) {
        flushUl(); flushTable();
        if (inCode) { out += `<pre><code>${esc(codeBuf.replace(/\n$/, ""))}</code></pre>`; inCode = false; codeBuf = ""; }
        else { inCode = true; }
        continue;
      }
      if (inCode) { codeBuf += raw + "\n"; continue; }
      if (isRow(line)) { flushUl(); tableBuf.push(line); continue; }
      flushTable();
      const hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { flushUl(); out += `<h${hm[1].length}>${inlineMd(hm[2])}</h${hm[1].length}>`; continue; }
      const m = line.match(/^[-*]\s+(.*)$/);
      if (m) { if (!inUl) { out += "<ul>"; inUl = true; } out += "<li>" + inlineMd(m[1]) + "</li>"; }
      else { flushUl(); out += line ? inlineMd(line) + "<br>" : "<br>"; }
    }
    flushUl(); flushTable();
    if (inCode) out += `<pre><code>${esc(codeBuf.replace(/\n$/, ""))}</code></pre>`;
    return out;
  };
  function actionRoot(btn) {
    const item = btn.closest(".item");
    if (item) return item.querySelector(".card-b");
    const dw = btn.closest(".desc-wrap");
    if (dw) return dw.querySelector("#issueDesc") || dw.querySelector(".desc");
    return null;
  }

  function doCopy(btn) {
    const root = actionRoot(btn);
    if (!root) return;
    copyText(root.innerText).then(() => {
      btn.textContent = "✅"; btn.classList.add("done");
      setTimeout(() => { btn.textContent = "📋"; btn.classList.remove("done"); }, 1500);
    });
  }

  async function doTranslate(btn) {
    const root = actionRoot(btn);
    if (!root) return;
    if (btn.dataset.tr === "1") { btn.dataset.tr = "0"; btn.textContent = "翻译"; root.innerHTML = btn.dataset.orig; return; }
    const text = root.innerText.trim();
    if (!text) return;
    if (!btn.dataset.orig) btn.dataset.orig = root.innerHTML;
    btn.textContent = "⏳";
    trActive++;
    try {
      const res = await fetch("/api/translate/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok || !res.body) throw new Error("http " + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", full = "", html = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          const s = line.trim(); if (!s) continue;
          let obj; try { obj = JSON.parse(s); } catch (e) { continue; }
          if (obj.d) { full += obj.d; root.innerHTML = miniMd(full); }
          else if (obj.h) { html = obj.h; }
          else if (obj.e) { throw new Error(obj.e); }
        }
      }
      if (buf.trim()) { try { const obj = JSON.parse(buf.trim()); if (obj.h) html = obj.h; } catch (e) {} }
      if (html) root.innerHTML = html;
      btn.dataset.tr = "1"; btn.textContent = "原文";
    } catch (e) {
      btn.textContent = "❌";
      setTimeout(() => { btn.textContent = "翻译"; }, 1500);
    } finally {
      trActive--;
    }
  }

  itemsEl.addEventListener("click", (e) => {
    const link = e.target.closest(".clink");
    if (link) {
      const cid = link.dataset.cid;
      const url = location.origin + location.pathname + "#" + (cid ? "comment-" + cid : "issueDesc");
      copyText(url).then(() => {
        link.textContent = "✅"; link.classList.add("done");
        setTimeout(() => { link.textContent = "🔗"; link.classList.remove("done"); }, 1500);
      });
      return;
    }
    if (e.target.closest(".cbtn")) { doCopy(e.target.closest(".cbtn")); return; }
    if (e.target.closest(".tbtn")) { doTranslate(e.target.closest(".tbtn")); return; }
  });

  itemsEl.addEventListener("click", (e) => {
    if (e.target.closest(".ttsstop")) { e.stopPropagation(); if (window.TTS) window.TTS.stop(); return; }
    const tb = e.target.closest(".ttsbtn");
    if (!tb) return;
    const item = tb.closest(".item");
    if (!item) return;
    const body = item.querySelector(".card-b");
    if (!body) return;
    let text = "";
    if (ttsSelRoot === body && ttsSelRange) {
      const r = ttsSelRange.cloneRange();
      try { r.setEnd(body, body.childNodes.length); } catch (e2) {}
      text = r.toString().trim();
    }
    if (!text) text = body.innerText.trim();
    if (!text) return;
    window.TTS.start({ text, btn: tb });
  });

  const descWrap = document.querySelector(".desc-wrap");
  if (descWrap) {
    descWrap.addEventListener("click", (e) => {
      if (e.target.closest(".cbtn")) { doCopy(e.target.closest(".cbtn")); return; }
      if (e.target.closest(".tbtn")) { doTranslate(e.target.closest(".tbtn")); return; }
      const lk = e.target.closest(".clink");
      if (lk) {
        const url = location.origin + location.pathname + "#issueDesc";
        copyText(url).then(() => { lk.textContent = "✅"; lk.classList.add("done"); setTimeout(() => { lk.textContent = "🔗"; lk.classList.remove("done"); }, 1500); });
        return;
      }
      if (e.target.closest(".ttsstop")) { e.stopPropagation(); if (window.TTS) window.TTS.stop(); return; }
      const tb = e.target.closest(".ttsbtn");
      if (!tb) return;
      const desc = document.getElementById("issueDesc");
      if (!desc) return;
      const text = desc.innerText.trim();
      if (!text) return;
      window.TTS.start({ text, btn: tb });
    });
  }

  async function sendComment(action) {
    const body = composerInput.value.trim();
    const wantsToggle = action === "close" || action === "reopen";
    if (!body && !wantsToggle) return;
    const btn = action ? composerClose : composerSubmit;
    const orig = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = action ? "处理中…" : "发送中…"; }
    try {
      const extra = action === "close" ? { close: true } : action === "reopen" ? { reopen: true } : {};
      const data = await fetch(
        `/api/${state.owner}/${state.repo}/issues/${state.number}/comment`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, ...extra }) }
      ).then((r) => r.json());
      if (data.error) throw new Error(data.error);
      if (data.closed || data.reopened) { composerInput.value = ""; window.location.reload(); return; }
      const c = data.comment;
      if (c && !state.seenIds.has(c.id)) {
        state.seenIds.add(c.id);
        state.newIds.add(c.id);
        state.items.unshift(c);
      }
      if (c) state.sinceISO = c.created_at;
      composerInput.value = "";
      window.scrollTo(0, 0);
      render(false);
    } catch (e) {
      alert("发送失败: " + (e && e.message ? e.message : e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  function insertAtCursor(el, text) {
    const s = el.selectionStart != null ? el.selectionStart : el.value.length;
    const e = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.selectionStart = el.selectionEnd = s + text.length;
    el.focus();
  }

  async function uploadFiles(files) {
    for (const f of files) {
      composerSubmit.disabled = true;
      composerSubmit.textContent = "上传中…";
      try {
        const fd = new FormData();
        fd.set("attachment", f);
        fd.set("name", f.name);
        const data = await fetch(
          `/api/${state.owner}/${state.repo}/issues/${state.number}/upload`,
          { method: "POST", body: fd }
        ).then((r) => r.json());
        if (data.error) throw new Error(data.error);
        if (data.markdown) insertAtCursor(composerInput, (composerInput.value ? "\n" : "") + data.markdown);
      } catch (e) {
        alert("上传失败: " + (e && e.message ? e.message : e));
      } finally {
        composerSubmit.disabled = false;
        composerSubmit.textContent = "发送";
      }
    }
  }

  if (composerFile) {
    composerFile.addEventListener("change", () => {
      if (composerFile.files && composerFile.files.length) uploadFiles([...composerFile.files]);
      composerFile.value = "";
    });
  }
  if (composerInput) {
    composerInput.addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const it of items) if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
      if (files.length) { e.preventDefault(); uploadFiles(files); }
    });
    // beforeunload: if there's unsent text, ask the browser to confirm refresh/close/navigate
    // away (same guard native Gitea uses) so an accidental refresh doesn't lose a drafted comment.
    window.addEventListener("beforeunload", (e) => {
      if (composerInput.value.trim()) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  if (composer) {
    composer.addEventListener("submit", (e) => {
      e.preventDefault();
      sendComment();
    });
    composerInput.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        sendComment();
      }
    });
    if (composerClose) {
      const closeLabel = composerClose.textContent;
      let closeArmed = false;
      let closeArmTimer = null;
      const disarmClose = () => {
        closeArmed = false;
        clearTimeout(closeArmTimer);
        composerClose.textContent = closeLabel;
        composerClose.classList.remove("armed");
      };
      composerClose.addEventListener("click", () => {
        const action = composerClose.dataset.action || "close";
        if (action === "close" && !closeArmed) {
          closeArmed = true;
          composerClose.textContent = "⚠ 再次点击确认关闭";
          composerClose.classList.add("armed");
          clearTimeout(closeArmTimer);
          closeArmTimer = setTimeout(disarmClose, 4000);
          return;
        }
        disarmClose();
        sendComment(action);
      });
    }
  }

  if (descToggle && issueDesc) {
    descToggle.addEventListener("click", () => {
      const collapsed = issueDesc.classList.toggle("collapsed");
      descToggle.textContent = collapsed ? "显示详情 ▾" : "收起 ▴";
    });
  }

  let pollTimer = null;
  async function poll() {
    try {
      const data = await api("since", { since: state.sinceISO });
      if (!data || data.error) return;
      const views = data.comments || [];
      if (!views.length) return;
      mergeFront(views, true);
      state.sinceISO = views[views.length - 1].created_at;
      render(true);
    } catch (_) {}
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearInterval(pollTimer);
        pollTimer = null;
      } else {
        poll();
        startPoll();
      }
    });
  }

  let scrollTick = false;
  window.addEventListener("scroll", () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      refreshToLatest();
      scrollTick = false;
    });
  }, { passive: true });

  setInterval(() => {
    if (hasTextSelection()) return;
    document.querySelectorAll(".when[data-ts]").forEach((el) => {
      el.firstChild && (el.textContent = relTime(el.getAttribute("data-ts")));
    });
  }, 30000);

  render(false);
  startPoll();
})();
