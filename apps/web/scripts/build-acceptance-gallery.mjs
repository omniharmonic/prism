#!/usr/bin/env node
/**
 * Builds the acceptance-shot gallery: ONE self-contained page (images embedded as JPEG data
 * URIs, no external resource) from `apps/web/acceptance-shots/*.png` + the shot list
 * (`e2e-fixtures/acceptance-shots.ts`) + the parity documents (acceptance text, what to verify).
 *
 *   node apps/web/scripts/build-acceptance-gallery.mjs [--shots <dir>] [--out <file.html>] [--max-mb 14] [--quality 70]
 *
 * Node >= 22.18 loads the .ts shot list directly; on an older Node run it with `--import tsx`.
 * The page has no <html>/<head>/<body> of its own: it is published inside a host skeleton.
 * If the page would exceed --max-mb it is split by section into <out>-1.html, <out>-2.html, …
 * JPEG conversion uses macOS `sips`; without it the PNGs are embedded as they are.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..");
const repo = path.join(web, "..", "..");
const docs = path.join(repo, "docs", "roadmap", "workspace-experience");
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const shotsDir = path.resolve(arg("shots", path.join(web, "acceptance-shots")));
const outFile = path.resolve(arg("out", path.join(web, "acceptance-gallery.html")));
const maxBytes = Number(arg("max-mb", "14")) * 1024 * 1024;
const quality = String(arg("quality", "70"));

const { SHOTS, SECTIONS } = await import(pathToFileURL(path.join(web, "e2e-fixtures", "acceptance-shots.ts")).href);

/* ── the parity documents ── */
const read = (name) => { try { return fs.readFileSync(path.join(docs, name), "utf8"); } catch { return ""; } };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The little Markdown the checklist cells use: **bold**, `code`. Everything else is text. */
const md = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");

const rows = new Map();
for (const line of read("NOTION-PARITY-CHECKLIST.md").split("\n")) {
  if (!line.startsWith("| NP-")) continue;
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  const id = cells[0];
  const tail = /^NP-PF-/.test(id) ? 2 : 3; // PF rows have no Backend column
  rows.set(id, { acceptance: cells.slice(1, cells.length - tail).join(" | "), verify: cells[cells.length - tail], status: cells[cells.length - 1] });
}
const evidence = new Map();
for (const line of read("PARITY-EVIDENCE.md").split("\n")) {
  if (!line.startsWith("| NP-")) continue;
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  evidence.set(cells[0], { status: cells[1], note: cells[cells.length - 1] });
}
// --gaps <file>: a newer PARITY-GAPS.md (e.g. `git show <branch>:…/PARITY-GAPS.md > file`) than the one in this tree.
const gaps = arg("gaps") ? fs.readFileSync(path.resolve(arg("gaps")), "utf8") : read("PARITY-GAPS.md");
const b2 = gaps.slice(gaps.indexOf("### b.2"), gaps.indexOf("### b.3"));
const failRule = (b2.match(/Fail on:?\*{0,2} ([^\n]+?)\.\s*(\n|$)/) ?? b2.match(/Fail on ([^.]+)\./) ?? [])[1] ?? "clipped text, sideways page scroll, white panels in dark, overlapping bottom controls, focus rings around the writing surface, or icon-only controls the board labels";
const boards = new Map();
for (const line of b2.split("\n")) {
  if (!line.startsWith("|") || /^\|\s*(Board|---)/.test(line)) continue;
  const [board, list] = line.split("|").slice(1, -1).map((c) => c.trim());
  for (const m of list.matchAll(/(?:NP-)?([A-Z]{2}-\d{2})(?:\s*\(([^)]+)\))?/g)) {
    const id = `NP-${m[1]}`;
    boards.set(id, [...(boards.get(id) ?? []), m[2] ? `${board} — for this row: ${m[2]}` : board]);
  }
}
// The machine-usable form of §b.2: `row | fixture + query | viewport | theme | what to verify`.
const captures = new Map();
for (const line of b2.split("\n")) {
  const m = /^(NP-[A-Z]{2}-\d{2}) \| (.+)$/.exec(line.trim());
  if (!m) continue;
  const parts = m[2].split(" | ");
  if (parts.length >= 4) captures.set(m[1], [...(captures.get(m[1]) ?? []), parts.slice(3).join(" | ")]);
}
const boardFiles = (() => { try { return fs.readdirSync(path.join(docs, "assets")).filter((f) => f.endsWith(".png")); } catch { return []; } })();
const boardName = (n) => boardFiles.find((f) => f.startsWith(`${n}-`) || f === `${n}.png`)?.replace(/\.png$/, "") ?? n;
const SURFACE_TEXT = {
  "X-SETTINGS": "No checklist row names this surface. Judge it as part of dark-mode parity (NP-AX-01) and overall visual quality.",
  "X-PEOPLE": "No checklist row names this surface (a Prism feature outside Notion parity). Shown for overall visual quality.",
  "X-CALENDAR": "No checklist row names this surface (Tools → Calendar). Shown for overall visual quality.",
  "X-MESSAGES": "No checklist row names this surface (a Prism feature outside Notion parity). Shown for overall visual quality.",
};

