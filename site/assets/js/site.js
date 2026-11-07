// Prism landing page — shared behaviour. Progressive enhancement only: the page reads fine
// without any of this. Motion is skipped entirely under prefers-reduced-motion.
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.remove("no-js");
  root.classList.add("js");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  window.PrismSite = { reduce: reduce };

  // ── Header condenses once the page scrolls (an observer, not a scroll handler).
  var header = document.querySelector("[data-header]");
  var sentinel = document.querySelector(".top-sentinel");
  if (header && sentinel && "IntersectionObserver" in window) {
    new IntersectionObserver(function (e) {
      header.classList.toggle("is-scrolled", !e[0].isIntersecting);
    }).observe(sentinel);
  }

  // ── Reveal on scroll, with a small stagger between siblings.
  var reveals = document.querySelectorAll(".reveal");
  if (!reduce.matches && "IntersectionObserver" in window) {
    var seen = new Map();
    reveals.forEach(function (el) {
      var parent = el.parentElement;
      var n = seen.get(parent) || 0;
      seen.set(parent, n + 1);
      el.style.setProperty("--d", Math.min(n, 5) * 80 + "ms");
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  // ── Spotlight on cards + the hero glow that follows the pointer (one rAF per frame).
  var pending = null;
  var frame = 0;
  function flush() {
    frame = 0;
    if (!pending) return;
    var p = pending; pending = null;
    if (p.spot) {
      var r = p.spot.getBoundingClientRect();
      p.spot.style.setProperty("--mx", (p.x - r.left) + "px");
      p.spot.style.setProperty("--my", (p.y - r.top) + "px");
    }
    if (p.hero && follow) {
      var hr = p.hero.getBoundingClientRect();
      follow.style.transform = "translate(" + (p.x - hr.left - 210) + "px," + (p.y - hr.top - 210 + 0.1 * hr.height) + "px)";
    }
  }
  var hero = document.querySelector("[data-hero]");
  var follow = document.querySelector("[data-follow]");
  if (finePointer.matches) {
    document.addEventListener("pointermove", function (e) {
      var t = e.target instanceof Element ? e.target : null;
      pending = {
        x: e.clientX, y: e.clientY,
        spot: t && t.closest(".spot"),
        hero: !reduce.matches && t && t.closest("[data-hero]"),
      };
      if (hero) hero.classList.toggle("is-pointer", !!pending.hero);
      if (!frame) frame = requestAnimationFrame(flush);
    }, { passive: true });
  }

  // ── Ticker: duplicate the list once so the loop is seamless (the copy is hidden from AT).
  var track = document.querySelector("[data-ticker]");
  if (track && track.firstElementChild) {
    var copy = track.firstElementChild.cloneNode(true);
    copy.setAttribute("aria-hidden", "true");
    track.appendChild(copy);
  }

  // ── Keyboard chips: light up in turn, and when the visitor presses the real keys.
  var keys = document.querySelector("[data-keys]");
  if (keys) {
    var chips = Array.prototype.slice.call(keys.children);
    var light = function (li, ms) {
      li.classList.add("is-lit");
      setTimeout(function () { li.classList.remove("is-lit"); }, ms || 700);
    };
    window.PrismSite.lightKey = function (k) {
      chips.forEach(function (li) { if (li.getAttribute("data-key") === k) light(li); });
    };
    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") window.PrismSite.lightKey("k");
      else if (e.key === "[") window.PrismSite.lightKey("[");
      else if (e.key === "/") window.PrismSite.lightKey("/");
    });
  }

  // ── Launch video dialog: the button appears only once the file exists.
  function exists(url) {
    if (!window.fetch || location.protocol === "file:") return Promise.resolve(false);
    return fetch(url, { method: "HEAD", cache: "no-cache" }).then(function (r) { return r.ok; }).catch(function () { return false; });
  }
  var openBtn = document.querySelector("[data-open-film]");
  var dialog = document.querySelector("[data-film]");
  var film = document.querySelector("[data-film-video]");
  var closeBtn = document.querySelector("[data-close-film]");
  var WIDE = "assets/video/prism-launch-16x9.mp4";
  var TALL = "assets/video/prism-launch-9x16.mp4";
  var narrow = window.matchMedia("(max-width: 600px) and (orientation: portrait)");
  if (openBtn && dialog && film && typeof dialog.showModal === "function") {
    var have = { wide: false, tall: false };
    Promise.all([exists(WIDE), exists(TALL)]).then(function (r) {
      have.wide = r[0]; have.tall = r[1];
      if (have.wide || have.tall) openBtn.hidden = false;
    });
    openBtn.addEventListener("click", function () {
      var tall = (narrow.matches && have.tall) || !have.wide;
      var src = tall ? TALL : WIDE;
      dialog.classList.toggle("portrait", tall);
      if (film.getAttribute("src") !== src) film.setAttribute("src", src);
      dialog.showModal();
      if (!reduce.matches) { var p = film.play(); if (p && p.catch) p.catch(function () {}); }
    });
    closeBtn.addEventListener("click", function () { dialog.close(); });
    dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });
    dialog.addEventListener("close", function () { film.pause(); openBtn.focus(); });
  }
})();
