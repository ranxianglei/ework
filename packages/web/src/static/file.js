(() => {
  "use strict";
  const btn = document.getElementById("followBtn");
  const dataEl = document.getElementById("file-data");
  const code = document.querySelector("pre code");
  if (!btn || !dataEl || !code) return;

  let meta;
  try { meta = JSON.parse(dataEl.textContent || "{}"); } catch { return; }
  if (!meta.path) return;

  let polling = false;
  let timer = null;
  const POLL_MS = 3000;
  const MAX_ROWS = 3000;

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rowHTML = (n, t) => `<span class="ln"><span class="lnn">${n}</span><span class="lnc">${esc(t)}</span></span>`;

  function nearBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 80; }
  // Skip while mid-selection: inserting rows cancels it; meta.size stays (no loss).
  function hasTextSelection() {
    const s = window.getSelection();
    return !!s && !s.isCollapsed && s.toString().length > 0;
  }

  function flashNew(n) {
    const orig = btn.textContent;
    btn.textContent = `✨ +${n}`;
    btn.classList.add("flash");
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("flash"); }, 1500);
  }

  function trimRows() {
    const rows = code.querySelectorAll("span.ln");
    if (rows.length <= MAX_ROWS) return;
    const drop = rows.length - MAX_ROWS;
    if (meta.order === "desc") {
      for (let i = rows.length - 1; i >= rows.length - drop; i--) rows[i]?.remove();
    } else {
      for (let i = 0; i < drop; i++) rows[i]?.remove();
    }
  }

  async function poll() {
    if (hasTextSelection()) return;
    try {
      const url = `/api/file/since?path=${encodeURIComponent(meta.path)}&after=${meta.size}`;
      const r = await fetch(url, { headers: { "accept": "application/json" } });
      if (!r.ok) return;
      const d = await r.json();
      if (!d || typeof d !== "object") return;
      if (d.rotated) { window.location.reload(); return; }
      if (!Array.isArray(d.rows) || d.rows.length === 0) return;
      const prevScroll = window.scrollY;
      const prevH = document.body.scrollHeight;
      const wasAtBottom = nearBottom();
      let count = 0;
      for (const row of d.rows) {
        meta.maxN = (meta.maxN || 0) + 1;
        const html = rowHTML(meta.maxN, String(row.t ?? ""));
        code.insertAdjacentHTML(meta.order === "desc" ? "afterbegin" : "beforeend", html);
        count++;
      }
      const addedTopH = document.body.scrollHeight - prevH;
      meta.size = d.size ?? meta.size;
      trimRows();
      flashNew(count);
      // desc: prepended rows shift content down — compensate so the view stays put; pin
      // to top only if already there. asc: appended below, follow only if at bottom.
      if (meta.order === "desc") {
        if (prevScroll <= 5) window.scrollTo(0, 0);
        else window.scrollTo(0, prevScroll + addedTopH);
      } else if (wasAtBottom) {
        window.scrollTo(0, document.body.scrollHeight);
      }
    } catch (e) {
      console.warn("file follow poll failed:", e);
    }
  }

  function start() {
    if (polling) return;
    polling = true;
    btn.textContent = "⏸ Stop";
    btn.classList.add("on");
    poll();
    timer = setInterval(poll, POLL_MS);
  }

  function stop() {
    if (!polling) return;
    polling = false;
    btn.textContent = "🔄 Follow";
    btn.classList.remove("on");
    if (timer) { clearInterval(timer); timer = null; }
  }

  btn.addEventListener("click", () => { polling ? stop() : start(); });

  const params = new URLSearchParams(location.search);
  if (meta.isLog && params.get("follow") !== "0") start();
})();
