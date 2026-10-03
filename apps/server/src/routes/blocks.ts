/**
 * POST /api/notes/:id/blocks/append — "Move to another page" (NP-ED-02).
 *
 * The editor's block menu moves a block to another page by APPENDING it there
 * and removing it here. A plain PATCH of the target's content is wrong when the
 * target is open live: the vault copy lacks the live document's unsaved typing,
 * so compare-and-set passes and the reconciler then folds the stale body over
 * what people are typing (review H2). This route:
 *
 *  - target is LIVE → appends through the live Y.Doc (a direct connection,
 *    like the Prism MCP tools): only the new blocks are created, nothing that
 *    exists is touched, so unsaved edits survive;
 *  - otherwise → one compare-and-set write (re-read + retried once on a 409:
 *    an append commutes). A Markdown-bodied target keeps Markdown: the blocks
 *    are converted, never pasted as raw HTML into Markdown (M5);
 *  - the blocks are parsed through the shared editor schema first, so whatever
 *    is sent, only valid document content is stored;
 *  - `requestId` makes it idempotent per (vault, target, account): a repeat with
 *    the same body answers the first outcome and appends nothing (L8); the same
 *    id with another body → 422;
 *  - signed-in accounts only, CSRF guard, `edit` on the target, the same
 *    system / locked / trashed refusals as a content PATCH (unviewable == missing).
 *
 * The client calls it with `serverFetch` (never the offline outbox), so a 200
 * is a CONFIRMED append — only then is the source block removed (M3).
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import TurndownService from "turndown";
import { Fragment } from "@tiptap/pm/model";
import { yDocToProsemirrorJSON, updateYFragment } from "@tiptap/y-tiptap";
import { isLocked, isTrashed, systemNoteReason } from "@prism/core/pages";
import { db, resolveVaultEntry } from "../db";
import type { VaultEntry } from "../config";
import { vaultClient, VaultError, VaultConflictError, type Note } from "../parachute";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { effectiveCaps, type Cap, type NoteRef } from "../permissions";
import { treeUpsertNote, warmPageAnchors } from "../tree";
import { roleAtLeast, roleFloor } from "../roles";
import { csrfRefusal } from "./actions";
import { consumeRateLimit } from "../middleware/ratelimit";
import { FIELD, collabSchema, contentToYUpdate, docNameFor, hocuspocus, isDocLive, isNoteId, noteCollabWriter, noteKind, yDocToHtml } from "../collab";
import { writerStamp } from "../sharing";
import "../block-append-store";

const MAX_HTML = 256 * 1024;
/** The vault refuses updates to a note over 2 MB while history is on. */
const MAX_NOTE = 1_900_000;
const PER_MINUTE = 30;
const RECEIPT_DAYS = 14;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const NOT_FOUND = { error: "not_found" } as const;

const isAdmin = (a: Actor) => roleAtLeast(a.role, "admin");
const capsFor = (actor: Actor & { kind: "user" }, note: NoteRef): Set<Cap> => effectiveCaps(actor.grants, note, roleFloor(actor.role), actor.email);
const ref = (n: Pick<Note, "id" | "tags" | "metadata"> & { path?: string | null }): NoteRef => ({
  id: n.id,
  tags: n.tags ?? [],
  path: n.path ?? null,
  creator: (n.metadata?.prism_creator as string | undefined) ?? null,
  visibility: n.metadata?.prism_visibility === "private" ? "private" : "workspace",
});
const entryFor = (c: Context, a: Actor): VaultEntry => (isAdmin(a) ? resolveVaultEntry(c.req.header("x-prism-vault")) : resolveVaultEntry(a.vaultId));

const looksLikeHtml = (s: string) => /^\s*<[a-z][a-z0-9-]*[\s>/]/i.test(s);
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
// Prism blocks Markdown cannot say (callouts, files, embeds, sub-page rows, databases, toggles, columns)
// stay as HTML blocks — valid in Markdown, and exactly what the editor parses back.
turndown.keep(((node: { nodeName: string; getAttribute(name: string): string | null }) =>
  (node.nodeName === "DIV" && (!!node.getAttribute("data-type") || !!node.getAttribute("data-prism-database"))) || node.nodeName === "DETAILS") as never);

