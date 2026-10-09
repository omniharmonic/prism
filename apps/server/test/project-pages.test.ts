/**
 * Project pages on the document surface (Phase 0).
 *
 * A note tagged `project` (`vault/projects/<slug>/PROJECT`) now opens in the ordinary
 * document editor, so it is live-editable for the first time. Pinned here:
 *
 *  - the collab KIND of a project note is `document` (the client's `detectKind` is the
 *    same function over the same `inferContentType`: a mismatch corrupts the note);
 *  - a container-named note is titled by `metadata.title` → `metadata.name` → its
 *    folder, and the tree carries that name;
 *  - a ~53,000-character MARKDOWN body (the largest production project page) opens
 *    through the conversion worker, and merely opening it writes NOTHING to the vault;
 *  - the first real edit stores the page as HTML with the whole body in it.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import * as Y from "yjs";
import WebSocket from "ws";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { COLLAB_SCHEMA_VERSION } from "@prism/core/editor-schema";
import { containerTitle, humanizeSlug, isContainerPath, pageTitle } from "@prism/core/pages";
import { noteLinkTitle, buildWikilinkIndex, resolveWikilink } from "@prism/core/wikilinks";
import { attachCollab, hocuspocus, noteKind, resetReconcileState } from "../src/collab";
import { conversionRefusal } from "../src/convert/service";
import { api } from "../src/routes/api";
import { ensureUser } from "../src/db";
import { issueDeviceToken } from "../src/auth/device";
import { resetTreeForTests } from "../src/tree";
import { installFakeVault, resetDb, makeSession, sessionCookie, grantUser, type FakeVault } from "./helpers";

const PROJECT_PATH = "vault/projects/bioregional-food-chain/PROJECT";

// ── kind + title (pure) ──────────────────────────────────────────────────────

test("a project note is a `document` for collaboration, however it is typed", () => {
  assert.equal(noteKind({ path: PROJECT_PATH, tags: ["project"], metadata: null }), "document");
  assert.equal(noteKind({ path: PROJECT_PATH, tags: ["project"], metadata: { type: "project" } }), "document");
  assert.equal(noteKind({ path: PROJECT_PATH, tags: null, metadata: { prism_type: "project" } }), "document");
  assert.equal(noteKind({ path: PROJECT_PATH, tags: ["project"], metadata: null, content: "# Plan\n\n**bold** [[link]]" }), "document");
});

test("a container-named note is titled by title → name → its folder; other pages by their file", () => {
  assert.equal(pageTitle(PROJECT_PATH), "Bioregional food chain");
  assert.equal(pageTitle(PROJECT_PATH, { name: "Bioregional Food Chain" }), "Bioregional Food Chain");
  assert.equal(pageTitle(PROJECT_PATH, { title: "Food Chain", name: "ignored" }), "Food Chain");
  assert.equal(pageTitle(PROJECT_PATH, { title: "   ", name: " " }), "Bioregional food chain");
  assert.equal(pageTitle("vault/projects/prism/README.md"), "Prism");
  assert.equal(pageTitle("docs/guides/index"), "Guides");
  assert.equal(humanizeSlug("food-chain_v2"), "Food chain v2");
  assert.equal(humanizeSlug("OpenCivics"), "OpenCivics", "a name with capitals is already a title");
  assert.equal(humanizeSlug("Food Chain"), "Food Chain");
  // Not containers: an ordinary page, a page somebody titled "Project", a top-level README.
  for (const p of ["vault/Projects/Prism/Plan", "vault/Work/Project", "vault/Work/Index", "vault/README", "README", "vault/projects/x/PROJECT/notes"]) {
    assert.equal(isContainerPath(p), false, p);
    assert.equal(containerTitle(p, { title: "T" }), null, p);
  }
  assert.equal(pageTitle("vault/Work/Project"), "Project");
  assert.equal(pageTitle("vault/Projects/Prism/Plan v1.5"), "Plan v1.5");
});

test("tabs and link chips use the same name; what `[[…]]` resolves by is unchanged", () => {
  const note = { id: "p1", path: PROJECT_PATH, metadata: null };
  assert.equal(noteLinkTitle(note), "Bioregional food chain");
  assert.equal(noteLinkTitle({ ...note, metadata: { name: "BFC" } }), "BFC");
  assert.equal(noteLinkTitle({ id: "x", path: "vault/Plan", metadata: null }), "Plan");
  const index = buildWikilinkIndex([note, { id: "p2", path: "vault/projects/other/PROJECT", metadata: null }]);
  // The display name is not a new link target (it would change what the server's link job writes).
  assert.equal(resolveWikilink("Bioregional food chain", index).kind, "none");
  assert.equal(resolveWikilink("PROJECT", index).kind, "ambiguous");
  assert.equal(resolveWikilink("projects/bioregional-food-chain/PROJECT", index).kind, "match");
});

// ── the tree carries the name ────────────────────────────────────────────────

test("tree: a container-named page with no title is emitted with its `name`; other notes never are", async () => {
  resetDb();
  resetTreeForTests();
  const vault = installFakeVault();
  process.env.TREE_SUBSCRIBE = "0";
  try {
    vault.put({ id: "p1", path: PROJECT_PATH, content: "", tags: ["project"], metadata: { name: "Bioregional Food Chain" } });
    vault.put({ id: "p2", path: "vault/projects/prism/PROJECT", content: "", tags: ["project"], metadata: { title: "Prism", name: "ignored" } });
    vault.put({ id: "p3", path: "vault/projects/bare/PROJECT", content: "", tags: ["project"], metadata: null });
    vault.put({ id: "ada", path: "vault/people/Ada Park", content: "", tags: ["person"], metadata: { name: "Ada P." } });
    const r = await api.request("/tree", { headers: { cookie: sessionCookie(makeSession("owner@test.local")) } });
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    const by = (id: string) => rows.find((e) => e.id === id)!;
    assert.equal(by("p1").title, "Bioregional Food Chain");
    assert.equal(by("p2").title, "Prism");
    assert.ok(!("title" in by("p3")), "no stored name: the client derives it from the folder");
    assert.ok(!("title" in by("ada")), "`name` is read for container-named pages only");
  } finally {
    vault.restore();
    resetTreeForTests();
  }
});

// ── a 53k Markdown body on the live socket ───────────────────────────────────

/** ~53,000 characters of ordinary project Markdown: headings, emphasis, wikilinks, lists, a table. */
function largeMarkdown(): string {
  const parts: string[] = ["# Bioregional Food Chain\n", "**Status:** active — see [[projects/watershed-council/PROJECT|Watershed Council]].\n"];
  for (let i = 1; parts.join("\n").length < 53_000; i++) {
    parts.push(
      `## Section ${i}\n`,
      `This is paragraph ${i} of the plan. It has **bold text**, *emphasis*, \`code\`, a [link](https://example.test/${i}) and a wikilink to [[Meeting ${i}]]. `.repeat(3) + "\n",
      `- [ ] Task ${i}.1 for [[Ada Park]]\n- [x] Task ${i}.2 done\n- A plain item with **weight**\n`,
      `| Field | Value |\n| --- | --- |\n| Row ${i} | **${i * 3}** |\n`,
      `> A quoted note for section ${i}.\n`,
    );
  }
  return parts.join("\n");
}

