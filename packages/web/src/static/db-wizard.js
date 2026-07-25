// DB-backend migration wizard (settings page). External file because CSP
// script-src 'self' blocks inline scripts — see index.ts SEC_HEADERS.
(function () {
  if (!document.getElementById('db-test')) return;
  var R = document.getElementById('db-result');

  function get(id) { return document.getElementById(id).value; }
  function gather() {
    return JSON.stringify({
      host: get('db-host').trim(),
      port: Number(get('db-port')),
      user: get('db-user').trim(),
      password: get('db-password'),
      database: get('db-database').trim(),
      prefix: get('db-prefix').trim()
    });
  }
  function setBtns(d) {
    document.querySelectorAll('.db-controls button').forEach(function (b) { b.disabled = d; });
  }

  async function act(action) {
    if (action === 'enable' && !confirm('确认启用 MySQL 并重启？确保已完成 ① 测试 + ② 迁移。')) return;
    setBtns(true);
    R.className = 'db-result db-loading';
    R.textContent = action === 'enable' ? '正在写入 .env，进程即将重启…' : '处理中…';
    try {
      var res = await fetch('/api/db/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: gather()
      });
      var data = await res.json();
      if (action === 'enable' && data.ok) {
        R.className = 'db-result db-ok';
        R.textContent = '✓ .env 已写入。进程重启中，等待恢复…';
        setTimeout(poll, 3000);
        return;
      }
      if (action === 'daemon-config') {
        R.className = 'db-result ' + (data.configured ? 'db-ok' : 'db-err');
        R.textContent = data.configured
          ? '✓ daemon 已写入 .env 并重启:\n  ' + data.envPath
          : '⚠ daemon 无法自动配置（.env 未找到）。请手动操作:\n\n' + (data.manual || data.error || '');
        return;
      }
      R.className = 'db-result ' + (data.ok ? 'db-ok' : 'db-err');
      if (!data.ok) {
        var m = '✗ ' + (data.error || '未知错误');
        if (data.hint) m += '\n💡 ' + data.hint;
        R.textContent = m;
      } else if (data.tables) {
        R.textContent = '✓ 迁移完成（' + data.tables.length + ' 张表）:\n' +
          data.tables.map(function (t) { return '  ' + t.table + ': ' + t.rows + ' 行'; }).join('\n');
      } else if (data.serverVersion) {
        R.textContent = '✓ 连接成功 · MySQL ' + data.serverVersion +
          (data.databaseExists ? '' : '（库不存在，迁移时自动创建）');
      }
    } catch (e) {
      R.className = 'db-result db-err';
      R.textContent = '✗ ' + (e.message || String(e));
    } finally {
      if (action !== 'enable') setBtns(false);
    }
  }

  async function poll() {
    try { await fetch('/'); location.href = '/settings?saved=1'; }
    catch (e) { setTimeout(poll, 2000); }
  }

  document.getElementById('db-test').onclick = function () { act('test'); };
  document.getElementById('db-migrate').onclick = function () { act('migrate'); };
  document.getElementById('db-daemon').onclick = function () { act('daemon-config'); };
  document.getElementById('db-enable').onclick = function () { act('enable'); };

  var revertBtn = document.getElementById('db-revert');
  if (revertBtn) {
    revertBtn.onclick = async function () {
      if (!confirm('确认切回 SQLite？将创建新的 SQLite 文件并迁移数据，然后重启。')) return;
      var Rr = document.getElementById('db-revert-result');
      Rr.className = 'db-result db-loading';
      Rr.textContent = '正在迁移到 SQLite…';
      try {
        var res = await fetch('/api/db/revert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });
        var data = await res.json();
        if (data.ok) {
          Rr.className = 'db-result db-ok';
          Rr.textContent = '✓ 已迁移到 ' + data.targetPath + '。进程重启中…';
          setTimeout(poll, 3000);
        } else {
          Rr.className = 'db-result db-err';
          Rr.textContent = '✗ ' + (data.error || '未知错误') +
            (data.partial ? '\n部分完成: ' + data.partial.join(', ') : '');
        }
      } catch (e) {
        Rr.className = 'db-result db-err';
        Rr.textContent = '✗ ' + (e.message || String(e));
      }
    };
  }
})();
