// Universal delegated click handler for issue action buttons.
// Buttons use data-* attributes so no inline JS is needed (CSP-safe).
// Supported attributes:
//   data-action-href="/owner/repo/issues/N/halt"  — POST target
//   data-action-method="POST"                      — default POST
//   data-action-confirm="确认停止？"               — if set, confirm() first
//   data-action-reload="true"                      — default true, reload on success
(function () {
  var BADGES = {
    "processing": ["ai-processing", "🔄 AI 处理中"],
    "completed": ["ai-completed", "✅ AI 已完成"],
    "failed": ["ai-failed", "⚠️ AI 失败"],
    "halted": ["ai-halted", "⏹ 已停止"],
    "dispatch_off": ["ai-dispatch-off", "🔕 不接单中"]
  };

  function issuePath() {
    var m = location.pathname.match(/^(\/[^/]+\/[^/]+\/issues\/\d+)/);
    return m ? m[1] : null;
  }

  function refreshBadge() {
    var p = issuePath();
    var badge = document.getElementById("aiStatusBadge");
    if (!p || !badge) return;
    fetch(p + "/ai-status", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        var b = BADGES[d.aiStatus] || ["ai-idle", "💤 空闲"];
        badge.textContent = b[1];
        badge.className = "ai-badge " + b[0];
        var stopBtn = document.getElementById("aiStopBtn");
        if (stopBtn) stopBtn.style.display = d.aiStatus === "processing" ? "" : "none";
        var initial = Number(badge.getAttribute("data-comment-count") || 0);
        if (d.commentCount > initial) {
          var bar = document.getElementById("newReplyBar");
          if (!bar) {
            bar = document.createElement("div");
            bar.id = "newReplyBar";
            bar.style.cssText = "margin:.6rem 0;padding:.5rem .8rem;border-radius:8px;background:#ddf4ff;border:1px solid #54aeff;color:#0969da;cursor:pointer";
            bar.textContent = "💬 有新回复 · 点击刷新查看";
            bar.onclick = function () { location.reload(); };
            badge.parentNode.insertBefore(bar, badge.nextSibling);
          }
        }
      })
      .catch(function () {});
  }

  if (document.getElementById("aiStatusBadge")) {
    setInterval(refreshBadge, 8000);
  }

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

  function saveModel(saveBtn) {
    var sel = document.getElementById("issueModelSelect");
    if (!sel || !saveBtn) return;
    var m = sel.value;
    saveBtn.disabled = true;
    var path = location.pathname.split("/").slice(0, 5).join("/");
    fetch(path + "/model", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "model=" + encodeURIComponent(m)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        saveBtn.disabled = false;
        if (d.ok) { saveBtn.textContent = "✓"; setTimeout(function () { saveBtn.textContent = "💾"; }, 1200); }
        else alert(d.error || "保存失败");
      })
      .catch(function (err) {
        saveBtn.disabled = false;
        alert("网络错误: " + err);
      });
  }

  document.addEventListener("click", function (e) {
    var saveBtn = e.target.closest("#issueModelSave");
    if (!saveBtn) return;
    e.preventDefault();
    saveModel(saveBtn);
  });

  document.addEventListener("change", function (e) {
    if (e.target && e.target.id === "issueModelSelect") saveModel(document.getElementById("issueModelSave"));
  });

  function saveRuntime(saveBtn) {
    var sel = document.getElementById("issueRuntimeSelect");
    if (!sel || !saveBtn) return;
    saveBtn.disabled = true;
    var path = location.pathname.split("/").slice(0, 5).join("/");
    fetch(path + "/runtime", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "runtime=" + encodeURIComponent(sel.value)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        saveBtn.disabled = false;
        if (d.ok) { saveBtn.textContent = "✓"; setTimeout(function () { saveBtn.textContent = "💾"; }, 1200); }
        else alert(d.error || "保存失败");
      })
      .catch(function (err) {
        saveBtn.disabled = false;
        alert("网络错误: " + err);
      });
  }

  document.addEventListener("click", function (e) {
    var saveBtn = e.target.closest("#issueRuntimeSave");
    if (!saveBtn) return;
    e.preventDefault();
    saveRuntime(saveBtn);
  });

  document.addEventListener("change", function (e) {
    if (e.target && e.target.id === "issueRuntimeSelect") saveRuntime(document.getElementById("issueRuntimeSave"));
  });
})();
