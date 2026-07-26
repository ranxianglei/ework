// Daemon cluster manager (settings page). External file because CSP
// script-src 'self' blocks inline scripts — see index.ts SEC_HEADERS.
(function () {
  "use strict";
  var listEl = document.getElementById('daemon-list');
  if (!listEl) return;
  var resultEl = document.getElementById('daemon-result');
  var addBtn = document.getElementById('daemon-add');
  var portInput = document.getElementById('daemon-port');
  var deployBtn = document.getElementById('daemon-deploy');
  var deployResultEl = document.getElementById('deploy-result');
  var refreshTimer = null;
  var inFlight = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(s) {
    if (!s) return '—';
    var t = Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
    if (Number.isNaN(t)) return esc(s);
    var d = new Date(t);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return esc(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()));
  }

  function statusPill(status) {
    var raw = String(status || 'unknown').toLowerCase();
    var cls = raw === 'active' ? 'active' : raw === 'drained' ? 'drained' : (raw === 'dead' ? 'dead' : 'unknown');
    return '<span class="pill ' + cls + '">' + esc(raw) + '</span>';
  }

  function isLocalhostEndpoint(endpoint) {
    var host = String(endpoint || '').replace(/^https?:\/\//, '').split(':')[0] || '';
    return /^(127\.|localhost$|0\.0\.0\.0$|::1$|\[::1\]$)/.test(host);
  }

  function locationCell(endpoint) {
    if (isLocalhostEndpoint(endpoint)) {
      return '<span class="pill loc-local">本机</span>';
    }
    return '<span class="pill loc-remote">🌐 远程</span>';
  }

  function render(daemons) {
    if (!Array.isArray(daemons) || daemons.length === 0) {
      listEl.innerHTML = '<div class="daemon-empty">暂无 daemon 注册。可在下方启动新实例。</div>';
      return;
    }
    var rows = daemons.map(function (d) {
      var stopBtn = String(d.status || '').toLowerCase() === 'active'
        ? '<button type="button" class="stop" data-id="' + d.id + '">停止</button>'
        : '';
      return '<tr>' +
        '<td class="cap">' + d.id + '</td>' +
        '<td class="loc">' + locationCell(d.endpoint) + '</td>' +
        '<td class="endpoint">' + esc(d.endpoint || '') + '</td>' +
        '<td class="cap">' + esc(d.capacity != null ? d.capacity : '') + '</td>' +
        '<td class="heartbeat">' + fmtTime(d.lastHeartbeat) + '</td>' +
        '<td class="registered">' + fmtTime(d.registeredAt) + '</td>' +
        '<td>' + statusPill(d.status) + '</td>' +
        '<td>' + stopBtn + '</td>' +
        '</tr>';
    }).join('');
    listEl.innerHTML =
      '<table><thead><tr>' +
      '<th>ID</th><th>位置</th><th>Endpoint</th><th>容量</th><th>心跳</th><th>注册于</th><th>状态</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
    listEl.querySelectorAll('button.stop').forEach(function (b) {
      b.addEventListener('click', function () { stopDaemon(Number(b.getAttribute('data-id'))); });
    });
  }

  function setResult(text, kind) {
    if (!resultEl) return;
    resultEl.className = 'db-result db-' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : 'loading');
    resultEl.textContent = text;
  }

  async function loadDaemons() {
    if (inFlight) return;
    inFlight = true;
    try {
      var res = await fetch('/api/daemons', { headers: { 'Accept': 'application/json' } });
      if (!res.ok) {
        var errBody = await res.json().catch(function () { return { error: 'HTTP ' + res.status }; });
        listEl.innerHTML = '<div class="daemon-empty">加载失败：' + esc(errBody.error || res.status) + '</div>';
        return;
      }
      render(await res.json());
    } catch (e) {
      listEl.innerHTML = '<div class="daemon-empty">加载失败：' + esc(e.message || String(e)) + '</div>';
    } finally {
      inFlight = false;
    }
  }

  async function addDaemon() {
    if (addBtn) addBtn.disabled = true;
    setResult('正在启动 daemon…', 'loading');
    var body = {};
    var portVal = portInput && portInput.value ? Number(portInput.value) : NaN;
    if (portInput && portInput.value.trim() !== '' && Number.isFinite(portVal)) {
      body.port = portVal;
    }
    try {
      var res = await fetch('/api/daemons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await res.json();
      if (data.ok) {
        setResult('✓ daemon 启动成功' + (data.output ? ':\n' + data.output : ''), 'ok');
        if (portInput) portInput.value = '';
        await loadDaemons();
      } else {
        setResult('✗ ' + (data.error || '未知错误'), 'err');
      }
    } catch (e) {
      setResult('✗ ' + (e.message || String(e)), 'err');
    } finally {
      if (addBtn) addBtn.disabled = false;
    }
  }

  async function stopDaemon(id) {
    if (!confirm('确认停止 daemon #' + id + '？\n只会标记为 drained（不再接新任务），需手动 kill 进程。')) return;
    setResult('正在标记 daemon #' + id + ' 为 drained…', 'loading');
    try {
      var res = await fetch('/api/daemons/' + id, { method: 'DELETE' });
      var data = await res.json();
      if (data.ok) {
        setResult('✓ daemon #' + id + ' 已标记为 drained', 'ok');
        await loadDaemons();
      } else {
        setResult('✗ ' + (data.error || '未知错误'), 'err');
      }
    } catch (e) {
      setResult('✗ ' + (e.message || String(e)), 'err');
    }
  }

  function setDeployResult(text, kind) {
    if (!deployResultEl) return;
    deployResultEl.className = 'db-result db-' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : 'loading');
    deployResultEl.textContent = text;
  }

  function val(id) {
    var el = document.getElementById(id);
    return el && el.value != null ? el.value.trim() : '';
  }

  async function deployRemote() {
    if (deployBtn) deployBtn.disabled = true;
    setDeployResult('正在通过 SSH 部署（最长 60s）…', 'loading');
    var body = {
      sshHost: val('deploy-host'),
      sshUser: val('deploy-user'),
      mysqlHost: val('deploy-mysql-host')
    };
    var sshPort = Number(val('deploy-ssh-port'));
    if (Number.isFinite(sshPort) && sshPort > 0) body.sshPort = sshPort;
    var dPort = Number(val('deploy-daemon-port'));
    if (Number.isFinite(dPort) && dPort > 0) body.daemonPort = dPort;
    var keyFile = val('deploy-key');
    if (keyFile) body.sshKeyFile = keyFile;
    if (!body.sshHost || !body.sshUser || !body.mysqlHost) {
      setDeployResult('✗ SSH 主机、SSH 用户、MySQL 主机 必填', 'err');
      if (deployBtn) deployBtn.disabled = false;
      return;
    }
    try {
      var res = await fetch('/api/daemons/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await res.json();
      if (data.ok) {
        setDeployResult('✓ 部署成功' + (data.output ? '\n' + data.output : ''), 'ok');
        await loadDaemons();
      } else {
        setDeployResult('✗ ' + (data.error || '未知错误') + (data.output ? '\n' + data.output : ''), 'err');
      }
    } catch (e) {
      setDeployResult('✗ ' + (e.message || String(e)), 'err');
    } finally {
      if (deployBtn) deployBtn.disabled = false;
    }
  }

  if (addBtn) addBtn.addEventListener('click', addDaemon);
  if (deployBtn) deployBtn.addEventListener('click', deployRemote);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    } else if (!refreshTimer) {
      loadDaemons();
      refreshTimer = setInterval(loadDaemons, 10000);
    }
  });

  loadDaemons();
  refreshTimer = setInterval(loadDaemons, 10000);
})();
