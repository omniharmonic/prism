// The hero's "living product moment": a replay of Prism's editor drawn in HTML.
// The static markup is the finished page (what no-JS and reduced motion show). Here we
// clear it and replay: a heading types itself, "/" opens the block menu, "[[" links a page,
// a collaborator joins and comments, then the page becomes a board and a calendar. Loops.
// It pauses while off screen or in a hidden tab.
(function () {
  "use strict";
  var demo = document.querySelector("[data-demo]");
  if (!demo) return;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduce.matches) return;

  var $ = function (sel) { return demo.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(demo.querySelectorAll(sel)); };
  var title = $('[data-t="title"]');
  var lede = $('[data-t="lede"]');
  var todos = $("[data-todos]");
  var todo1 = $("[data-todo1]");
  var todo2 = $("[data-todo2]");
  var todo1t = todo1.querySelector(".hl");
  var todo2t = $('[data-t="todo2"]');
  var linkline = $("[data-linkline]");
  var linkPre = $('[data-t="link-pre"]');
  var linkPost = $('[data-t="link-post"]');
  var chip = $("[data-chip]");
  var caret = $("[data-caret]");
  var maya = $("[data-maya]");
  var mayaAv = $("[data-maya-av]");
  var comment = $("[data-comment]");
  var hl = $("[data-hl]");
  var slash = $("[data-slash]");
  var links = $("[data-links]");
  var doc = $(".scene-page > .doc");
  var crumb = $("[data-crumb]");
  var glide = $("[data-glide]");
  var colDoing = $("[data-col-doing]");
  var colDone = $("[data-col-done]");
  var nDoing = $("[data-n-doing]");
  var nDone = $("[data-n-done]");
  var cal = $("[data-cal]");

  // ── Pause / resume ────────────────────────────────────────────────
  var visible = false;
  var waiting = [];
  function running() { return visible && !document.hidden; }
  function gate() {
    return running() ? Promise.resolve() : new Promise(function (r) { waiting.push(r); });
  }
  function update() {
    if (running()) { var w = waiting; waiting = []; w.forEach(function (r) { r(); }); }
  }
  async function wait(ms) {
    await gate();
    await new Promise(function (r) { setTimeout(r, ms); });
    await gate();
  }
  document.addEventListener("visibilitychange", update);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (e) { visible = e[0].isIntersecting; update(); }, { threshold: 0.2 }).observe(demo);
  } else { visible = true; }

  // ── Helpers ───────────────────────────────────────────────────────
  function caretInto(el, who) {
    var c = who || caret;
    el.appendChild(c);
    c.classList.add("is-on");
    return c;
  }
  async function type(el, text, speed, who) {
    var node = document.createTextNode("");
    el.insertBefore(node, el.firstChild);
    caretInto(el, who);
    for (var i = 0; i < text.length; i++) {
      node.data += text[i];
      await wait(speed + (text[i] === " " ? speed * 0.6 : Math.random() * speed * 0.5));
    }
    return node;
  }
  function placePop(pop, anchor) {
    var x = Math.min(anchor.offsetLeft, Math.max(0, doc.clientWidth - pop.offsetWidth));
    pop.style.left = x + "px";
    pop.style.top = anchor.offsetTop + anchor.offsetHeight + 6 + "px";
    pop.classList.add("is-on");
  }
  function filter(pop, attr, q) {
    var first = null;
    pop.querySelectorAll("[" + attr + "]").forEach(function (it) {
      var words = (it.lastChild ? it.lastChild.textContent : it.textContent).trim().toLowerCase().split(/[\s-]+/);
      var hit = !q || words.some(function (w) { return w.indexOf(q) === 0; });
      it.classList.toggle("is-hidden", !hit);
      it.classList.remove("is-active");
      if (hit && !first) first = it;
    });
    if (first) first.classList.add("is-active");
  }
  function show(name) {
    $$("[data-scene]").forEach(function (s) { s.classList.toggle("is-on", s.getAttribute("data-scene") === name); });
    $$("[data-tab]").forEach(function (s) { s.classList.toggle("is-on", s.getAttribute("data-tab") === name); });
    $$("[data-side]").forEach(function (s) { s.classList.toggle("is-on", s.getAttribute("data-side") === name); });
    crumb.innerHTML = name === "page" ? "Projects / <b>Launch plan</b>" : "Projects / <b>Launch tracker</b>";
  }
  function dbView(name) {
    $$("[data-dbtab]").forEach(function (s) { s.classList.toggle("is-on", s.getAttribute("data-dbtab") === name); });
    $$("[data-dbv]").forEach(function (s) { s.classList.toggle("is-on", s.getAttribute("data-dbv") === name); });
  }
  function light(k) { if (window.PrismSite && window.PrismSite.lightKey) window.PrismSite.lightKey(k); }

  // ── The calendar (two weeks from Monday 9 November 2026) ──────────
  var EVENTS = { 9: ["Seed tag schemas", "e3"], 10: ["Landing page", ""], 12: ["Launch video", "e3"], 13: ["Release notes", "e2"], 14: ["Pair the iPhone", ""], 17: ["Launch day", "e2"], 19: ["Retro", ""] };
  function buildCal() {
    var html = "";
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach(function (d) { html += '<div class="cal-cell is-h">' + d + "</div>"; });
    for (var d = 9; d <= 22; d++) {
      html += '<div class="cal-cell' + (d === 12 ? " is-today" : "") + '"><b>' + d + "</b>" +
        (EVENTS[d] ? '<span class="cal-ev ' + EVENTS[d][1] + '" data-ev>' + EVENTS[d][0] + "</span>" : "") + "</div>";
    }
    cal.innerHTML = html;
  }

  // ── Reset to an empty page ────────────────────────────────────────
  function reset() {
    show("page");
    dbView("board");
    title.textContent = "";
    lede.textContent = "";
    todos.hidden = true;
    todo2.hidden = true;
    todo1.classList.remove("is-done");
    todo1t.textContent = "";
    todo2t.textContent = "";
    linkline.hidden = true;
    linkPre.textContent = "";
    linkPost.textContent = "";
    chip.hidden = true;
    chip.classList.remove("is-new");
    hl.classList.remove("is-on");
    comment.classList.add("is-out");
    mayaAv.classList.add("is-out");
    maya.classList.remove("is-on");
    caret.classList.remove("is-on", "blink");
    slash.classList.remove("is-on");
    links.classList.remove("is-on");
    var tmp = doc.querySelector("[data-tmp]");
    if (tmp) tmp.remove();
    colDoing.insertBefore(glide, colDoing.querySelector(".kcard"));
    nDoing.textContent = "2"; nDone.textContent = "1";
    buildCal();
    cal.querySelectorAll("[data-ev]").forEach(function (e) { e.style.opacity = "0"; });
  }

  // ── One pass ──────────────────────────────────────────────────────
  async function pass() {
    reset();
    await wait(500);
    await type(title, "Launch plan", 75);
    await wait(260);
    await type(lede, "Ship v1 to everyone who wants Notion's power and Obsidian's soul.", 24);
    await wait(320);

    // "/" — the block menu
    var tmp = document.createElement("p");
    tmp.className = "doc-p";
    tmp.setAttribute("data-tmp", "");
    doc.insertBefore(tmp, todos);
    var slashText = await type(tmp, "/", 0);
    light("/");
    filter(slash, "data-opt", "");
    placePop(slash, caret);
    await wait(650);
    slashText.data = "/t"; filter(slash, "data-opt", "t"); await wait(240);
    slashText.data = "/to"; filter(slash, "data-opt", "to"); await wait(620);
    slash.classList.remove("is-on");
    tmp.remove();
    todos.hidden = false;
    await type(todo1t, "Record the launch video", 38);
    await wait(320);

    // "[[" — link a page
    linkline.hidden = false;
    await type(linkPre, "Copy lives in ", 34);
    var brackets = document.createElement("span");
    brackets.className = "wl-typing";
    linkPre.after(brackets);
    var bt = await type(brackets, "[[", 110);
    light("[");
    filter(links, "data-lopt", "");
    placePop(links, caret);
    await wait(520);
    bt.data = "[[La"; filter(links, "data-lopt", "la"); await wait(380);
    bt.data = "[[Lan"; filter(links, "data-lopt", "lan"); await wait(640);
    links.classList.remove("is-on");
    brackets.remove();
    chip.hidden = false;
    chip.classList.add("is-new");
    await type(linkPost, ".", 60);
    caret.classList.add("blink");
    await wait(700);

    // Maya joins, writes, checks a box, comments
    mayaAv.classList.remove("is-out");
    await wait(500);
    todo2.hidden = false;
    await type(todo2t, "Write release notes", 58, maya);
    await wait(450);
    todo1.querySelector(".todo-t").appendChild(maya);
    await wait(380);
    todo1.classList.add("is-done");
    await wait(450);
    hl.classList.add("is-on");
    await wait(250);
    comment.classList.remove("is-out");
    await wait(2600);

    // The same work, as a database
    maya.classList.remove("is-on");
    show("db");
    await wait(1100);
    var first = glide.getBoundingClientRect();
    colDone.insertBefore(glide, colDone.querySelector(".kcard"));
    nDoing.textContent = "1"; nDone.textContent = "2";
    var last = glide.getBoundingClientRect();
    var dx = first.left - last.left, dy = first.top - last.top;
    glide.classList.add("is-lifted");
    if (glide.animate) {
      var a = glide.animate([
        { transform: "translate(" + dx + "px," + dy + "px) scale(1)" },
        { transform: "translate(" + dx + "px," + (dy - 10) + "px) scale(1.04) rotate(-1.5deg)", offset: 0.15 },
        { transform: "translate(0,-6px) scale(1.04) rotate(1deg)", offset: 0.85 },
        { transform: "none" },
      ], { duration: 1100, easing: "cubic-bezier(.45,.05,.2,1)" });
      await new Promise(function (r) { a.onfinish = r; a.oncancel = r; });
    }
    glide.classList.remove("is-lifted");
    await wait(1300);

    // …and as a calendar
    dbView("cal");
    var evs = cal.querySelectorAll("[data-ev]");
    for (var i = 0; i < evs.length; i++) {
      await wait(110);
      evs[i].style.opacity = "";
      evs[i].classList.add("pop-in");
    }
    await wait(3000);
    demo.querySelector(".app-main").style.opacity = "0";
    await wait(450);
    reset();
    demo.querySelector(".app-main").style.opacity = "";
  }

  demo.querySelector(".app-main").style.transition = "opacity .45s ease";
  reset();
  (async function loop() {
    for (;;) {
      try { await pass(); } catch (e) { if (window.console) console.warn("hero demo:", e); await wait(1000); }
      if (reduce.matches) return;
    }
  })();
})();
