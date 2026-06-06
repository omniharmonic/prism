/**
 * Server-side real-time collaboration (Hocuspocus + Yjs), replacing the retired
 * Cloudflare Worker. Runs in the Prism Server process, so it shares the vault
 * token and the ACL store:
 *
 *  - onAuthenticate: resolve the connection's level (session cookie OR ?t=
 *    capability) against the note; reject below "view"; mark view/comment
 *    connections read-only (their edits are dropped by Hocuspocus).
 *  - onLoadDocument: seed the Y.Doc server-side from Parachute (so the owner's
 *    browser need not be open), preferring persisted CRDT state unless Parachute
 *    was edited externally since (then re-seed — external edit wins).
 *  - onStoreDocument: persist the Y.Doc back to Parachute (HTML) AND to SQLite
 *    (Yjs binary, for CRDT continuity across unloads).
 *
 * documentName == note id. The TipTap schema is the SHARED collabExtensions()
 * from @prism/core, so HTML↔Yjs conversion matches the client exactly.
 */
import { Window } from "happy-dom";
import { Hocuspocus } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import type { IncomingMessage, Server } from "node:http";
import * as Y from "yjs";
import { generateJSON, generateHTML, getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import { collabExtensions } from "@prism/core/editor-schema";
import { marked } from "marked";
import { config } from "./config";
import { vault } from "./parachute";
import { verifyCapability } from "./auth/capability";
import { getSession, grantsForUser, grantsForCapability, getDocState, saveDocState, type Grant } from "./db";
import { effectiveLevel, atLeast, type Level } from "./permissions";

// TipTap's generate{JSON,HTML} need a DOM at call time; provide a lightweight
// one. (These globals are read when the hooks run, never at import.)
const _win = new Window();
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= _win;
g.document ??= _win.document;
g.DOMParser ??= _win.DOMParser;

const FIELD = "default"; // TipTap's default XML fragment name
const exts = collabExtensions();
const schema = getSchema(exts);

/** Markdown/HTML → an empty Y.Doc's encoded state for the shared fragment. */
function contentToYUpdate(content: string): Uint8Array {
  const src = content ?? "";
  const html = src.trim().startsWith("<") ? src : (marked.parse(src) as string);
  const json = generateJSON(html || "<p></p>", exts);
  return Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, json, FIELD));
}

function yDocToHtml(doc: Y.Doc): string {
  return generateHTML(yDocToProsemirrorJSON(doc, FIELD), exts);
}

const toMs = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

/** Read a header whether `requestHeaders` is a Fetch Headers (typed) or a node
 *  IncomingMessage's plain object (what `ws` actually provides at runtime). */
function headerGet(h: unknown, key: string): string | null {
  if (!h) return null;
  const maybe = h as { get?: (k: string) => string | null };
  if (typeof maybe.get === "function") return maybe.get(key);
  const obj = h as Record<string, string | string[] | undefined>;
  const v = obj[key] ?? obj[key.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function sessionEmailFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)prism_session=([^;]+)/);
  if (!m || !m[1]) return null;
  const s = getSession(decodeURIComponent(m[1]));
  return s ? s.email : null;
}

/** Resolve the connection's effective level for a note (session wins over link). */
async function resolveLevel(noteId: string, token: string, cookieHeader: string | null): Promise<Level | null> {
  const email = sessionEmailFromCookie(cookieHeader);
  let grants: Grant[] = [];
  let isOwner = false;
  if (email) {
    isOwner = email === config.ownerEmail;
    grants = grantsForUser(email);
  }
  if (!isOwner && token && token !== "session") {
    const claims = verifyCapability(token);
    if (claims) grants = grants.concat(grantsForCapability(claims.id));
  }
  let tags: string[] = [];
  try {
    tags = (await vault.getNote(noteId)).tags ?? [];
  } catch {
    /* new/unknown note — no tags */
  }
  return effectiveLevel(grants, { id: noteId, tags }, isOwner);
}

export const hocuspocus = new Hocuspocus({
  async onAuthenticate(data) {
    const cookie = headerGet(data.requestHeaders, "cookie");
    const level = await resolveLevel(data.documentName, data.token, cookie);
    if (!atLeast(level, "view")) throw new Error("Forbidden");
    // view/comment connections are read-only; suggest/edit/own may write.
    if (!atLeast(level, "suggest")) data.connectionConfig.readOnly = true;
    return { level };
  },

  async onLoadDocument(data) {
    const doc = data.document;
    if (doc.getXmlFragment(FIELD).length > 0) return doc; // already populated this run

    let note: { content: string; updatedAt: string | null } | null = null;
    try {
      const n = await vault.getNote(data.documentName);
      note = { content: n.content, updatedAt: n.updatedAt };
    } catch {
      /* note may not be readable; leave empty */
    }

    const stored = getDocState(data.documentName);
    const externallyEdited = stored && note && toMs(note.updatedAt) > (stored.sourceUpdatedAt ?? 0);

    if (stored && !externallyEdited) {
      Y.applyUpdate(doc, stored.state); // live CRDT state is current
    } else if (note) {
      Y.applyUpdate(doc, contentToYUpdate(note.content)); // seed (or re-seed on external edit)
    }
    return doc;
  },

  async onStoreDocument(data) {
    let sourceUpdatedAt: number | null = null;
    try {
      const html = yDocToHtml(data.document);
      const updated = await vault.updateNote(data.documentName, { content: html });
      sourceUpdatedAt = toMs(updated.updatedAt);
    } catch {
      /* vault write failed — still persist CRDT state below */
    }
    saveDocState(data.documentName, Y.encodeStateAsUpdate(data.document), sourceUpdatedAt);
  },
});

/** Attach the collab WebSocket handler to the Node HTTP server at /collab. */
export function attachCollab(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (!request.url || !request.url.startsWith("/collab")) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Hocuspocus v3 only CREATES the connection here; we must pump WS messages
      // into it ourselves (its built-in path uses crossws, which we bypass).
      const connection = hocuspocus.handleConnection(ws as never, request as never) as {
        handleMessage(data: Uint8Array): void;
        handleClose(event: { code: number; reason: string }): void;
      };
      ws.on("message", (data: Buffer) => {
        connection.handleMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });
      ws.on("close", (code: number, reason: Buffer) => {
        connection.handleClose({ code, reason: reason?.toString() ?? "" });
      });
    });
  });
}
