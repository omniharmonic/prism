import { routePartykitRequest, type Connection, type WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

interface Env {
  Document: DurableObjectNamespace;
  /** HMAC secret for signing collab grants (wrangler secret). */
  COLLAB_SECRET: string;
  /** Trusted vault base used to validate owner tokens, e.g. https://agent.omniharmonic.com */
  VAULT_URL: string;
  /** Vault name, e.g. "default". */
  VAULT_NAME: string;
}

/** Room name for a note. Must match the client (CollabPage). */
const roomFor = (noteId: string) => `prism-collab-${noteId}`;

/**
 * One Durable Object per note (room). y-partyserver keeps the authoritative
 * Y.Doc and relays CRDT updates + awareness to all connected peers.
 *
 * Access is gated at the Worker (see fetch): a connection must carry a valid,
 * unexpired grant signed for its exact room. So the collab interface only ever
 * exposes notes that have been explicitly shared — never the whole vault.
 */
export class Document extends YServer<Env> {
  // Persist the doc to this DO's storage so it survives all clients
  // disconnecting — otherwise a collaborator opening a shared link while the
  // owner is offline would get an empty doc (they can't seed without vault
  // access). onLoad restores it; onSave writes it (debounced + on empty).
  static callbackOptions = { debounceWait: 2000, debounceMaxWait: 10000, timeout: 5000 };

  async onLoad() {
    const stored = await this.ctx.storage.get<Uint8Array>("ydoc");
    if (stored) Y.applyUpdate(this.document, stored);
  }

  async onSave() {
    await this.ctx.storage.put("ydoc", Y.encodeStateAsUpdate(this.document));
  }

  // Cloudflare delivers binary WS frames to the server as `Blob` (binaryType
  // defaults to "blob"); y-partyserver only understands ArrayBuffer/Uint8Array,
  // so a Blob decodes empty ("Unexpected end of array") and nothing relays.
  async onMessage(connection: Connection, message: WSMessage | Blob) {
    const msg: WSMessage = message instanceof Blob ? await message.arrayBuffer() : message;
    return super.onMessage(connection, msg);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // Mint a collab grant for a note — owner must prove vault access.
    if (url.pathname === "/grant" && request.method === "POST") {
      return cors(await handleGrant(request, env));
    }

    // Gate every collab WebSocket: require a valid grant for this exact room.
    const m = url.pathname.match(/^\/parties\/[^/]+\/(.+)$/);
    if (m) {
      const room = decodeURIComponent(m[1]);
      const token = url.searchParams.get("t") ?? "";
      if (!(await verifyGrant(token, room, env.COLLAB_SECRET))) {
        return new Response("Forbidden: invalid or missing collab grant", { status: 403 });
      }
    }

    return (
      (await routePartykitRequest(request, env as never)) ||
      new Response("Prism collab server", { status: 200 })
    );
  },
} satisfies ExportedHandler<Env>;

// ---- grant minting -------------------------------------------------------

async function handleGrant(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
  if (!env.COLLAB_SECRET) return new Response("Server misconfigured", { status: 500 });

  let noteId = "";
  try {
    noteId = String((await request.json<{ noteId?: string }>()).noteId ?? "");
  } catch {
    /* fallthrough */
  }
  if (!noteId) return new Response("Missing noteId", { status: 400 });

  // The requester must actually be able to read this note in the vault. We
  // validate against the TRUSTED vault URL (not a client-supplied one), so this
  // can't be used to probe arbitrary hosts, and only real vault holders can mint.
  const base = env.VAULT_URL.replace(/\/+$/, "");
  const name = env.VAULT_NAME || "default";
  const check = await fetch(`${base}/vault/${name}/api/notes/${encodeURIComponent(noteId)}`, {
    headers: { Authorization: auth },
  });
  if (!check.ok) return new Response("Unauthorized", { status: 401 });

  const grant = await signGrant(roomFor(noteId), env.COLLAB_SECRET, 30 * 24 * 3600);
  return Response.json({ grant, room: roomFor(noteId) });
}

// ---- grant signing / verification (HMAC-SHA256) --------------------------

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signGrant(room: string, secret: string, ttlSec: number): Promise<string> {
  const payload = { r: room, e: Math.floor(Date.now() / 1000) + ttlSec };
  const data = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

async function verifyGrant(token: string, room: string, secret: string): Promise<boolean> {
  if (!token || !secret) return false;
  const [data, sig] = token.split(".");
  if (!data || !sig) return false;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    b64urlToBytes(sig),
    new TextEncoder().encode(data),
  );
  if (!valid) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(data))) as { r: string; e: number };
    return payload.r === room && payload.e >= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

// ---- CORS (for the browser /grant call; WS upgrades don't need it) -------

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  return new Response(res.body, { status: res.status, headers: h });
}
