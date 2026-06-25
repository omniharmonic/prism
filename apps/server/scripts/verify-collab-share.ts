/**
 * Collab share-link verification across note KINDS × permission LEVELS.
 * Companion to verify-gateway.ts; needs the live server (pm2 prism-server) up.
 *
 *   cd apps/server && node --env-file=.env --import tsx scripts/verify-collab-share.ts
 *
 * Checks three layers that have each broken before:
 *   1. KIND agreement — client `inferContentType` and server `noteKind` must
 *      classify a note identically, or one side seeds/persists a structure the
 *      other never reads (e.g. a canvas saved as `<p></p>`, a `.html` note the
 *      client renders as a doc but the server stored as raw code).
 *   2. PERMISSION gating — a per-level capability resolves to that level and the
 *      connection is read-only below "suggest"; anon is rejected.
 *   3. SEEDING — connecting a live collab client populates the right Yjs field.
 *
 * If `playwright` is installed (it isn't a repo dep), a 4th RENDER layer loads
 * each share URL headless and asserts the editor mounts (the "black page" class).
 */
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import WebSocket from "ws";
import { vault } from "../src/parachute";
import { addGrant, removeGrant, type Grant } from "../src/db";
import { signCapability } from "../src/auth/capability";
import { authorizeConnection, noteKind } from "../src/collab";
import { inferContentType } from "@prism/core/content-types";
import { config } from "../src/config";

const BASE = `http://localhost:${config.port}`;
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = "") => { console.log(`${c ? "✅" : "❌"} ${n}${extra ? ` — ${extra}` : ""}`); c ? pass++ : fail++; };
const expectReadOnly = (l: string) => l === "view" || l === "comment";
const LEVELS = ["view", "comment", "suggest", "edit"] as const;

const CANVAS = '{"elements":[{"id":"r1","type":"rectangle","x":80,"y":80,"width":120,"height":80,"version":1,"versionNonce":1,"index":"a0","seed":1,"angle":0,"strokeColor":"#000","backgroundColor":"transparent","fillStyle":"solid","strokeWidth":1,"roughness":1,"opacity":100,"groupIds":[],"frameId":null,"roundness":null,"boundElements":[],"updated":1,"link":null,"locked":false,"isDeleted":false}],"appState":{}}';
const CASES = [
  { kind: "document", path: "_test/share/doc.md", metadata: { type: "document" }, content: "# Title\n\nbody", sel: ".ProseMirror", field: "default" },
  { kind: "code", path: "_test/share/code.ts", metadata: { type: "code" }, content: "export const a = 1;\n", sel: ".cm-editor", field: "codemirror" },
  { kind: "spreadsheet", path: "_test/share/sheet.csv", metadata: {}, content: "a,b\n1,2", sel: "table", field: "rows" },
  { kind: "canvas", path: "_test/share/board.excalidraw", metadata: { type: "canvas" }, content: CANVAS, sel: ".excalidraw", field: "elements" },
  // Previously divergent extensions (must agree):
  { kind: "document", path: "_test/share/page.html", metadata: {}, content: "<h1>hi</h1>", sel: ".ProseMirror", field: "default" },
  { kind: "spreadsheet", path: "_test/share/book.xlsx", metadata: {}, content: "x,y\n1,2", sel: "table", field: "rows" },
];

const created: string[] = [];
const grants: Grant[] = [];
const mint = (id: string, level: string) => {
  const capId = `cap-share-${id}-${level}`.replace(/[^a-zA-Z0-9-]/g, "");
  grants.push(addGrant({ subject_type: "link", subject: capId, resource_type: "note", resource: id, level: level as never, created_by: "verify-share" }));
  return signCapability({ id: capId, exp: Date.now() + 3_600_000 });
};

