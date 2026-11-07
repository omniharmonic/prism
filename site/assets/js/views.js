// The database view switcher: the same eight pages as Table / Board / Calendar / Gallery.
// Each page is ONE element that moves between layouts; FLIP animates it from where it was
// to where it lands (skipped under reduced motion). Tabs use roving focus (arrow keys).
(function () {
  "use strict";
  var root = document.querySelector("[data-views]");
  if (!root) return;
  var stage = root.querySelector("[data-views-stage]");
  var tabs = Array.prototype.slice.call(root.querySelectorAll("[role=tab]"));
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  var OWNERS = { Ana: "#3b82f6", Maya: "#f783ac", Theo: "#22c55e" };
  var STATUS = { todo: "To do", doing: "In progress", done: "Done" };
  var ROWS = [
    ["Record the launch video", "doing", "Ana", 12, "135deg,#4f8ff7,#b4a4ce"],
    ["Write release notes", "todo", "Maya", 13, "135deg,#f783ac,#f0b429"],
    ["Landing page", "doing", "Maya", 10, "135deg,#22c55e,#4f8ff7"],
    ["Pair the iPhone app", "todo", "Theo", 14, "135deg,#b4a4ce,#f783ac"],
    ["Seed tag schemas", "done", "Ana", 9, "135deg,#06b6d4,#22c55e"],
    ["Import the old wiki", "done", "Theo", 11, "135deg,#f0b429,#ef4444"],
    ["Publish the docs site", "todo", "Ana", 15, "135deg,#4f8ff7,#06b6d4"],
    ["Invite the team", "doing", "Theo", 13, "135deg,#a855f7,#4f8ff7"],
  ];

  var items = ROWS.map(function (r, i) {
    var el = document.createElement("div");
    el.className = "vitem";
    el.setAttribute("data-s", r[1]);
    el.innerHTML =
      '<div class="vi-in"><span class="cover" style="background:linear-gradient(' + r[4] + ')"></span>' +
      '<span class="vi-title">' + r[0] + "</span>" +
      '<span class="vi-status"><span class="pill s-' + r[1] + '">' + STATUS[r[1]] + "</span></span>" +
      '<span class="vi-meta"><span class="vi-owner owner"><i style="background:' + OWNERS[r[2]] + '">' + r[2][0] + "</i>" + r[2] + "</span>" +
      '<span class="vi-date">Nov ' + r[3] + "</span></span></div>";
    return { el: el, s: r[1], day: r[3], i: i };
  });

  function el(tag, cls, html) { var e = document.createElement(tag); e.className = cls; if (html) e.innerHTML = html; return e; }

  function layout(view) {
    var box;
    if (view === "table") {
      box = el("div", "vlayout table");
      box.appendChild(el("div", "vhead", "<span>Page</span><span>Status</span><span>Owner</span><span>Date</span>"));
      items.forEach(function (it) { box.appendChild(it.el); });
    } else if (view === "board") {
      box = el("div", "vlayout vcols");
      ["todo", "doing", "done"].forEach(function (s) {
        var col = el("div", "vcol");
        var n = items.filter(function (it) { return it.s === s; });
        col.appendChild(el("div", "vcol-h", '<span class="pill s-' + s + '">' + STATUS[s] + '</span><span style="color:var(--app-text-3)">' + n.length + "</span>"));
        n.forEach(function (it) { col.appendChild(it.el); });
        box.appendChild(col);
      });
    } else if (view === "calendar") {
      box = el("div", "vlayout vcal");
      var names = ["Mon 9", "Tue 10", "Wed 11", "Thu 12", "Fri 13", "Sat 14", "Sun 15"];
      for (var d = 9; d <= 15; d++) {
        var cell = el("div", "vday", '<span class="vday-n">' + names[d - 9] + "</span>");
        items.forEach(function (it) { if (it.day === d) cell.appendChild(it.el); });
        box.appendChild(cell);
      }
    } else {
      box = el("div", "vlayout vgal");
      items.forEach(function (it) { box.appendChild(it.el); });
    }
    return box;
  }

  var current = null;
  function render(view, animate) {
    if (view === current) return;
    current = view;
    var first = new Map();
    var h0 = stage.offsetHeight;
    if (animate) items.forEach(function (it) { if (it.el.isConnected) first.set(it, it.el.getBoundingClientRect()); });
    stage.replaceChildren(layout(view));
    stage.setAttribute("data-view", view);
    if (!animate) return;
    var h1 = stage.offsetHeight;
    if (h0 !== h1 && stage.animate) stage.animate([{ height: h0 + "px" }, { height: h1 + "px" }], { duration: 520, easing: "cubic-bezier(.2,.7,.1,1)" });
    items.forEach(function (it, idx) {
      var a = first.get(it);
      if (!a || !it.el.animate) return;
      var b = it.el.getBoundingClientRect();
      if (!b.width || !b.height) return;
      var dx = a.left - b.left, dy = a.top - b.top, sx = a.width / b.width, sy = a.height / b.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
      it.el.classList.add("is-moving");
      var anim = it.el.animate(
        [{ transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")" }, { transform: "none" }],
        { duration: 560, delay: idx * 18, easing: "cubic-bezier(.2,.7,.1,1)", fill: "backwards" }
      );
      anim.onfinish = anim.oncancel = function () { it.el.classList.remove("is-moving"); };
    });
  }

  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
    });
    if (focus) tab.focus();
    render(tab.getAttribute("data-view"), !reduce.matches);
  }
  tabs.forEach(function (t, i) {
    t.tabIndex = i === 0 ? 0 : -1;
    t.addEventListener("click", function () { select(t, false); });
    t.addEventListener("keydown", function (e) {
      var j = null;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabs.length - 1;
      if (j !== null) { e.preventDefault(); select(tabs[j], true); }
    });
  });
  render("table", false);
})();