/** Parse through the shared schema: canonical HTML + the document's blocks. Null when nothing valid is left. */
export function canonicalBlocks(html: string): { html: string; json: unknown[] } | null {
  const tmp = new Y.Doc();
  Y.applyUpdate(tmp, contentToYUpdate(html));
  const json = yDocToProsemirrorJSON(tmp, FIELD) as { content?: unknown[] };
  const out = yDocToHtml(tmp);
  if (!json.content?.length || out === "<p></p>") return null;
  return { html: out, json: json.content };
}

/** The target body with the blocks appended, in the body's own format. */
export function appendToBody(body: string, blocksHtml: string): string {
  if (!body.trim()) return blocksHtml;
  if (looksLikeHtml(body)) return body.replace(/\s+$/, "") + blocksHtml;
  return `${body.replace(/\s+$/, "")}\n\n${turndown.turndown(blocksHtml).trim()}\n`;
}

/** Append blocks at the end of a live document: one Yjs transaction that only CREATES elements. */
export function appendToLiveDoc(doc: Y.Doc, blocks: unknown[], origin: string): void {
  const schema = collabSchema();
  const current = schema.nodeFromJSON(yDocToProsemirrorJSON(doc, FIELD));
  const added = Fragment.fromJSON(schema, blocks);
  const next = current.copy(current.content.append(added));
  doc.transact(() => {
    updateYFragment(doc, doc.getXmlFragment(FIELD), next, { mapping: new Map(), isOMark: new Map() });
  }, origin);
}

const inFlight = new Map<string, Promise<{ status: number; body: Record<string, unknown> }>>();

export const blocksApi = new Hono();

