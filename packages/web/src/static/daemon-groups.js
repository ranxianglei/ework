(async function() {
  const tbody = document.getElementById("groups-tbody");
  const bindingsList = document.getElementById("bindings-list");
  const strategySelect = document.getElementById("strategy-select");
  const result = document.getElementById("strategy-result");
  const saveBtn = document.getElementById("strategy-save");
  const addBindingBtn = document.getElementById("binding-add");

  let currentStrategy = { strategy: "least-loaded", groupBindings: {}, daemonGroups: {} };

  function showResult(msg, ok) {
    result.textContent = msg;
    result.className = "db-result " + (ok ? "db-ok" : "db-err");
    setTimeout(() => { result.textContent = ""; result.className = "db-result"; }, 3000);
  }

  async function load() {
    try {
      const [daemonsRes, strategyRes] = await Promise.all([
        fetch("/api/router/daemons").then(r => r.json()),
        fetch("/api/router/strategy").then(r => r.json()),
      ]);
      const daemons = daemonsRes.daemons || [];
      currentStrategy = strategyRes;
      strategySelect.value = currentStrategy.strategy || "least-loaded";

      tbody.innerHTML = daemons.map(d => {
        const groups = (currentStrategy.daemonGroups || {})[d.id] || [];
        return `<tr>
          <td>${d.id}</td>
          <td>${d.displayName || "?"}<br><span style="font-size:11px;color:var(--text-muted)">${d.endpoint}</span></td>
          <td><span class="pill ${d.status}">${d.status}</span></td>
          <td><input type="text" data-daemon-id="${d.id}" value="${groups.join(", ")}" placeholder="group-a, group-b" style="width:100%;padding:.25rem .4rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:12px"></td>
        </tr>`;
      }).join("") || '<tr><td colspan="4" class="daemon-empty">没有已注册的 daemon（节点启动后自动出现）</td></tr>';

      renderBindings();
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="4" class="daemon-empty">无法连接 router — 确认 router 已启动</td></tr>';
    }
  }

  function renderBindings() {
    const bindings = currentStrategy.groupBindings || {};
    const keys = Object.keys(bindings);
    bindingsList.innerHTML = keys.length === 0
      ? '<p class="hint" style="margin:0 0 .5rem">暂无绑定</p>'
      : keys.map(k => `<div style="display:flex;align-items:center;gap:.5rem;margin:.3rem 0;font-size:13px">
          <code>${k}</code> → <span style="color:var(--accent)">${bindings[k]}</span>
          <button type="button" class="secondary" data-binding-key="${k}" style="padding:.2rem .5rem;font-size:11px">删除</button>
        </div>`).join("");

    bindingsList.querySelectorAll("button[data-binding-key]").forEach(btn => {
      btn.onclick = () => {
        delete currentStrategy.groupBindings[btn.dataset.bindingKey];
        renderBindings();
      };
    });
  }

  addBindingBtn.onclick = () => {
    const repo = document.getElementById("binding-repo").value.trim();
    const group = document.getElementById("binding-group").value.trim();
    if (!repo || !group) return;
    if (!currentStrategy.groupBindings) currentStrategy.groupBindings = {};
    currentStrategy.groupBindings[repo] = group;
    document.getElementById("binding-repo").value = "";
    document.getElementById("binding-group").value = "";
    renderBindings();
  };

  saveBtn.onclick = async () => {
    currentStrategy.strategy = strategySelect.value;
    const newGroups = {};
    tbody.querySelectorAll("input[data-daemon-id]").forEach(input => {
      const id = parseInt(input.dataset.daemonId, 10);
      const groups = input.value.split(",").map(s => s.trim()).filter(Boolean);
      if (groups.length > 0) newGroups[id] = groups;
    });
    currentStrategy.daemonGroups = newGroups;

    try {
      const res = await fetch("/api/router/strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentStrategy),
      });
      const data = await res.json();
      if (res.ok) {
        showResult("✓ 策略已保存", true);
      } else {
        showResult("✗ " + (data.error || "保存失败"), false);
      }
    } catch (e) {
      showResult("✗ " + e.message, false);
    }
  };

  load();
})();
