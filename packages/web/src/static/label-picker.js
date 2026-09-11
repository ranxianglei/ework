(function () {
  var btn = document.getElementById("labelEditBtn");
  if (!btn) return;
  var dlg = document.getElementById("labelDlg");
  var listEl = document.getElementById("lpList");
  var emptyEl = document.getElementById("lpEmpty");
  if (!dlg || !listEl) return;

  var path = window.location.pathname.replace(/\/+$/, "");
  var m = path.match(/^\/(.+)\/(.+)\/issues\/(\d+)$/);
  if (!m) return;
  var apiBase = "/api/" + encodeURIComponent(m[1]) + "/" + encodeURIComponent(m[2]) + "/issues/" + m[3] + "/labels";

  function scopeOf(name) {
    var i = name.indexOf("/");
    return i > 0 ? name.slice(0, i) : "";
  }

  var state = { available: [], current: [] };

  function render() {
    if (!state.available.length) {
      listEl.classList.add("hidden");
      emptyEl.classList.remove("hidden");
      return;
    }
    listEl.classList.remove("hidden");
    emptyEl.classList.add("hidden");
    var currentIds = new Set(state.current.map(function (l) { return l.id; }));
    listEl.innerHTML = state.available.map(function (l) {
      var checked = currentIds.has(l.id);
      var sc = scopeOf(l.name);
      var scopeHint = l.exclusive === 1 && sc ? '<span class="lp-scope">互斥 · ' + esc(sc) + "</span>" : "";
      return '<label class="lp-item">' +
        '<input type="checkbox" data-id="' + l.id + '"' + (l.exclusive === 1 ? ' data-exclusive="1"' : "") +
        (sc ? ' data-scope="' + esc(sc) + '"' : "") +
        (checked ? " checked" : "") + ">" +
        '<span class="lp-dot" style="background:' + esc(l.color) + '"></span>' +
        '<span class="lp-name">' + esc(l.name) + "</span>" + scopeHint +
        "</label>";
    }).join("");
  }

  function renderChips() {
    var row = document.querySelector(".meta-status");
    if (!row) return;
    var existing = row.querySelectorAll(".issue-label");
    existing.forEach(function (e) { e.remove(); });
    var badge = row.querySelector(".state-badge");
    var html = state.current.map(function (l) {
      return '<span class="issue-label" style="border-color:' + esc(l.color) + ";color:" + esc(l.color) + '">' + esc(l.name) + "</span>";
    }).join("");
    badge.insertAdjacentHTML("afterend", html);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function load() {
    try {
      var res = await fetch(apiBase);
      if (!res.ok) return;
      var data = await res.json();
      state.available = data.available || [];
      state.current = data.current || [];
      render();
    } catch (e) {}
  }

  async function save(labelIds) {
    try {
      var res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelIds: labelIds }),
      });
      if (!res.ok) return;
      var data = await res.json();
      state.current = data.current || [];
      renderChips();
    } catch (e) {}
  }

  btn.addEventListener("click", async function () {
    await load();
    dlg.showModal();
  });

  listEl.addEventListener("change", function (e) {
    var cb = e.target;
    if (cb.tagName !== "INPUT" || cb.type !== "checkbox") return;
    if (cb.checked && cb.dataset.exclusive === "1" && cb.dataset.scope) {
      var scope = cb.dataset.scope;
      listEl.querySelectorAll('input[data-exclusive="1"]').forEach(function (other) {
        if (other !== cb && other.dataset.scope === scope) other.checked = false;
      });
    }
    var ids = Array.from(listEl.querySelectorAll("input:checked")).map(function (c) {
      return Number(c.dataset.id);
    });
    save(ids);
  });
})();
