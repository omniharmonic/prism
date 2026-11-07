// A small, hand-written force-directed graph of ~40 fictional notes on a canvas.
// Drifts gently, makes room for the pointer, highlights a note's neighbours on hover,
// and lets a mouse drag a note. Pauses off screen; under reduced motion it settles once
// and only redraws for hover.
(function () {
  "use strict";
  var canvas = document.querySelector("[data-graph]");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var GROUPS = { p: "#4f8ff7", h: "#f783ac", m: "#44c98a", i: "#b4a4ce" };
  var RAW = [
    ["Launch plan", "p"], ["Field guide", "p"], ["Community garden", "p"], ["Podcast", "p"],
    ["Maya", "h"], ["Theo", "h"], ["Ana", "h"], ["Jonah", "h"], ["Priya", "h"], ["Sam", "h"], ["Lena", "h"], ["Kofi", "h"], ["Ines", "h"],
    ["Kickoff", "m"], ["Weekly sync", "m"], ["Design review", "m"], ["Garden walk", "m"], ["Interview: Priya", "m"], ["Retro", "m"], ["Budget call", "m"], ["Recording day", "m"], ["Planning", "m"], ["1:1 Theo", "m"],
    ["Local-first", "i"], ["Wikilinks", "i"], ["Second brain", "i"], ["Daily notes", "i"], ["Zettelkasten", "i"], ["Seasonal planting", "i"], ["Soil health", "i"], ["Episode ideas", "i"], ["Show notes", "i"], ["Release notes", "i"], ["Landing page", "i"], ["Reading list", "i"], ["Field notes", "i"], ["Watershed map", "i"], ["Composting", "i"], ["Interview questions", "i"], ["Roadmap", "i"],
  ];
  var EDGES = [
    "Launch plan|Maya", "Launch plan|Ana", "Launch plan|Theo", "Launch plan|Kickoff", "Launch plan|Weekly sync", "Launch plan|Release notes", "Launch plan|Landing page", "Launch plan|Roadmap", "Launch plan|Retro", "Launch plan|Design review",
    "Field guide|Lena", "Field guide|Kofi", "Field guide|Field notes", "Field guide|Watershed map", "Field guide|Seasonal planting", "Field guide|Reading list", "Field guide|Garden walk",
    "Community garden|Ines", "Community garden|Kofi", "Community garden|Sam", "Community garden|Garden walk", "Community garden|Soil health", "Community garden|Composting", "Community garden|Seasonal planting", "Community garden|Budget call",
    "Podcast|Jonah", "Podcast|Priya", "Podcast|Interview: Priya", "Podcast|Recording day", "Podcast|Episode ideas", "Podcast|Show notes", "Podcast|Interview questions",
    "Maya|Weekly sync", "Maya|Design review", "Maya|Landing page", "Maya|Release notes", "Theo|1:1 Theo", "Theo|Planning", "Theo|Roadmap", "Ana|Kickoff", "Ana|Retro", "Ana|Recording day",
    "Jonah|Recording day", "Jonah|Episode ideas", "Priya|Interview: Priya", "Sam|Budget call", "Sam|Planning", "Lena|Field notes", "Lena|Reading list", "Kofi|Soil health", "Ines|Composting", "Ines|Garden walk",
    "Local-first|Second brain", "Local-first|Wikilinks", "Wikilinks|Zettelkasten", "Wikilinks|Daily notes", "Second brain|Zettelkasten", "Second brain|Reading list", "Daily notes|Weekly sync", "Daily notes|Field notes",
    "Zettelkasten|Reading list", "Soil health|Composting", "Seasonal planting|Watershed map", "Episode ideas|Interview questions", "Show notes|Release notes", "Roadmap|Planning", "Local-first|Launch plan", "Second brain|Podcast",
  ];

  var nodes = RAW.map(function (r, i) {
    var a = (i / RAW.length) * Math.PI * 2;
    return { id: r[0], g: r[1], x: Math.cos(a) * 120, y: Math.sin(a) * 120, vx: 0, vy: 0, deg: 0, nb: [], ph: Math.random() * 6.28 };
  });
  var byId = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  var edges = EDGES.map(function (e) {
    var p = e.split("|"), a = byId[p[0]], b = byId[p[1]];
    a.deg++; b.deg++; a.nb.push(b); b.nb.push(a);
    return [a, b];
  });
  nodes.forEach(function (n) { n.r = 3.2 + Math.sqrt(n.deg) * 1.9; });

  var W = 0, H = 0, dpr = 1, scale = 1;
  var hover = null, drag = null, pointer = null;
  var textColor = "#f3f3f5", lineColor = "rgba(255,255,255,";
  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    textColor = cs.getPropertyValue("--text").trim() || "#f3f3f5";
    var light = window.matchMedia("(prefers-color-scheme: light)").matches;
    lineColor = light ? "rgba(20,30,60," : "rgba(200,215,255,";
  }
  function resize() {
    var r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    scale = Math.max(0.62, Math.min(1.15, Math.min(W, H * 1.5) / 640));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reduce) draw();
  }

  // ── Simulation ──
  var t = 0;
  function step(strength) {
    var i, j, a, b, dx, dy, d2, d, f;
    var rest = 64 * scale, k = 2400 * scale * scale;
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        b = nodes[j];
        dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 90000) continue;
        f = k / d2; d = Math.sqrt(d2);
        dx = (dx / d) * f; dy = (dy / d) * f;
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
      }
    }
    for (i = 0; i < edges.length; i++) {
      a = edges[i][0]; b = edges[i][1];
      dx = b.x - a.x; dy = b.y - a.y; d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      f = (d - rest) * 0.02; dx = (dx / d) * f; dy = (dy / d) * f;
      a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
    }
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      a.vx -= a.x * 0.006; a.vy -= a.y * 0.009 * (W / Math.max(H, 1));
      if (strength) { a.vx += Math.cos(t * 0.6 + a.ph) * 0.05; a.vy += Math.sin(t * 0.5 + a.ph * 1.3) * 0.05; }
      if (pointer && !drag) {
        dx = a.x - pointer.x; dy = a.y - pointer.y; d2 = dx * dx + dy * dy;
        if (d2 < 9000 && d2 > 1) { d = Math.sqrt(d2); f = (95 - d) * 0.012; a.vx += (dx / d) * f; a.vy += (dy / d) * f; }
      }
      if (a === drag) { a.x = pointer.x; a.y = pointer.y; a.vx = a.vy = 0; continue; }
      a.vx *= 0.82; a.vy *= 0.82;
      a.x += a.vx; a.y += a.vy;
      var mx = W / 2 - 24, my = H / 2 - 24;
      if (a.x > mx) a.x = mx; if (a.x < -mx) a.x = -mx;
      if (a.y > my) a.y = my; if (a.y < -my) a.y = -my;
    }
    t += 0.016;
  }

  // ── Drawing ──
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    var focus = hover || drag;
    var lit = focus ? new Set([focus].concat(focus.nb)) : null;
    ctx.lineWidth = 1;
    for (var i = 0; i < edges.length; i++) {
      var a = edges[i][0], b = edges[i][1];
      var on = focus && (a === focus || b === focus);
      ctx.strokeStyle = on ? GROUPS[focus.g] : lineColor + (focus ? 0.06 : 0.16) + ")";
      ctx.lineWidth = on ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var dim = lit && !lit.has(n);
      ctx.globalAlpha = dim ? 0.22 : 1;
      if (n === focus) {
        ctx.fillStyle = GROUPS[n.g]; ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 9, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = GROUPS[n.g];
      ctx.beginPath(); ctx.arc(n.x, n.y, n === focus ? n.r + 2 : n.r, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (i = 0; i < nodes.length; i++) {
      n = nodes[i];
      var show = lit ? lit.has(n) : n.deg >= 6;
      if (!show) continue;
      ctx.font = (n === focus ? "600 13px " : "500 11.5px ") + "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.fillStyle = textColor;
      ctx.globalAlpha = n === focus || !lit ? 0.95 : 0.8;
      ctx.fillText(n.id, n.x, n.y + n.r + 5);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── Pointer ──
  function local(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left - W / 2, y: e.clientY - r.top - H / 2 };
  }
  function pick(p) {
    var best = null, bd = 22 * 22;
    nodes.forEach(function (n) { var dx = n.x - p.x, dy = n.y - p.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = n; } });
    return best;
  }
  canvas.addEventListener("pointermove", function (e) {
    pointer = local(e);
    if (!drag) hover = pick(pointer);
    if (reduce) draw(); else wake();
  });
  canvas.addEventListener("pointerleave", function () { pointer = null; if (!drag) hover = null; if (reduce) draw(); });
  canvas.addEventListener("pointerdown", function (e) {
    pointer = local(e);
    var n = pick(pointer);
    hover = n;
    if (n && e.pointerType === "mouse" && !reduce) {
      drag = n; canvas.setPointerCapture(e.pointerId); canvas.classList.add("is-dragging");
    }
    if (reduce) draw(); else wake();
  });
  function endDrag() { drag = null; canvas.classList.remove("is-dragging"); }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // ── Loop ──
  var visible = false, raf = 0;
  function frame() {
    raf = 0;
    if (!visible || document.hidden) return;
    step(true); draw();
    raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf && !reduce && visible && !document.hidden) raf = requestAnimationFrame(frame); }

  readTheme();
  resize();
  for (var k = 0; k < 360; k++) step(false);
  draw();
  if ("ResizeObserver" in window) new ResizeObserver(function () { resize(); draw(); }).observe(canvas);
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () { readTheme(); draw(); });
  if (!reduce) {
    document.addEventListener("visibilitychange", wake);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (e) { visible = e[0].isIntersecting; wake(); }).observe(canvas);
    } else { visible = true; wake(); }
  }
})();