blocksApi.post("/notes/:id/blocks/append", bodyLimit({ maxSize: MAX_HTML + 4096, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
  const via = requestVia(c);
  const actor = resolveActor(c);
  if (actor.kind !== "user") return c.json({ error: "unauthorized" }, 401);
  const csrf = csrfRefusal(c, via);
  if (csrf) return csrf;
  const retry = consumeRateLimit(`block-append:u:${actor.email.toLowerCase()}`, PER_MINUTE, 60_000);
  if (retry !== null) { c.header("Retry-After", String(retry)); return c.json({ error: "rate_limited", retryAfter: retry }, 429); }
  const id = c.req.param("id");
  if (!id || !isNoteId(id)) return c.json(NOT_FOUND, 404);
  let body: { html?: unknown; requestId?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_request" }, 400); }
  if (!body || typeof body !== "object" || Object.keys(body).some((k) => k !== "html" && k !== "requestId")) return c.json({ error: "invalid_request" }, 400);
  const { html, requestId } = body;
  if (typeof html !== "string" || !html.trim() || typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return c.json({ error: "invalid_request" }, 400);
  if (Buffer.byteLength(html) > MAX_HTML) return c.json({ error: "too_large" }, 413);
  if (!looksLikeHtml(html)) return c.json({ error: "invalid_request", detail: "html blocks expected" }, 400);

  const entry = entryFor(c, actor);
  const client = vaultClient(entry.id, { timeoutMs: 15_000 });
  let note: Note;
  try {
    note = await client.getNote(id);
  } catch (e) {
    if (e instanceof VaultError && e.status === 404) return c.json(NOT_FOUND, 404);
    return c.json({ error: "vault_unreachable" }, 502);
  }
  if (note.id !== id) return c.json(NOT_FOUND, 404); // never act on a path/title alias
  const admin = isAdmin(actor);
  if (!admin) {
    await warmPageAnchors(actor.grants);
    const caps = capsFor(actor, ref(note));
    if (!caps.has("view") || isTrashed(note)) return c.json(NOT_FOUND, 404);
    if (!caps.has("edit")) return c.json({ error: "forbidden", detail: "edit access required" }, 403);
    if (systemNoteReason(note)) return c.json({ error: "protected", detail: "this is a system note" }, 403);
    if (isLocked(note)) return c.json({ error: "locked", detail: "this page is locked" }, 409);
  } else if (isTrashed(note)) return c.json(NOT_FOUND, 404);
  if (noteKind(note) !== "document") return c.json({ error: "invalid_request", detail: "blocks can only be moved to a document page" }, 400);

  const actorKey = actor.email.toLowerCase();
  const hash = createHash("sha256").update(html).digest("hex");
  const receipt = db.prepare("SELECT body_hash, live FROM block_append_receipts WHERE vault_id = ? AND note_id = ? AND actor = ? AND request_id = ?").get(entry.id, note.id, actorKey, requestId) as { body_hash: string; live: number } | undefined;
  if (receipt) {
    if (receipt.body_hash !== hash) return c.json({ error: "idempotency_mismatch" }, 422);
    c.header("Idempotent-Replayed", "true");
    return c.json({ ok: true, live: !!receipt.live, replayed: true });
  }
  const key = `${entry.id}\u0000${note.id}\u0000${actorKey}\u0000${requestId}`;
  const running = inFlight.get(key);
  if (running) {
    const r = await running;
    if (r.status === 200) c.header("Idempotent-Replayed", "true");
    return c.json(r.body, r.status as 200);
  }

  const run = (async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    const blocks = canonicalBlocks(html);
    if (!blocks) return { status: 400, body: { error: "invalid_request", detail: "nothing to append" } };
    const record = (live: boolean) => {
      db.prepare("INSERT OR IGNORE INTO block_append_receipts (vault_id, note_id, actor, request_id, body_hash, live, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(entry.id, note.id, actorKey, requestId, hash, live ? 1 : 0, new Date().toISOString());
      db.prepare("DELETE FROM block_append_receipts WHERE created_at < ?").run(new Date(Date.now() - RECEIPT_DAYS * 86_400_000).toISOString());
    };
    const docName = docNameFor(entry.id, note.id);
    if (isDocLive(entry.id, note.id)) {
      const conn = await hocuspocus.openDirectConnection(docName, { human: actor.email });
      try {
        if (!conn.document) return { status: 502, body: { error: "upstream_error" } };
        if (Buffer.byteLength(yDocToHtml(conn.document)) + Buffer.byteLength(blocks.html) > MAX_NOTE) return { status: 413, body: { error: "too_large", detail: "that page is full" } };
        // Synchronous from here: the receipt and the Yjs change land in the same tick.
        appendToLiveDoc(conn.document, blocks.json, `human:${actor.email}`);
        noteCollabWriter(docName, actor.email, "edit");
        record(true);
      } finally {
        await conn.disconnect(); // stores through the normal path
      }
      return { status: 200, body: { ok: true, live: true } };
    }
    let current = note;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current.updatedAt) return { status: 409, body: { error: "conflict" } };
      const next = appendToBody(current.content ?? "", blocks.html);
      if (Buffer.byteLength(next) > MAX_NOTE) return { status: 413, body: { error: "too_large", detail: "that page is full" } };
      // The page may have been opened since the check above: a body write under a
      // live document would be folded over what is being typed.
      if (isDocLive(entry.id, note.id)) return { status: 409, body: { error: "conflict", retry: true } };
      try {
        const saved = await client.updateNote(note.id, { content: next, metadata: writerStamp(actor.email, "edit"), ifUpdatedAt: current.updatedAt });
        record(false);
        try { treeUpsertNote(entry, saved); } catch { /* the subscribe socket follows */ }
        return { status: 200, body: { ok: true, live: false, updatedAt: saved.updatedAt ?? null } };
      } catch (e) {
        const conflict = e instanceof VaultConflictError || (e instanceof VaultError && e.status === 409);
        if (!conflict) return { status: e instanceof VaultError && [400, 413, 422].includes(e.status) ? e.status : 502, body: { error: e instanceof VaultError && [400, 413, 422].includes(e.status) ? "vault_rejected" : "vault_unreachable" } };
        if (attempt === 1) return { status: 409, body: { error: "conflict" } };
        try { current = await client.getNote(note.id); } catch { return { status: 502, body: { error: "vault_unreachable" } }; }
        if (current.id !== note.id || isTrashed(current) || (!admin && isLocked(current))) return { status: 409, body: { error: "conflict" } };
      }
    }
    return { status: 409, body: { error: "conflict" } };
  })();
  inFlight.set(key, run);
  try {
    const r = await run;
    return c.json(r.body, r.status as 200);
  } catch {
    return c.json({ error: "upstream_error" }, 502);
  } finally {
    inFlight.delete(key);
  }
});