/* ── images ── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-gallery-"));
let sips = true;
function dataUri(file) {
  if (!fs.existsSync(file)) return null;
  if (sips) {
    try {
      const jpg = path.join(tmp, path.basename(file).replace(/\.png$/, ".jpg"));
      execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", quality, file, "--out", jpg], { stdio: "ignore" });
      return `data:image/jpeg;base64,${fs.readFileSync(jpg).toString("base64")}`;
    } catch { sips = false; }
  }
  return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
}

/* ── cards: one per checklist row, each with one or more states ── */
const git = (...a) => { try { return execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim(); } catch { return "unknown"; } };
const commit = git("rev-parse", "--short", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const date = new Date().toISOString().slice(0, 10);
let captured = 0, missing = 0;

const sections = SECTIONS.map((name) => ({ name, cards: [] }));
for (const shot of SHOTS) {
  const section = sections.find((s) => s.name === shot.section);
  let card = section.cards.find((c) => c.id === shot.id);
  if (!card) section.cards.push((card = { id: shot.id, states: [] }));
  const cells = [];
  for (const vp of ["desktop", "phone"]) for (const theme of ["light", "dark"]) {
    const label = `${theme === "light" ? "Light" : "Dark"} · ${vp === "desktop" ? "1440×900" : "390×844"}`;
    if (!shot.viewports.includes(vp)) { cells.push({ vp, label, na: true }); continue; }
    const name = `${shot.id}__${shot.slug}__${theme}__${vp}.png`;
    const uri = dataUri(path.join(shotsDir, name));
    uri ? captured++ : missing++;
    cells.push({ vp, label, name, uri });
  }
  card.states.push({ shot, cells });
}

function stateHtml({ shot, cells }) {
  const only = shot.viewports.length === 1 ? shot.viewports[0] : null;
  const fig = (c) => c.na ? "" : `<figure class="shot ${c.vp}">${c.uri
    ? `<button type="button" class="zoom" aria-label="Enlarge: ${esc(shot.title)}, ${esc(c.label)}"><img loading="lazy" decoding="async" alt="${esc(shot.title)} — ${esc(c.label)}" src="${c.uri}"></button>`
    : `<div class="absent">Not captured<br><code>${esc(c.name)}</code></div>`}<figcaption>${esc(c.label)}</figcaption></figure>`;
  return `<section class="state"><h4>${esc(shot.title)}${only ? ` <span class="only">${only} only</span>` : ""}</h4><p class="look"><span class="k">Look at</span> ${esc(shot.look)}</p><div class="grid${only ? ` one ${only}` : ""}">${cells.map(fig).join("")}</div></section>`;
}

function cardHtml(card) {
  const row = rows.get(card.id);
  const ev = evidence.get(card.id);
  const b = boards.get(card.id);
  const status = ev?.status?.replace(/\*/g, "") ?? row?.status ?? "";
  const verify = [
    ...(captures.get(card.id) ?? []).map((t) => t.replace(/^board /, "Board ").replace(/\.?$/, ".")),
    b ? `Compare with ${b.map((x) => x.replace(/\b(\d{2})\b/g, (_, n) => boardName(n))).join("; ")} (docs/roadmap/workspace-experience/assets).` : "",
    ev?.note && /\[S\]/.test(ev.note) ? `Evidence log: ${ev.note}` : "",
    `Fail on ${failRule}.`,
  ].filter(Boolean);
  return `<article class="card" id="${card.id}" data-row="${card.id}">
<header><h3>${card.id}</h3>${status ? `<span class="status ${/needs-screenshot/.test(status) ? "flag" : ""}">${esc(status)}</span>` : ""}</header>
<div class="texts"><div><div class="k">Acceptance text</div><p>${row ? md(row.acceptance) : esc(SURFACE_TEXT[card.id] ?? "No checklist row.")}</p></div>
<div><div class="k">What to verify</div><p>${verify.map(md).join(" ")}</p></div></div>
${card.states.map(stateHtml).join("\n")}
<fieldset class="tick"><legend>${card.id} verdict</legend>
${["pass", "fail", "skip"].map((v) => `<label class="${v}"><input type="radio" name="v-${card.id}" id="v-${card.id}-${v}" value="${v}"> ${v[0].toUpperCase()}${v.slice(1)}</label>`).join("")}
<button type="button" class="clear" data-clear="${card.id}">Clear</button>
<label class="notes" for="n-${card.id}">Notes</label><textarea id="n-${card.id}" rows="1" placeholder="What is wrong, which shot"></textarea></fieldset>
</article>`;
}

const CSS = `
/* Layout: a contact sheet — sticky section rail on top, one bordered sheet per checklist row, shots on a neutral mat. */
:root{--bg:#f3f4f6;--sheet:#fcfcfd;--mat:#e6e8ec;--fg:#191c22;--muted:#5a6170;--line:#d3d7de;--accent:#2b63c9;--pass:#1d7a46;--fail:#b3261e;--skip:#8a6a00;--flag-bg:#fff1c9;--flag-fg:#6b4e00;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#111318;--sheet:#191c23;--mat:#0b0c10;--fg:#e7e9ee;--muted:#9aa2b1;--line:#2c313b;--accent:#7fa9f5;--pass:#5fcf8f;--fail:#ff8a80;--skip:#e0bd4f;--flag-bg:#3d3210;--flag-fg:#f1d98a;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#111318;--sheet:#191c23;--mat:#0b0c10;--fg:#e7e9ee;--muted:#9aa2b1;--line:#2c313b;--accent:#7fa9f5;--pass:#5fcf8f;--fail:#ff8a80;--skip:#e0bd4f;--flag-bg:#3d3210;--flag-fg:#f1d98a;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:15px/1.5 var(--sans);padding-inline:16px;padding-block:20px 64px}
.wrap{max-width:1500px;margin-inline:auto;display:flex;flex-direction:column;gap:20px}
h1{font-size:1.7rem;line-height:1.15;margin:0;letter-spacing:-.01em;text-wrap:balance}
h2{font-size:1.2rem;margin:0;padding-top:8px;text-wrap:balance}
h3{font:600 1rem var(--mono);margin:0}
h4{font-size:.98rem;margin:0}
p{margin:0}
code{font:0.86em var(--mono);background:var(--mat);padding:0 .25em;border-radius:3px}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-size:.86rem;font-variant-numeric:tabular-nums}
.meta b{color:var(--fg);font-weight:600}
.intro{max-width:72ch;color:var(--muted)}
nav.rail{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:var(--bg);border-bottom:1px solid var(--line);margin-inline:-16px;padding:8px 16px;display:flex;gap:6px;overflow-x:auto}
nav.rail a{flex:none;color:var(--fg);text-decoration:none;font-size:.82rem;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--sheet);white-space:nowrap}
nav.rail a:hover{border-color:var(--accent);color:var(--accent)}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.card{background:var(--sheet);border:1px solid var(--line);border-radius:6px;padding:16px;display:flex;flex-direction:column;gap:14px;scroll-margin-top:64px}
.card>header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.status{font-size:.74rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border:1px solid var(--line);border-radius:3px;padding:1px 6px}
.status.flag{background:var(--flag-bg);color:var(--flag-fg);border-color:transparent}
.texts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px 28px}
.texts>div{min-width:0}
.texts p{font-size:.9rem;overflow-wrap:anywhere}
.k{font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:600}
.state{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);padding-top:12px}
.look{font-size:.88rem;color:var(--muted);max-width:110ch}
.look .k{margin-right:6px}
.only{font:.72rem var(--sans);color:var(--muted);border:1px solid var(--line);border-radius:3px;padding:0 5px;margin-left:6px;font-weight:400}
.grid{display:grid;grid-template-columns:minmax(0,1440fr) minmax(0,1440fr) minmax(0,390fr) minmax(0,390fr);gap:10px;align-items:start}
.grid.one.desktop{grid-template-columns:repeat(2,minmax(0,1fr))}
.grid.one.phone{grid-template-columns:repeat(2,minmax(0,300px))}
.shot{margin:0;min-width:0;display:flex;flex-direction:column;gap:4px}
.shot .zoom{all:unset;display:block;cursor:zoom-in;background:var(--mat);border:1px solid var(--line);border-radius:3px;line-height:0}
.shot img{display:block;width:100%;height:auto;max-width:100%}
.shot.desktop img{aspect-ratio:1440/900}.shot.phone img{aspect-ratio:390/844}
figcaption{font-size:.74rem;color:var(--muted);font-variant-numeric:tabular-nums}
.absent{border:1px dashed var(--line);border-radius:3px;padding:18px 8px;text-align:center;color:var(--muted);font-size:.78rem;overflow-wrap:anywhere}
.tick{border:1px solid var(--line);border-radius:4px;margin:0;padding:8px 12px 10px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}
.tick legend{font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:600;padding:0 4px}
.tick label{display:inline-flex;align-items:center;gap:5px;font-weight:600;font-size:.9rem}
.tick .pass{color:var(--pass)}.tick .fail{color:var(--fail)}.tick .skip{color:var(--skip)}
.tick .notes{color:var(--muted);font-weight:400;font-size:.8rem}
.tick textarea{flex:1 1 260px;min-width:0;font:inherit;font-size:.88rem;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:4px 8px;resize:vertical}
button.clear,.export button{font:inherit;font-size:.82rem;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:3px 10px;cursor:pointer}
.card[data-verdict="pass"]{border-left:4px solid var(--pass)}.card[data-verdict="fail"]{border-left:4px solid var(--fail)}.card[data-verdict="skip"]{border-left:4px solid var(--skip)}
.export{background:var(--sheet);border:1px solid var(--line);border-radius:6px;padding:16px;display:flex;flex-direction:column;gap:10px}
.export textarea{width:100%;box-sizing:border-box;min-height:220px;font:.82rem/1.45 var(--mono);color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:10px}
.export .bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;color:var(--muted);font-size:.86rem}
#lightbox{position:fixed;inset:0;z-index:20;background:rgba(8,9,12,.92);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:8px;padding:calc(12px + env(safe-area-inset-top,0px)) 12px 12px;overflow:auto;cursor:zoom-out}
#lightbox img{max-width:none;width:auto;height:auto;flex:none;border:1px solid #444}
#lightbox.fit img{max-width:100%;max-height:calc(100% - 40px)}
#lightbox .cap{color:#e7e9ee;font-size:.84rem;flex:none;text-align:center}
@media (max-width:760px){.grid,.grid.one.desktop{grid-template-columns:minmax(0,1fr)}.grid .shot.phone{max-width:300px}.grid.one.phone{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

const JS = `
(function(){
  var KEY="prism-acceptance:"+document.getElementById("gallery").dataset.build, state={};
  try{state=JSON.parse(localStorage.getItem(KEY)||"{}")||{}}catch(e){state={}}
  function save(){try{localStorage.setItem(KEY,JSON.stringify(state))}catch(e){}}
  var cards=[].slice.call(document.querySelectorAll(".card")), out=document.getElementById("results");
  function render(){
    var n={pass:0,fail:0,skip:0}, lines=[];
    cards.forEach(function(card){
      var id=card.dataset.row, s=state[id]||{}; card.dataset.verdict=s.v||"";
      if(s.v) n[s.v]++;
      lines.push(id+"\\t"+(s.v||"—")+(s.n?"\\t"+s.n.replace(/\\s+/g," ").trim():""));
    });
    var build=document.getElementById("gallery").dataset;
    out.value="Prism acceptance shots — commit "+build.build+", captured "+build.date+", part "+build.part+"\\n"+
      "pass "+n.pass+" · fail "+n.fail+" · skip "+n.skip+" · unmarked "+(cards.length-n.pass-n.fail-n.skip)+" of "+cards.length+" rows\\n\\n"+lines.join("\\n")+"\\n";
    document.getElementById("tally").textContent=n.pass+" pass · "+n.fail+" fail · "+n.skip+" skip · "+(cards.length-n.pass-n.fail-n.skip)+" unmarked";
  }
  cards.forEach(function(card){
    var id=card.dataset.row, s=state[id]||{};
    var note=card.querySelector("textarea"); note.value=s.n||"";
    [].forEach.call(card.querySelectorAll("input[type=radio]"),function(r){
      r.checked=s.v===r.value;
      r.addEventListener("change",function(){state[id]=state[id]||{};state[id].v=r.value;save();render()});
    });
    note.addEventListener("input",function(){state[id]=state[id]||{};state[id].n=note.value;save();render()});
    card.querySelector("[data-clear]").addEventListener("click",function(){delete state[id];note.value="";[].forEach.call(card.querySelectorAll("input[type=radio]"),function(r){r.checked=false});save();render()});
  });
  render();
  document.getElementById("copy").addEventListener("click",function(){
    var done=function(){document.getElementById("copied").textContent="Copied"}, pick=function(){out.focus();out.select();document.getElementById("copied").textContent="Selected — press copy"};
    try{navigator.clipboard.writeText(out.value).then(done,pick)}catch(e){pick()}
  });
  var box=document.getElementById("lightbox"), big=box.querySelector("img"), cap=box.querySelector(".cap"), from=null;
  function close(){box.hidden=true;big.removeAttribute("src");if(from)from.focus();from=null}
  document.addEventListener("click",function(e){
    var z=e.target.closest&&e.target.closest(".zoom");
    if(z){var img=z.querySelector("img");from=z;big.src=img.src;big.alt=img.alt;cap.textContent=img.alt+" — click or Esc to close; click the image to switch between fit and full size";box.className="fit";box.hidden=false;box.scrollTop=0;return}
    if(!box.hidden){ if(e.target===big){box.classList.toggle("fit");e.stopPropagation()} else close() }
  });
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!box.hidden)close()});
})();
`;

function pageHtml(part, parts, list) {
  const rowsHere = list.reduce((n, s) => n + s.cards.length, 0);
  const flagged = list.reduce((n, s) => n + s.cards.filter((c) => /needs-screenshot/.test(evidence.get(c.id)?.status ?? rows.get(c.id)?.status ?? "")).length, 0);
  return `<title>Prism Acceptance Shots</title>
