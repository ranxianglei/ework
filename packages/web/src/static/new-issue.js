// New-issue form: orphan uploads → /api/:o/:r/upload → markdown inserted at
// cursor; attachments bind to the issue when the form is submitted.
(function () {
  "use strict";

  var form = document.querySelector("form.new-form");
  if (!form) return;
  var owner = form.getAttribute("data-owner") || "";
  var repo = form.getAttribute("data-repo") || "";
  var fileInput = document.getElementById("newFile");
  var bodyEl = document.getElementById("newBody");
  var titleEl = document.getElementById("newTitle");
  var submitBtn = document.getElementById("newSubmit");
  var status = document.getElementById("newUpStatus");

  function insertAtCursor(text) {
    var el = bodyEl;
    var s = el.selectionStart != null ? el.selectionStart : el.value.length;
    var e = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.selectionStart = el.selectionEnd = s + text.length;
    el.focus();
  }

  function setStatus(t) {
    if (status) status.textContent = t;
  }

  async function uploadFiles(files) {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (submitBtn) { submitBtn.disabled = true; }
      setStatus("上传中: " + f.name + " …");
      try {
        var fd = new FormData();
        fd.set("attachment", f);
        fd.set("name", f.name);
        var res = await fetch("/api/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/upload", {
          method: "POST",
          body: fd,
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.markdown) insertAtCursor((bodyEl.value ? "\n" : "") + data.markdown);
        setStatus("已附: " + f.name);
      } catch (e) {
        setStatus("上传失败: " + f.name);
        alert("上传失败: " + (e && e.message ? e.message : e));
      } finally {
        if (submitBtn) { submitBtn.disabled = false; }
      }
    }
  }

  if (fileInput) {
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files.length) uploadFiles(Array.prototype.slice.call(fileInput.files));
      fileInput.value = "";
    });
  }
  if (bodyEl) {
    bodyEl.addEventListener("paste", function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === "file") {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        uploadFiles(files);
      }
    });
  }
  window.addEventListener("beforeunload", function (e) {
    var dirty = (bodyEl && bodyEl.value.trim()) || (titleEl && titleEl.value.trim());
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
})();
