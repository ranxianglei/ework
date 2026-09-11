// Session follow mode: poll /api/sessions/:id/since for server-rendered new
// messages and append them. Server returns rendered HTML (see renderNewMessages),
// so this stays ~50 lines with no duplicated render logic. Mirrors the issue
// thread's ?since polling pattern.
(() => {
  const dataEl = document.getElementById("session-data");
  if (!dataEl) return;
  let meta;
  try { meta = JSON.parse(dataEl.textContent || "{}"); } catch { return; }
  const sid = meta.id;
  if (!sid) return;

  const btn = document.getElementById("followBtn");
  const list = document.getElementById("mlist");
  if (!btn || !list) return;

  let last = typeof meta.lastCreated === "number" ? meta.lastCreated : 0;
  let desc = meta.desc === true;
  const seen = new Set();
  let timer = null;
  const INTERVAL = 4000;

  // Track the last text selection per message root: clicking 🔊 clears the live
  // selection, so we remember the selection's Range and use it when the button fires.
  let ttsSelRoot = null;
  let ttsSelRange = null;
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const n = r.startContainer;
    const el = n.nodeType === 3 ? n.parentElement : n;
    const mb = el && el.closest ? el.closest(".mb") : null;
    if (mb) { ttsSelRoot = mb; ttsSelRange = r.cloneRange(); }
  });

  function setBtn(label) { btn.textContent = label; }

  function flashNew(n) {
    btn.classList.add("flash");
    setBtn(`✨ +${n}`);
    setTimeout(() => { btn.classList.remove("flash"); setBtn(timer ? "⏸ Stop" : "🔄 Follow"); }, 1500);
  }

  // Skip the poll while the user is mid-selection: inserting HTML cancels it.
  // Safe — `last` stays, so the next poll fetches everything since (no loss).
  function hasTextSelection() {
    const s = window.getSelection();
    return !!s && !s.isCollapsed && s.toString().length > 0;
  }

  async function poll() {
    if (hasTextSelection() || (window.TTS && window.TTS.isActive())) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/since?since=${last}`, { headers: { "accept": "application/json" } });
      if (!res.ok) return;
      const body = await res.json();
      if (!body || !Array.isArray(body.items)) return;
      const pos = desc ? "afterbegin" : "beforeend";
      let got = 0;
      for (const it of body.items) {
        if (!it || !it.html || seen.has(it.id)) continue;
        seen.add(it.id);
        list.insertAdjacentHTML(pos, it.html);
        if (typeof it.created === "number" && it.created > last) last = it.created;
        got++;
      }
      if (got > 0) flashNew(got);
    } catch { /* transient; next tick retries */ }
  }

  function start() {
    btn.classList.add("on");
    setBtn("⏸ Stop");
    poll();
    timer = setInterval(poll, INTERVAL);
  }
  function stop() {
    btn.classList.remove("on");
    setBtn("🔄 Follow");
    if (timer) { clearInterval(timer); timer = null; }
  }

  btn.addEventListener("click", () => { timer ? stop() : start(); });

  // Auto-follow on by default; ?follow=0 opts out.
  const params = new URLSearchParams(location.search);
  if (params.get("follow") !== "0") start();

  const cbtn = document.getElementById("collapseBtn");
  if (cbtn) {
    let collapsed = true;
    cbtn.addEventListener("click", () => {
      collapsed = !collapsed;
      document.querySelectorAll("#mlist details").forEach((d) => {
        d.open = !collapsed;
      });
      cbtn.textContent = collapsed ? "📂 展开全部" : "📂 折叠全部";
    });
  }

  // Incremental "load more": fetch next batch and insert without full reload.
  const loadBtn = document.getElementById("loadMoreBtn");
  const moreBar = document.getElementById("moreBar");
  if (loadBtn && moreBar) {
    loadBtn.addEventListener("click", async () => {
      const offset = Number(loadBtn.dataset.offset) || 30;
      loadBtn.disabled = true;
      const oldText = loadBtn.textContent;
      loadBtn.textContent = "加载中…";
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(meta.id)}/batch?offset=${offset}&limit=30&asc=${desc ? 0 : 1}`);
        if (!res.ok) throw new Error("http " + res.status);
        const batch = await res.json();
        // Insert: desc (newest-first) → older msgs go at the BOTTOM (before moreBar);
        // asc → older msgs go at the TOP (after #top anchor), with scroll anchoring.
        if (desc) {
          moreBar.insertAdjacentHTML("beforebegin", batch.html);
        } else {
          const beforeH = document.documentElement.scrollHeight;
          const beforeY = window.scrollY;
          const topAnchor = list.querySelector("#top");
          if (topAnchor) topAnchor.insertAdjacentHTML("afterend", batch.html);
          else list.insertAdjacentHTML("afterbegin", batch.html);
          window.scrollTo(0, beforeY + (document.documentElement.scrollHeight - beforeH));
        }
        const shown = offset + 30;
        loadBtn.dataset.offset = String(shown);
        if (batch.hasMore) {
          loadBtn.disabled = false;
          loadBtn.textContent = oldText;
          const total = batch.total;
          moreBar.firstChild && (moreBar.childNodes[0].nodeValue = `共 ${total} 条，当前显示最新 ${shown} 条 · `);
        } else {
          moreBar.remove();
        }
      } catch (e) {
        loadBtn.disabled = false;
        loadBtn.textContent = oldText;
      }
    });
  }


  // Copy visible message text to clipboard, with fallback for non-secure (HTTP) contexts.
  // Resolve the content root for an action button: .mb inside a .msg, or .acp-sum inside
  // a compression marker — so copy/tts/translate work on both regular messages and blocks.
  function contentRoot(btn) {
    const msg = btn.closest(".msg");
    if (msg) return msg.querySelector(".mb") || null;
    const mark = btn.closest(".acp-mark");
    if (mark) return mark.querySelector(".acp-sum") || null;
    return null;
  }
  list.addEventListener("click", (e) => {
    const cb = e.target.closest(".cbtn");
    if (!cb) return;
    const mb = contentRoot(cb);
    if (!mb) return;
    let text;
    const mds = [];
    for (const p of mb.querySelectorAll("[data-md]")) { if (p.dataset.md) mds.push(p.dataset.md); }
    text = mds.length ? mds.join("\n\n") : mb.innerText;
    const done = () => { cb.textContent = "✅"; cb.classList.add("done"); setTimeout(() => { cb.textContent = "📋"; cb.classList.remove("done"); }, 1500); };
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      if (ok) done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else { fallback(); }
  });

  // Per-message link copy: copy /sessions/:id#m<msgid> so the floor can be shared.
  list.addEventListener("click", (e) => {
    const lb = e.target.closest(".linkbtn");
    if (!lb) return;
    const msgEl = lb.closest(".msg");
    if (!msgEl || !msgEl.id) return;
    const url = location.origin + location.pathname + "#" + msgEl.id;
    const done = () => { lb.textContent = "✅"; lb.classList.add("done"); setTimeout(() => { lb.textContent = "🔗"; lb.classList.remove("done"); }, 1500); };
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      if (ok) done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(fallback);
    } else { fallback(); }
  });

  list.addEventListener("click", (e) => {
    if (e.target.closest(".ttsstop")) { e.stopPropagation(); if (window.TTS) window.TTS.stop(); return; }
    const tb = e.target.closest(".ttsbtn");
    if (!tb) return;
    const mb = contentRoot(tb);
    if (!mb) return;
    let text = "";
    if (ttsSelRoot === mb && ttsSelRange) {
      const r = ttsSelRange.cloneRange();
      try { r.setEnd(mb, mb.childNodes.length); } catch (e2) {}
      text = r.toString().trim();
    }
    if (!text) text = mb.innerText.trim();
    if (!text) return;
    window.TTS.start({ text, btn: tb });
  });

  // Per-part copy: copy just this reasoning/tool block's own text (button excluded).
  list.addEventListener("click", (e) => {
    const pb = e.target.closest(".pcbtn");
    if (!pb) return;
    e.preventDefault();
    const io = pb.closest(".tool-io") || pb.closest("details")?.querySelector(".tool-io");
    if (!io) return;
    const clone = io.cloneNode(true);
    clone.querySelectorAll(".pcbtn").forEach((b) => b.remove());
    const text = io.dataset.md !== undefined ? io.dataset.md : clone.innerText;
    const done = () => { pb.textContent = "✅"; pb.classList.add("done"); setTimeout(() => { pb.textContent = "📋"; pb.classList.remove("done"); }, 1500); };
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      if (ok) done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else { fallback(); }
  });

  // Translate per-part in place: text divs + reasoning bodies; tools and
  // summary bars are skipped (never sent).
  const partCache = new WeakMap();
  const partShow = new WeakMap();
  const msgTr = new WeakMap();
  let trActive = 0;
  const trRunning = new WeakMap();
  const partsOf = (mb) => {
    const out = [];
    mb.querySelectorAll(":scope > details.reasoning[open] > .tool-io").forEach((d) => out.push(d));
    mb.querySelectorAll(":scope > div").forEach((d) => out.push(d));
    return out;
  };
  // Live streaming mini-markdown: escape first, then render lists/bold/code so
  // miniMd: streaming-state renderer (the final {h} full marked render still
  // swaps in at stream end). Handles headings, fenced code, lists, bold, inline
  // code — enough that the streaming phase looks close to the final render.
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const applyPart = (p) => { const c = partCache.get(p); if (c) p.innerHTML = partShow.get(p) ? c.tr : c.orig; };
  list.addEventListener("click", async (e) => {
    const tb = e.target.closest(".tbtn");
    if (!tb) return;
    const mb = contentRoot(tb);
    if (!mb) return;
    if (trRunning.has(tb)) { trRunning.get(tb).abort(); return; }
    const parts = partsOf(mb).filter((p) => p.textContent.trim());
    if (parts.length === 0) return;
    if (parts.every((p) => partCache.has(p))) {
      const next = !msgTr.get(mb);
      for (const p of parts) { partShow.set(p, next); applyPart(p); }
      msgTr.set(mb, next);
      tb.textContent = next ? "原文" : "翻译";
      return;
    }
    const ac = new AbortController();
    trRunning.set(tb, ac);
    trActive++;
    tb.textContent = "⏹ 停止";
    let allDone = true;
    try {
      for (const p of parts) {
        if (ac.signal.aborted) { allDone = false; break; }
        if (partCache.has(p)) continue;
        const orig = p.innerHTML;
        const text = p.dataset.md || p.textContent.trim();
        p.innerHTML = `<div class="tr-prog"></div>`;
        const prog = p.querySelector(".tr-prog");
        let html = null;
        try {
          const res = await fetch("/api/translate/stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
            signal: ac.signal,
          });
          if (!res.ok || !res.body) throw new Error("http " + res.status);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "", full = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              const s = line.trim();
              if (!s) continue;
              let obj; try { obj = JSON.parse(s); } catch { continue; }
              if (obj.d) { full += obj.d; prog.innerHTML = miniMd(full); }
              else if (obj.h) { html = obj.h; }
              else if (obj.e) { throw new Error(obj.e); }
            }
          }
          if (buf.trim()) { try { const o = JSON.parse(buf.trim()); if (o && o.h) html = o.h; } catch {} }
          if (html) { partCache.set(p, { orig, tr: html }); partShow.set(p, true); p.innerHTML = html; }
          else if (full.trim()) { const md = miniMd(full); partCache.set(p, { orig, tr: md }); partShow.set(p, true); p.innerHTML = md; }
          else { partCache.set(p, { orig, tr: orig }); partShow.set(p, true); p.innerHTML = orig; }
        } catch (err) {
          p.innerHTML = orig;
          if (err.name === "AbortError") { allDone = false; break; }
        }
      }
      msgTr.set(mb, allDone);
    } finally {
      trRunning.delete(tb);
      trActive--;
      tb.textContent = allDone ? "原文" : "翻译";
    }
  });

  // DESC (newest top) → scroll up; ASC → scroll down only if already near bottom.
  const mo = new MutationObserver(() => {
    if (!timer) return;
    if (trActive > 0) return;
    if (desc) {
      if (window.scrollY < 200) window.scrollTo({ top: 0, behavior: "smooth" });
    } else if ((window.innerHeight + window.scrollY) > (document.body.scrollHeight - 200)) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }
  });
  mo.observe(list, { childList: true });
})();
