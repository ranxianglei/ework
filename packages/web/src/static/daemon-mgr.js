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
      var stRaw = String(d.status || 'unknown').toLowerCase();
      var actions = '';
      if (stRaw === 'active') {
        actions = '<button type="button" class="stop" data-id="' + d.id + '">停止</button>';
      } else {
        actions = '<button type="button" class="restart" data-id="' + d.id + '">重启</button>' +
          '<button type="button" class="remove" data-id="' + d.id + '">删除</button>';
      }
      return '<tr>' +
        '<td class="cap">' + d.id + '</td>' +
        '<td class="loc">' + locationCell(d.endpoint) + '</td>' +
        '<td class="endpoint">' + esc(d.endpoint || '') + '</td>' +
        '<td class="cap">' + esc(d.capacity != null ? d.capacity : '') + '</td>' +
        '<td class="heartbeat">' + fmtTime(d.lastHeartbeat) + '</td>' +
        '<td class="registered">' + fmtTime(d.registeredAt) + '</td>' +
        '<td>' + statusPill(d.status) + '</td>' +
        '<td>' + actions + '</td>' +
        '</tr>';
    }).join('');
    listEl.innerHTML =
      '<table><thead><tr>' +
      '<th>ID</th><th>位置</th><th>Endpoint</th><th>容量</th><th>心跳</th><th>注册于</th><th>状态</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
    var bindBtn = function (selector, fn) {
      listEl.querySelectorAll(selector).forEach(function (b) {
        b.addEventListener('click', function () { fn(Number(b.getAttribute('data-id'))); });
      });
    };
    bindBtn('button.stop', stopDaemon);
    bindBtn('button.restart', restartDaemon);
    bindBtn('button.remove', removeDaemon);
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

  async function restartDaemon(id) {
    setResult('正在重启 daemon #' + id + '…', 'loading');
    try {
      var res = await fetch('/api/daemons/' + id + '/restart', { method: 'POST' });
      var data = await res.json();
      if (data.ok) {
        setResult('✓ daemon #' + id + ' 已重新激活', 'ok');
        await loadDaemons();
      } else {
        setResult('✗ ' + (data.error || '未知错误'), 'err');
      }
    } catch (e) {
      setResult('✗ ' + (e.message || String(e)), 'err');
    }
  }

  async function removeDaemon(id) {
    if (!confirm('确认删除 daemon #' + id + '？\n这会从数据库永久移除该记录。')) return;
    setResult('正在删除 daemon #' + id + '…', 'loading');
    try {
      var res = await fetch('/api/daemons/' + id + '/remove', { method: 'DELETE' });
      var data = await res.json();
      if (data.ok) {
        setResult('✓ daemon #' + id + ' 已删除', 'ok');
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

  function appendDeployLog(text) {
    if (!deployResultEl) return;
    deployResultEl.className = 'db-result db-loading';
    deployResultEl.textContent += text;
    deployResultEl.scrollTop = deployResultEl.scrollHeight;
  }

  function parseTargets(raw) {
    var targets = [];
    var lines = raw.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      var parts = line.split(':');
      var host = parts[0].trim();
      var port = parts.length > 1 ? parseInt(parts[1].trim(), 10) : NaN;
      if (host) {
        var t = { host: host };
        if (Number.isFinite(port) && port > 0) t.daemonPort = port;
        targets.push(t);
      }
    }
    return targets;
  }

  async function deployRemote() {
    if (deployBtn) deployBtn.disabled = true;
    var targets = parseTargets(val('deploy-targets'));
    var mysqlHost = val('deploy-mysql-host');
    var sshUser = val('deploy-user') || 'root';
    var sshPort = Number(val('deploy-ssh-port')) || 22;
    var timeoutMs = (Number(val('deploy-timeout')) || 180) * 1000;
    var keyFile = val('deploy-key');

    if (targets.length === 0) {
      setDeployResult('✗ 请填写至少一个目标机器', 'err');
      if (deployBtn) deployBtn.disabled = false;
      return;
    }
    if (!mysqlHost) {
      setDeployResult('✗ MySQL 主机必填', 'err');
      if (deployBtn) deployBtn.disabled = false;
      return;
    }

    deployResultEl.textContent = '';
    appendDeployLog('▶ 部署 ' + targets.length + ' 个目标（超时 ' + (timeoutMs / 1000) + 's/个）...\n\n');

    var body = {
      targets: targets,
      sshUser: sshUser,
      sshPort: sshPort,
      mysqlHost: mysqlHost,
      timeoutMs: timeoutMs
    };
    if (keyFile) body.sshKeyFile = keyFile;

    try {
      var res = await fetch('/api/daemons/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (res.headers.get('Content-Type') && res.headers.get('Content-Type').includes('text/event-stream')) {
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var allOk = true;
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          var text = decoder.decode(chunk.value, { stream: true });
          var lines = text.split('\n');
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data: ')) continue;
            try {
              var msg = JSON.parse(line.slice(6));
              appendDeployLog(msg);
              if (msg.indexOf('✗') >= 0) allOk = false;
            } catch (e) { /* skip non-JSON */ }
          }
        }
        if (allOk) {
          deployResultEl.className = 'db-result db-ok';
          await loadDaemons();
        } else {
          deployResultEl.className = 'db-result db-err';
        }
      } else {
        var data = await res.json();
        if (data.ok) {
          appendDeployLog('✓ 部署成功\n');
          if (data.output) appendDeployLog(data.output);
          deployResultEl.className = 'db-result db-ok';
          await loadDaemons();
        } else {
          appendDeployLog('✗ ' + (data.error || '未知错误') + '\n');
          if (data.output) appendDeployLog(data.output);
          deployResultEl.className = 'db-result db-err';
        }
      }
    } catch (e) {
      appendDeployLog('✗ ' + (e.message || String(e)) + '\n');
      deployResultEl.className = 'db-result db-err';
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
