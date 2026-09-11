// TTS playback: plays one GET /api/tts/stream/:id URL via a native <audio>. An engine
// picker (<select id="tts-be">) injected into the nav switches backends (kokoro /
// cosyvoice3 …); the choice persists in localStorage.
(function () {
  let audio = null;
  let state = "idle";
  let activeBtn = null;
  let backends = null;

  function setBtn(btn, s) {
    if (!btn) return;
    btn.classList.toggle("playing", s === "playing" || s === "fetching");
    btn.textContent = s === "playing" ? "⏸" : s === "fetching" ? "⏳" : s === "paused" ? "▶️" : "🔊";
  }
  function setState(s) { state = s; setBtn(activeBtn, s); }

  function stop() {
    if (audio) {
      audio.onended = null; audio.onerror = null;
      audio.pause(); audio.src = "";
      audio = null;
    }
    setState("idle");
    activeBtn = null;
  }

  function selectedBackend() {
    const sel = document.getElementById("tts-be");
    if (sel && sel.value) return sel.value;
    return backends && backends.length ? backends[0].id : "";
  }

  // Inject one engine <select> into the nav, populated from /api/tts/backends. Hidden
  // when there's only one backend (nothing to choose). Persists the choice per-browser.
  function ensurePicker() {
    if (!backends || backends.length === 0) return;
    if (document.getElementById("tts-be")) return;
    const nav = document.querySelector(".nav");
    if (!nav) return;
    const sel = document.createElement("select");
    sel.id = "tts-be";
    sel.title = "朗读引擎";
    sel.className = "tts-be";
    sel.style.cssText = "margin-left:auto;font:inherit;font-size:12px;padding:.2rem .3rem;border:1px solid rgba(255,255,255,.3);border-radius:5px;background:rgba(255,255,255,.1);color:inherit;cursor:pointer";
    for (const b of backends) {
      const o = document.createElement("option");
      o.value = b.id; o.textContent = b.label;
      sel.appendChild(o);
    }
    const saved = localStorage.getItem("tts-backend");
    if (saved && backends.some((b) => b.id === saved)) sel.value = saved;
    sel.addEventListener("change", () => localStorage.setItem("tts-backend", sel.value));
    nav.appendChild(sel);
  }

  async function loadBackends() {
    if (backends) return;
    try {
      const r = await fetch("/api/tts/backends");
      if (r.ok) backends = await r.json();
    } catch { /* picker just won't render; 🔇 still uses the default backend */ }
    if (backends && backends.length > 1) ensurePicker();
  }

  async function start(opts) {
    if (activeBtn === opts.btn && audio) {
      if (audio.paused) audio.play().then(() => setState("playing")).catch(() => {});
      else { audio.pause(); setState("paused"); }
      return;
    }
    if (activeBtn) stop();
    const text = (opts.text || "").replace(/\r/g, "").trim();
    if (!text) return;
    activeBtn = opts.btn;
    setState("fetching");
    // Create the element in the click gesture so mobile autoplay policy unlocks it.
    audio = new Audio();
    let id;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, backend: selectedBackend() }),
      });
      if (!res.ok) { stop(); return; }
      id = (await res.json()).id;
    } catch (e) { stop(); return; }
    if (!id || !audio || state === "idle") return;
    audio.src = "/api/tts/stream/" + encodeURIComponent(id);
    audio.onended = () => stop();
    audio.onerror = () => stop();
    audio.play().then(() => { if (state !== "idle") setState("playing"); }).catch(() => stop());
  }

  function isActive() { return state !== "idle"; }

  window.TTS = { start, stop, isActive };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadBackends);
  else loadBackends();
})();