const EDITOR = "editor@test.local";
let fv: FakeVault;
let server: Server;
let base: string;
const sockets = new Set<Socket>();
const providers: HocuspocusProvider[] = [];

async function startCollab() {
  resetDb();
  resetReconcileState();
  fv = installFakeVault();
  server = createServer();
  server.on("connection", (s: Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  attachCollab(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
  ensureUser(EDITOR);
  grantUser(EDITOR, "tag", "project", "edit");
}
async function stopCollab() {
  for (const p of providers.splice(0)) p.destroy();
  hocuspocus.closeConnections();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => server.close(() => r()));
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  fv.restore();
}
let live = false;
beforeEach(() => { live = false; });
afterEach(async () => { if (live) await stopCollab(); });

function open(name: string): Promise<{ outcome: string; provider: HocuspocusProvider; doc: Y.Doc; ms: number }> {
  const doc = new Y.Doc();
  const started = Date.now();
  const provider = new HocuspocusProvider({
    url: `${base}?schema=${COLLAB_SCHEMA_VERSION}`, name, token: issueDeviceToken(EDITOR, "test", "prism-native").token, document: doc, awareness: null,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime (node has no global WebSocket)
    WebSocketPolyfill: WebSocket,
  });
  providers.push(provider);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no outcome in 20 s")), 20_000);
    provider.on("synced", () => { clearTimeout(t); resolve({ outcome: "synced", provider, doc, ms: Date.now() - started }); });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => { clearTimeout(t); resolve({ outcome: reason, provider, doc, ms: Date.now() - started }); });
  });
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vaultWrites = () => fv.calls.filter((c) => c.method === "PATCH" || c.method === "PUT");

test("a 53k Markdown project body is within every conversion limit", () => {
  const body = largeMarkdown();
  assert.ok(body.length >= 53_000 && body.length < 60_000, String(body.length));
  assert.equal(conversionRefusal(body, true), null, "the pre-check refuses nothing: it goes to the conversion worker (over the 24 KB inline cap)");
});

