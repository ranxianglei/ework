// Delegated click handler for label chips inside <a class="row"> elements.
// Labels are <span class="issue-label" data-href="..."> nested inside the row <a>.
// Without interception, clicking a label would navigate to the issue (the <a> default).
// This handler stops propagation and navigates to the label filter URL instead.
(function () {
  document.addEventListener("click", function (e) {
    var label = e.target.closest(".issue-label[data-href]");
    if (!label) return;
    e.preventDefault();
    e.stopPropagation();
    location.href = label.getAttribute("data-href");
  });
})();
