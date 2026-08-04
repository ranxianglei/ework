// Universal delegated click handler for issue action buttons.
// Buttons use data-* attributes so no inline JS is needed (CSP-safe).
// Supported attributes:
//   data-action-href="/owner/repo/issues/N/halt"  — POST target
//   data-action-method="POST"                      — default POST
//   data-action-confirm="确认停止？"               — if set, confirm() first
//   data-action-reload="true"                      — default true, reload on success
(function () {
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action-href]");
    if (!btn) return;
    e.preventDefault();
    var href = btn.getAttribute("data-action-href");
    var method = btn.getAttribute("data-action-method") || "POST";
    var confirmMsg = btn.getAttribute("data-action-confirm");
    var reload = btn.getAttribute("data-action-reload") !== "false";
    if (confirmMsg && !confirm(confirmMsg)) return;
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳ …";
    fetch(href, { method: method })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          if (reload) location.reload();
        } else {
          alert(d.error || "操作失败");
          btn.disabled = false;
          btn.textContent = orig;
        }
      })
      .catch(function (err) {
        alert("网络错误: " + err);
        btn.disabled = false;
        btn.textContent = orig;
      });
  });
})();