<style>${CSS}</style>
<div class="wrap" id="gallery" data-build="${esc(commit)}" data-date="${date}" data-part="${part} of ${parts}">
<header style="display:flex;flex-direction:column;gap:8px">
<h1>Prism acceptance shots</h1>
<div class="meta"><span>Commit <b>${esc(commit)}</b> (${esc(branch)})</span><span>Captured <b>${date}</b></span><span><b>${rowsHere}</b> rows on this page · <b>${flagged}</b> flagged needs-screenshot</span><span><b>${captured}</b> images in the set${missing ? ` · <b>${missing}</b> not captured` : ""}</span>${parts > 1 ? `<span>Part <b>${part}</b> of <b>${parts}</b></span>` : ""}</div>
<p class="intro">Notion-parity checklist §4 step 4. Each row shows its fixture state in light and dark at 1440×900 and 390×844. Click a shot to enlarge it. Mark each row pass, fail or skip; your marks stay in this browser and the block at the end turns them into text to paste back. Fixture pages use fictional data and the system font stack (the app's web fonts are not loaded offline), so judge layout, colour and spacing rather than the typeface.</p>
</header>
<nav class="rail" aria-label="Sections">${list.map((s, i) => `<a href="#s${i}">${esc(s.name)} <span style="color:var(--muted)">${s.cards.length}</span></a>`).join("")}<a href="#export">Export results</a></nav>
${list.map((s, i) => `<h2 id="s${i}" style="scroll-margin-top:64px">${esc(s.name)}</h2>\n${s.cards.map(cardHtml).join("\n")}`).join("\n")}
<section class="export" id="export" style="scroll-margin-top:64px"><h2 style="padding:0">Export results</h2>
<div class="bar"><span id="tally"></span><button type="button" id="copy">Copy text</button><span id="copied" role="status"></span></div>
<label class="k" for="results">One line per row: id, verdict, notes</label>
<textarea id="results" readonly spellcheck="false"></textarea></section>
</div>
<div id="lightbox" hidden role="dialog" aria-label="Enlarged screenshot"><div class="cap"></div><img alt=""></div>
<script>${JS}</script>
`;
}

/* ── write, splitting by section when one page would be too large ── */
const used = sections.filter((s) => s.cards.length);
const size = (list) => Buffer.byteLength(pageHtml(1, 1, list));
let parts = [used];
if (size(used) > maxBytes) {
  parts = [[]];
  for (const s of used) {
    const cur = parts[parts.length - 1];
    if (cur.length && size([...cur, s]) > maxBytes) parts.push([s]); else cur.push(s);
  }
}
const base = outFile.replace(/\.html$/, "");
for (const stale of fs.readdirSync(path.dirname(outFile))) if (new RegExp(`^${path.basename(base)}(-\\d+)?\\.html$`).test(stale)) fs.rmSync(path.join(path.dirname(outFile), stale));
parts.forEach((list, i) => {
  const file = parts.length === 1 ? outFile : `${base}-${i + 1}.html`;
  const html = pageHtml(i + 1, parts.length, list);
  fs.writeFileSync(file, html);
  const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
  console.log(`${file}  ${mb} MB  ${list.map((s) => s.name).join(" | ")}${Buffer.byteLength(html) > maxBytes ? "  (one section alone exceeds the limit — lower --quality)" : ""}`);
});
console.log(`${captured} images embedded, ${missing} missing; ${used.reduce((n, s) => n + s.cards.length, 0)} rows; ${sips ? `JPEG q${quality}` : "PNG (sips unavailable)"}`);
fs.rmSync(tmp, { recursive: true, force: true });
