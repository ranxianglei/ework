(function () {
  var dataEl = document.getElementById('label-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent || '{}');
  var palette = data.palette || [];
  var LABELS = data.labels || [];

  function bindSwatches(container, colorInput) {
    if (!container || !colorInput) return;
    container.innerHTML = palette.map(function (c) {
      return '<button type="button" class="swatch" data-color="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>';
    }).join('');
    function sync() {
      container.querySelectorAll('.swatch').forEach(function (b) {
        b.classList.toggle('sel', b.dataset.color.toLowerCase() === colorInput.value.toLowerCase());
      });
    }
    sync();
    container.addEventListener('click', function (e) {
      var b = e.target.closest('.swatch');
      if (!b) return;
      colorInput.value = b.dataset.color;
      sync();
    });
    colorInput.addEventListener('input', sync);
  }

  bindSwatches(document.getElementById('palette'), document.getElementById('f-color'));

  var dlg = document.getElementById('dlg');
  if (!dlg) return;
  var ef = document.getElementById('edit-form');
  var dp = document.getElementById('dlg-palette');
  var dlgColor;

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-edit-btn]');
    if (!btn) return;
    var id = Number(btn.dataset.editBtn);
    var l = LABELS.find(function (x) { return x.id === id; });
    if (!l) return;
    ef.action = btn.form.action;
    ef.querySelector('[name=name]').value = l.name;
    ef.querySelector('[name=color]').value = l.color;
    dlgColor = ef.querySelector('[name=color]');
    ef.querySelector('[name=description]').value = l.description;
    ef.querySelector('[name=exclusive]').checked = l.exclusive === 1;
    bindSwatches(dp, dlgColor);
    dlg.showModal();
  });

  document.getElementById('dlg-cancel').addEventListener('click', function () { dlg.close(); });
})();