async function main() {
  console.log("=== 1. kind agreement (client inferContentType vs server noteKind) ===");
  for (const c of CASES) {
    const note = await vault.createNote({ content: c.content, path: c.path, metadata: c.metadata });
    created.push(note.id);
    (c as any)._id = note.id;
    const t = inferContentType({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
    const clientKind = t === "canvas" || t === "code" || t === "spreadsheet" ? t : "document";
    const serverKind = noteKind({ path: note.path, tags: note.tags, metadata: note.metadata, content: note.content });
    ok(`${c.path}: client=${clientKind} server=${serverKind} (expect ${c.kind})`, clientKind === serverKind && serverKind === c.kind);
  }

  console.log("\n=== 2. permission gating per level ===");
  for (const c of CASES) {
    const id = (c as any)._id as string;
    for (const lvl of LEVELS) {
      const cc = { readOnly: false };
      try {
        const got = await authorizeConnection(id, mint(id, lvl), null, cc, false);
        ok(`${c.kind} @ ${lvl}: level=${got} readOnly=${cc.readOnly}`, got === lvl && cc.readOnly === expectReadOnly(lvl));
      } catch (e) { ok(`${c.kind} @ ${lvl}`, false, (e as Error).message); }
    }
    try { await authorizeConnection(id, "", null, { readOnly: false }, false); ok(`${c.kind} @ anon: rejected`, false, "did not throw"); }
    catch { ok(`${c.kind} @ anon: rejected`, true); }
  }

  console.log("\n=== 3. live seeding (right Yjs field populates) ===");
  for (const c of CASES) {
    const id = (c as any)._id as string;
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: BASE.replace(/^http/, "ws") + "/collab",
      name: id,
      token: config.collabToken || config.parachuteToken || "",
      document: doc,
      // @ts-expect-error WebSocketPolyfill is accepted at runtime (node has no global WebSocket)
      WebSocketPolyfill: WebSocket,
    });
    await new Promise<void>((res) => { let d = false; const done = () => { if (!d) { d = true; res(); } }; provider.on("synced", done); setTimeout(done, 4000); });
    const xml = doc.getXmlFragment("default").length, code = doc.getText("codemirror").length, rows = doc.getArray("rows").length, els = doc.getMap("elements").size;
    const got = c.field === "default" ? xml > 0 : c.field === "codemirror" ? code > 0 : c.field === "rows" ? rows > 0 : els > 0;
    ok(`${c.path}: seeds ${c.field}`, got, `xml=${xml} code=${code} rows=${rows} els=${els}`);
    provider.destroy();
  }

  // 4. optional render layer (skipped unless `playwright` is installed)
  const pwName = "playwright";
  let chromium: any = null;
  try { chromium = (await import(pwName)).chromium; } catch { /* not installed */ }
  if (!chromium) { console.log("\n=== 4. render: SKIPPED (playwright not installed) ==="); return; }
  console.log("\n=== 4. render (headless): editor mounts, no page crash ===");
  const browser = await chromium.launch({ headless: true });
  try {
    for (const c of CASES) {
      const id = (c as any)._id as string;
      for (const lvl of c.kind === "document" ? ["edit", "suggest", "comment", "view"] : ["edit", "view"]) {
        const url = `${BASE}/collab/${encodeURIComponent(id)}?t=${encodeURIComponent(mint(id, lvl))}`;
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const errs: string[] = [];
        page.on("pageerror", (e: Error) => errs.push(e.message));
        let mounted = false;
        try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }); await page.waitForSelector(c.sel, { timeout: 12000, state: "attached" }); mounted = true; } catch { /* */ }
        const body = await page.evaluate("document.body && document.body.innerText ? document.body.innerText.length : 0").catch(() => 0);
        const fatal = errs.filter((e) => !/ResizeObserver|Failed to load resource|favicon/i.test(e));
        ok(`${c.kind} @ ${lvl}: render ${c.sel}`, mounted && body > 0 && fatal.length === 0, fatal[0] ?? "");
        await ctx.close();
      }
    }
  } finally { await browser.close(); }
}

main()
  .catch((e) => { console.error("ERROR:", e); fail++; })
  .finally(async () => {
    for (const g of grants) try { removeGrant(g.id); } catch { /* */ }
    for (const id of created) try { await vault.deleteNote(id); } catch { /* */ }
    console.log(`\n=== ${pass} passed, ${fail} failed (cleaned ${grants.length} grants, ${created.length} notes) ===`);
    process.exit(fail === 0 ? 0 : 1);
  });