test("opening a 53k Markdown project page live loads the whole body and writes nothing", { timeout: 60_000 }, async () => {
  await startCollab();
  live = true;
  const body = largeMarkdown();
  fv.put({ id: "proj", path: PROJECT_PATH, content: body, tags: ["project"], metadata: { status: "active" } });
  const reader = await open("proj");
  assert.equal(reader.outcome, "synced");
  console.log(`[project-pages] 53k Markdown body (${body.length} chars) opened live in ${reader.ms} ms`);
  const text = reader.doc.getXmlFragment("default").toString();
  assert.ok(text.includes("Bioregional Food Chain") && text.includes("paragraph 1 of the plan"), "the start of the body is in the document");
  const sections = body.match(/^## Section \d+/gm)!.length;
  assert.ok(text.includes(`Section ${sections}`), "…and so is its last section");
  assert.ok(!text.includes("**bold text**"), "Markdown was converted, not shown as typed");
  await settle(400);
  reader.provider.destroy();
  await settle(300);
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  await settle(300);
  assert.equal(vaultWrites().length, 0, "no vault write (and so no history version) from merely opening");
  assert.equal(fv.notes.get("proj")!.content, body, "the stored Markdown is byte-for-byte what it was");
});

test("the editor's own trailing empty paragraph is not an edit: nothing is written, Markdown stays Markdown", { timeout: 60_000 }, async () => {
  await startCollab();
  live = true;
  // Ends in a table: every editor that opens it appends an empty paragraph (TipTap's trailing node).
  const body = "# Plan\n\n**Status:** active\n\n- [ ] Open task\n\n| Field | Value |\n| --- | --- |\n| Lead | **Ada** |\n";
  fv.put({ id: "proj", path: PROJECT_PATH, content: body, tags: ["project"], metadata: { status: "active" } });
  const first = await open("proj");
  assert.equal(first.outcome, "synced");
  first.doc.getXmlFragment("default").push([new Y.XmlElement("paragraph")]);
  await settle(500);
  hocuspocus.flushPendingStores();
  await settle(800);
  assert.equal(vaultWrites().length, 0, "the trailing paragraph alone writes nothing");
  // Closing and opening again (the snapshot now holds that paragraph) is still not an edit.
  first.provider.destroy();
  await settle(300);
  hocuspocus.flushPendingStores();
  for (const d of [...hocuspocus.documents.values()]) await hocuspocus.unloadDocument(d);
  await settle(300);
  const second = await open("proj");
  assert.equal(second.outcome, "synced");
  second.doc.getXmlFragment("default").push([new Y.XmlElement("paragraph")]);
  await settle(500);
  hocuspocus.flushPendingStores();
  await settle(800);
  assert.equal(vaultWrites().length, 0);
  assert.equal(fv.notes.get("proj")!.content, body, "the stored Markdown is byte-for-byte what it was");
  // A real edit is stored as always — and so is everything after it.
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("Typed.")]);
  second.doc.getXmlFragment("default").push([p]);
  await settle(500);
  hocuspocus.flushPendingStores();
  for (let i = 0; i < 100 && fv.notes.get("proj")!.content === body; i++) await settle(100);
  const stored = fv.notes.get("proj")!.content;
  assert.ok(stored.startsWith("<") && stored.includes("Typed.") && stored.includes("<strong>Status:</strong>") && stored.includes("Ada"), stored.slice(0, 200));
  // Deleting it again is an edit too (the document is no longer the one that was opened).
  const frag = second.doc.getXmlFragment("default");
  frag.delete(frag.length - 1, 1);
  await settle(500);
  hocuspocus.flushPendingStores();
  for (let i = 0; i < 100 && fv.notes.get("proj")!.content.includes("Typed."); i++) await settle(100);
  assert.ok(!fv.notes.get("proj")!.content.includes("Typed."), "a later change back is written like any other");
});

test("the first edit of a Markdown project page stores it as HTML with the whole body kept", { timeout: 60_000 }, async () => {
  await startCollab();
  live = true;
  const body = largeMarkdown();
  fv.put({ id: "proj", path: PROJECT_PATH, content: body, tags: ["project"], metadata: { status: "active" } });
  const writer = await open("proj");
  assert.equal(writer.outcome, "synced");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("A line typed in the live editor.")]);
  writer.doc.getXmlFragment("default").push([p]);
  await settle(600);
  hocuspocus.flushPendingStores();
  for (let i = 0; i < 100 && fv.notes.get("proj")!.content === body; i++) await settle(100);
  const stored = fv.notes.get("proj")!;
  assert.notEqual(stored.content, body, "the edit reached the vault");
  assert.ok(stored.content.trimStart().startsWith("<"), "a live document is persisted as HTML");
  assert.ok(stored.content.includes("A line typed in the live editor."));
  const sections = body.match(/^## Section \d+/gm)!.length;
  for (const want of ["Bioregional Food Chain", "paragraph 1 of the plan", `Section ${sections}`, "<strong>bold text</strong>", "Task 1.1"]) assert.ok(stored.content.includes(want), want);
  assert.equal(stored.path, PROJECT_PATH, "the path is untouched");
  assert.equal(stored.metadata?.status, "active", "properties are untouched");
});
