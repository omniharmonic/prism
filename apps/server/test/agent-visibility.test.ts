/**
 * Visibility of agent changes (2026-10, fix "agent-visibility"):
 *  1. the vault MERGES metadata, so a person's writer stamp survives a later
 *     write that carries none (vault MCP, Hermes, a routine, a sync). A stamp is
 *     believed only when it was made within 10 s of the state it sits on —
 *     otherwise the state reads as `external` ("Changed outside Prism");
 *  2. a version row's provenance (`via`) describes the change that REPLACED it,
 *     so the change that produced row i is row i+1's;
 *  3. an external edit folded into a live document is stored as `external`,
 *     never under the last typist's name;
 *  4. agent sessions record notes touched through the Prism MCP tools too.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { api } from "../src/routes/api";
import { resetTreeForTests } from "../src/tree";
import { resetPagesForTests } from "../src/pages";
import { addGrant, setAccount, setUserProfile } from "../src/db";
import * as collab from "../src/collab";
import { loadDocumentState, noteCollabWriter, reconcileLoadedDocs, resetReconcileState, storeDocumentState, yDocToDocJson } from "../src/collab";
import { stopConversionWorkers } from "../src/convert/service";
import { changeKindOf, changeValue, externalStamp, stampIsStale, versionWriter } from "../src/sharing";
import { writerIdFor } from "../src/writer-stamp";
import { normalizeStream, prismToolName, touchedNotes, type AgentEvent } from "../src/agent-events";
import { installFakeVault, resetDb, makeSession, sessionCookie, type FakeVault } from "./helpers";

let fv: FakeVault;
const OWNER = "owner@test.local";
const BOB = "bob@test.local";

beforeEach(() => {
  resetDb();
  resetTreeForTests();
  resetPagesForTests();
  resetReconcileState();
  (collab as unknown as Record<string, (() => void) | undefined>).resetConversionState?.();
  fv = installFakeVault();
  setAccount(BOB, BOB, "hash");
  setUserProfile(OWNER, { name: "Olive Owner" });
  setUserProfile(BOB, { name: "Bob Builder" });
});
afterEach(() => {
  fv.restore();
  resetTreeForTests();
});
after(async () => {
  await stopConversionWorkers();
});

const stamped = (email: string, kind: "edit" | "agent", at: string) => ({
  prism_last_writer: writerIdFor(email),
  prism_last_write_at: at,
  prism_last_change: changeValue(kind, at),
});
const as = (email: string) => sessionCookie(makeSession(email));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json();

// ── 1. stale stamps ──────────────────────────────────────────────────────────

test("a stamp made long before the state it sits on reads as external, not as the earlier person", () => {
  const meta = stamped(BOB, "edit", "2026-01-02T00:00:00.000Z");
  // Produced within the tolerance: the stamp describes this write.
  assert.deepEqual(versionWriter(meta, null, BOB, undefined, "2026-01-02T00:00:08.000Z"), { kind: "person", name: "Bob Builder", self: true });
  // Produced an hour later by a write that carried no stamp.
  assert.deepEqual(versionWriter(meta, null, BOB, undefined, "2026-01-02T01:00:00.000Z"), { kind: "external", name: null, self: false });
  // …through the vault's MCP channel: an agent, still never Bob.
  assert.deepEqual(versionWriter(meta, "mcp", BOB, undefined, "2026-01-02T01:00:00.000Z"), { kind: "agent", name: null, self: false });
  // Unknown production time: no claim either way.
  assert.equal(versionWriter(meta, null, BOB).kind, "person");
  assert.equal(stampIsStale(meta, null), false);
  assert.equal(stampIsStale(meta, "garbage"), false);
});

test("an external stamp (collab fold) reads as external and names nobody", () => {
  const meta = externalStamp();
  assert.equal(meta.prism_last_writer, null, "the writer key is cleared (null deletes it in the vault)");
  assert.equal(changeKindOf(meta), "external");
  assert.deepEqual(versionWriter(meta, null, BOB, undefined, meta.prism_last_write_at), { kind: "external", name: null, self: false });
});

test("non-owner history: a row produced by an unstamped write is external; the producer is the NEXT-OLDER row", async () => {
  fv.put({ id: "pg", path: "vault/Notes/Agenda", content: "<p>v3</p>", metadata: stamped(BOB, "edit", "2026-06-01T00:00:00.000Z"), updatedAt: "2026-06-01T09:00:00.000Z" });
  addGrant({ subject_type: "user", subject: BOB, resource_type: "note", resource: "pg", level: "edit", created_by: OWNER });
  const meta = stamped(BOB, "edit", "2026-06-01T00:00:00.000Z");
  // Stored newest LAST (the fake serves them newest first). Row ix 1's state (Bob's
  // stamp still on it) was produced by the change recorded on row ix 0 — a vault MCP
  // write an hour after Bob's stamp. Row ix 1 was replaced by an api write.
  fv.versions.set("pg", [
    { note_id: "pg", version_ix: 0, content: "<p>v1</p>", path: "vault/Notes/Agenda", metadata: meta, superseded_at: "2026-06-01T01:00:02.000Z", op: "update", content_len: 9, actor: "agent-session:1234", via: "mcp" },
    { note_id: "pg", version_ix: 1, content: "<p>v2</p>", path: "vault/Notes/Agenda", metadata: meta, superseded_at: "2026-06-01T09:00:00.000Z", op: "update", content_len: 9, actor: "hub-user-owner", via: "api" },
  ] as never);
  const r = await json(await api.request("/notes/pg/versions", { headers: { cookie: as(BOB) } }));
  assert.equal(r.versions.length, 2);
  const [newest, oldest] = r.versions;
  assert.equal(newest.version_ix, 1);
  // Produced at 01:00:02 by an MCP write → agent, never "Bob".
  assert.deepEqual(newest.writer, { kind: "agent", name: null, self: false });
  // The oldest row on the page: its producer is unknown, so its own stamp stands.
  assert.deepEqual(oldest.writer, { kind: "person", name: "Bob Builder", self: true });
  assert.ok(!("actor" in newest) && !("via" in newest), "vault provenance never reaches a non-owner");
  assert.ok(!JSON.stringify(r).includes("agent-session"), "no actor label for non-owners");

  // The current note: Bob's stamp is 9 h older than the note → changed outside Prism.
  const act = await json(await api.request("/notes/pg/activity", { headers: { cookie: as(BOB) } }));
  assert.deepEqual(act.lastEditor, { kind: "external", name: null, self: false });
});

// ── 3. collab fold ───────────────────────────────────────────────────────────

const T0 = "2026-03-01T00:00:00.000Z";
const text = (doc: Y.Doc) => JSON.stringify(yDocToDocJson(doc));
function type(doc: Y.Doc, words: string): void {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(words)]);
  const frag = doc.getXmlFragment("default");
  frag.insert(frag.length, [p]);
}

test("collab: an external edit folded into a live doc is stored as external, not under the last typist's name", { timeout: 60_000 }, async () => {
  fv.put({ id: "lv", tags: ["garden"], content: "<p>start</p>", updatedAt: T0 });
  const doc = await loadDocumentState("lv", new Y.Doc());
  type(doc, "bob typed");
  noteCollabWriter("lv", BOB, "edit");
  await storeDocumentState("lv", doc);
  assert.equal(fv.notes.get("lv")!.metadata?.prism_last_writer, writerIdFor(BOB));

  type(doc, "bob unsaved"); // before the fold: Bob's typing is not the latest change
  noteCollabWriter("lv", BOB, "edit");
  // An agent writes to the vault directly (no stamp; the vault keeps Bob's).
  const n = fv.notes.get("lv")!;
  fv.put({ ...n, content: `${n.content}<p>AGENT LINE</p>`, updatedAt: new Date(Date.now() + 60_000).toISOString() });
  await reconcileLoadedDocs({ documents: new Map([["lv", doc]]) });
  assert.match(text(doc), /AGENT LINE/);
  await storeDocumentState("lv", doc);
  const meta = fv.notes.get("lv")!.metadata!;
  assert.match(fv.notes.get("lv")!.content, /AGENT LINE/);
  assert.ok(!("prism_last_writer" in meta), "Bob's stamp is not left on the merged body");
  assert.equal(changeKindOf(meta), "external");

  // A person typing AFTER the fold is the latest change again.
  type(doc, "bob after");
  noteCollabWriter("lv", BOB, "edit");
  await storeDocumentState("lv", doc);
  assert.equal(fv.notes.get("lv")!.metadata?.prism_last_writer, writerIdFor(BOB));
  assert.equal(changeKindOf(fv.notes.get("lv")!.metadata), "edit");
});

// ── 4. note_touched for Prism MCP tools ──────────────────────────────────────

const line = (o: unknown) => JSON.stringify(o);
function turnWith(tool: string, input: unknown, result: unknown): string {
  return [
    line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: tool, input }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: JSON.stringify(result) }] }] } }),
  ].join("\n");
}
const touched = (evs: AgentEvent[]) => evs.filter((e) => e.t === "note_touched");

test("note_touched: Prism MCP write tools are recognised like the vault's", () => {
  assert.equal(prismToolName("mcp__prism__prism_update_note"), "prism_update_note");
  assert.equal(prismToolName("mcp__parachute-vault__update-note"), null);
  assert.deepEqual(touched(normalizeStream(turnWith("mcp__prism__prism_update_note", { id: "n-7", content: "x", if_updated_at: T0 }, { id: "n-7" }))), [
    { t: "note_touched", noteId: "n-7", op: "update" },
  ]);
  assert.deepEqual(touched(normalizeStream(turnWith("mcp__prism__prism_create_note", { content: "x", tags: [] }, { id: "n-new", path: "vault/x" }))), [
    { t: "note_touched", noteId: "n-new", op: "create" },
  ]);
  assert.deepEqual(touched(normalizeStream(turnWith("mcp__prism__prism_delete_note", { id: "gone" }, { ok: true, id: "gone" }))), [
    { t: "note_touched", noteId: "gone", op: "delete" },
  ]);
  for (const t of ["prism_restore_version", "prism_suggest_edit", "prism_add_comment", "prism_sheet_update"]) {
    assert.deepEqual(touchedNotes(t, { id: "p1" }, null), [{ noteId: "p1", op: "update" }], t);
  }
  // Read tools touch nothing.
  assert.deepEqual(touched(normalizeStream(turnWith("mcp__prism__prism_get_note", { id: "n-7" }, { id: "n-7" }))), []);
});

// ── client ⇄ server agreement (@prism/core writerOf) ─────────────────────────

test("client writerOf agrees with server versionWriter on stale, external and fresh stamps", async () => {
  const { writerOf, withSource, sourceLabel, producerOf, lastEditedBy, writerTitle } = await import("../../../packages/core/src/lib/history/attribution");
  const me = writerIdFor(BOB);
  const dir = { names: { [me]: "Bob Builder" }, me };
  const cases: Array<[Record<string, unknown> | null, string | null, string | undefined]> = [
    [stamped(BOB, "edit", "2026-01-02T00:00:00.000Z"), null, "2026-01-02T00:00:05.000Z"],
    [stamped(BOB, "edit", "2026-01-02T00:00:00.000Z"), null, "2026-01-02T05:00:00.000Z"],
    [stamped(BOB, "edit", "2026-01-02T00:00:00.000Z"), "mcp", "2026-01-02T05:00:00.000Z"],
    [stamped(BOB, "agent", "2026-01-02T00:00:00.000Z"), null, "2026-01-02T00:00:01.000Z"],
    [externalStamp(), null, undefined],
    [null, "mcp", undefined],
    [null, null, undefined],
  ];
  for (const [meta, via, producedAt] of cases) {
    const server = versionWriter(meta, via, BOB, undefined, producedAt);
    const client = writerOf({ metadata: meta, via, producedAt }, dir);
    assert.deepEqual(client, server, JSON.stringify({ meta, via, producedAt }));
  }
  assert.equal(writerTitle({ kind: "external", name: null, self: false }), "Changed outside Prism");
  // Owner-only provenance: shortened, attached only where no person is named.
  const rows = [{ actor: "nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqqq", via: "mcp" }, { actor: "hub-user-owner", via: "api" }];
  assert.equal(sourceLabel(rows[0]), "nostr:npub1qqqqq… via mcp");
  assert.equal(producerOf(rows, -1), rows[0]);
  assert.equal(producerOf(rows, 0), rows[1]);
  assert.equal(producerOf(rows, 1), null);
  const ext = withSource({ kind: "external", name: null, self: false }, rows[0]);
  assert.equal(ext.source, "nostr:npub1qqqqq… via mcp");
  assert.equal(lastEditedBy(ext), "an agent or sync (nostr:npub1qqqqq… via mcp)");
  assert.equal(withSource({ kind: "person", name: "Bob", self: false }, rows[0]).source, undefined, "a named person is not relabelled");
  assert.equal(sourceLabel({ actor: null, via: null }), null);
});
