// A barcode scanner behaves like a keyboard that types very fast and then presses Enter.

// Anything typed (or scanned) while no field is focused goes to the scan box in the header.
document.addEventListener("keydown", function (e) {
  var scan = document.getElementById("scan");
  var tag = (e.target.tagName || "").toLowerCase();
  if (!scan || tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
  scan.focus();
});

// Serial / MAC rows on the item form.
(function () {
  var rows = document.getElementById("id-rows");
  var template = document.getElementById("id-template");
  if (!rows || !template) return;

  function addRow() {
    rows.appendChild(template.content.cloneNode(true));
    return rows.lastElementChild;
  }

  document.getElementById("add-id").addEventListener("click", function () {
    addRow().querySelector("input").focus();
  });

  rows.addEventListener("click", function (e) {
    if (!e.target.classList.contains("remove-id")) return;
    e.target.closest(".id-row").remove();
    if (!rows.children.length) addRow();
  });

  // The scanner's Enter moves to the next ID row instead of saving the whole form.
  rows.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.target.name !== "id_value") return;
    e.preventDefault();
    if (!e.target.value.trim()) return;
    var next = e.target.closest(".id-row").nextElementSibling || addRow();
    next.querySelector("input").focus();
  });
})();

// Tick / untick every row in the inventory list.
(function () {
  var all = document.getElementById("check-all");
  if (!all) return;
  all.addEventListener("change", function () {
    document.querySelectorAll('input[name="ids"]').forEach(function (box) {
      box.checked = all.checked;
    });
  });
})();

document.querySelectorAll("form[data-confirm]").forEach(function (form) {
  form.addEventListener("submit", function (e) {
    if (!window.confirm(form.dataset.confirm)) e.preventDefault();
  });
});
