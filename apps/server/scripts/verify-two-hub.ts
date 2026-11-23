/**
 * verify-two-hub.ts — LIVE two-hub federation convergence harness (GAP 3).
 *
 * The in-process companion (verify-federation.ts, 14 checks) proves the gated
 * primitives against a single self-signed identity. THIS script is the real
 * thing: it drives TWO already-running, fully independent stacks over HTTP/WS
 * and asserts that a CRDT edit on Hub A converges into Hub B's vault and back.
 *
 *   # Hub A: the live default stack (apps/server/.env, :8787 / vault :1940)
 *   # Hub B: an ISOLATED second stack — bring it up with scripts/two-hub-up.sh
 *   #        (apps/server/.env.b, :8788 / vault :2940). DO NOT point it at the
 *   #        live vault.
 *   cd apps/server && node --import tsx scripts/verify-two-hub.ts
 *
 * It is HUB-AGNOSTIC by design: it imports NO server singletons (config/db),
 * so it never accidentally opens Hub A's DB or caches one hub's identity. It
 * reads both hubs' secrets straight from their .env files, talks to each gateway
 * with the owner Bearer (COLLAB_TOKEN, honored only for local requests), signs
 * peer-conn tokens locally from each hub's PEER_SIGNING_KEY, and opens the live
 * /collab WebSocket as a Yjs client under the shared `space_note_key`.
 *
 * ── Acceptance criteria coverage (see the handoff doc §5) ────────────────────
 *   AC-1  reachability + distinct stacks            (HTTP)
 *   AC-2  identity fingerprints + bidirectional pair (HTTP)
 *   AC-3  space_note_key minted on A, mirrored on B  (HTTP: /api/federation/mirror + accept)
 *   AC-4  peer grants >= edit on both hubs           (HTTP)
 *   AC-5  binding live                               (INDIRECT — implied by AC-7)
 *   AC-6  client routes by key (/api/federated)      (HTTP)
 *   AC-7  A -> B convergence                          (Yjs editor + poll B vault)
 *   AC-8  B -> A convergence                          (Yjs editor + poll A vault)
 *   AC-9  offline outbox flush                        (operator kills/restarts B)
 *   AC-10 suggest -> inbox                            (NOT in this harness)
 *   AC-11 revocation stops sync                       (HTTP + external edit)
 *   AC-12 no regression                              (run verify-federation.ts)
 *
 * The B-side mirror now runs the REAL endpoint flow (the productionization of the
 * old manual SQLite insert, handoff §4.3 / open Q3): A signs a peer-conn token and
 * POSTs the space manifest to B's /api/federation/mirror (peer→pending), then B's
 * owner POSTs /acl/federation/mirrors/:id/accept — which materializes B's space +
 * the A→space peer grant + a placeholder note per space_note_key + the
 * federated_notes mapping, so B's FederationManager.syncSpaces re-binds.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";

// ── tiny logger / scoreboard ────────────────────────────────────────────────
type Status = "PASS" | "FAIL" | "SKIP" | "INFO";
let fail = 0;
const results: Array<{ ac: string; status: Status; msg: string }> = [];
function rec(ac: string, status: Status, msg = ""): void {
  if (status === "FAIL") fail++;
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : status === "SKIP" ? "⏭️ " : "ℹ️ ";
  results.push({ ac, status, msg });
  console.log(`${icon} ${ac.padEnd(6)} ${status.padEnd(4)} ${msg}`);
}
const log = (s: string) => console.log(`\n=== ${s} ===`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── minimal .env parser (KEY=VALUE; ignores comments/blank; strips quotes) ───
function parseEnv(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// ── peer-conn token crypto (mirrors src/auth/peer.ts + peer-conn.ts EXACTLY,
//    but parameterized on a private key so the harness can sign as EITHER hub) ─
const b64url = (b: Buffer): string => b.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

function pubFromPriv(privB64url: string): string {
  const priv = crypto.createPrivateKey({ key: fromB64url(privB64url), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv);
  return b64url(pub.export({ format: "der", type: "spki" }) as Buffer);
}
function fingerprint(pubB64url: string): string {
  const hex = crypto.createHash("sha256").update(fromB64url(pubB64url)).digest("hex").slice(0, 16);
  return (hex.match(/.{2}/g) ?? []).join(":");
}
/** Build a peer-conn token signed by `privB64url`, claiming `pubB64url` wants
 *  `spaceId` until exp. The receiving hub verifies the signature against the
 *  embedded pubkey (a paired peer) and checks claims.spaceId === its fed.space_id. */
function mkPeerConnToken(privB64url: string, pubB64url: string, spaceId: string, ttlMs = 5 * 60_000): string {
  const claims = { pubkey: pubB64url, spaceId, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const priv = crypto.createPrivateKey({ key: fromB64url(privB64url), format: "der", type: "pkcs8" });
  const sig = b64url(crypto.sign(null, Buffer.from(body, "utf8"), priv));
  return `${body}.${sig}`;
}

// ── hub config ───────────────────────────────────────────────────────────────
interface Hub {
  name: string;
  httpUrl: string; // gateway base, e.g. http://localhost:8787
  collabUrl: string; // ws://localhost:8787/collab
  ownerBearer: string; // COLLAB_TOKEN (or PARACHUTE_TOKEN) — owner over localhost
  peerPriv: string; // PEER_SIGNING_KEY (pkcs8 b64url)
  peerPub: string; // derived from peerPriv (verified against /api/federation/identity)
  dbPath: string; // SQLite path (for the B-side mirror)
}

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function loadHub(name: string, envFile: string, defaults: { httpUrl: string; collabUrl: string }): Hub {
  const env = parseEnv(envFile);
  const peerPriv = env.PEER_SIGNING_KEY ?? "";
  const ownerBearer = env.COLLAB_TOKEN ?? env.PARACHUTE_TOKEN ?? "";
  const dbPath = path.resolve(SERVER_DIR, env.DB_PATH ?? "./prism-server.db");
  if (!peerPriv) throw new Error(`Hub ${name}: PEER_SIGNING_KEY missing in ${envFile} — set a stable identity (see two-hub-up.sh / handoff §2.2).`);
  if (!ownerBearer) throw new Error(`Hub ${name}: COLLAB_TOKEN (or PARACHUTE_TOKEN) missing in ${envFile}.`);
  return {
    name,
    httpUrl: defaults.httpUrl,
    collabUrl: defaults.collabUrl,
    ownerBearer,
    peerPriv,
    peerPub: pubFromPriv(peerPriv),
    dbPath,
  };
}

// ── HTTP helpers (owner Bearer; honored because the harness is local) ─────────
async function ownerFetch(hub: Hub, p: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${hub.httpUrl}${p}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${hub.ownerBearer}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}
async function ownerJson<T = unknown>(hub: Hub, p: string, init?: RequestInit): Promise<T> {
  const r = await ownerFetch(hub, p, init);
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${hub.name}${p} → ${r.status} ${await r.text().catch(() => "")}`);
  return (await r.json()) as T;
}
interface NoteJson { id: string; content: string; tags: string[] | null }
const createNote = (hub: Hub, body: { content: string; path: string; metadata?: Record<string, unknown> }) =>
  ownerJson<NoteJson>(hub, "/api/notes", { method: "POST", body: JSON.stringify(body) });
const getNote = (hub: Hub, id: string) => ownerJson<NoteJson>(hub, `/api/notes/${encodeURIComponent(id)}`);
const patchNote = (hub: Hub, id: string, content: string) =>
  ownerJson<NoteJson>(hub, `/api/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ content, force: true }) });
const deleteNote = async (hub: Hub, id: string) => { try { await ownerFetch(hub, `/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { /* */ } };

/** Poll a hub's vault note until `content` contains `marker`, or timeout. */
async function pollFor(hub: Hub, id: string, marker: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const n = await getNote(hub, id);
      if ((n.content ?? "").includes(marker)) return true;
    } catch { /* transient */ }
    await sleep(750);
  }
  return false;
}
/** True iff the marker is ABSENT for the whole window (used for AC-11). */
async function stayAbsent(hub: Hub, id: string, marker: string, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    try {
      const n = await getNote(hub, id);
      if ((n.content ?? "").includes(marker)) return false;
    } catch { /* */ }
    await sleep(750);
  }
  return true;
}
async function reachable(hub: Hub): Promise<boolean> {
  try {
    const r = await fetch(`${hub.httpUrl}/auth/me`);
    return r.status === 200 || r.status === 401; // route exists → server up
  } catch {
    return false;
  }
}

// ── live Yjs editor over /collab under the shared space_note_key ──────────────
/** Connect as a paired peer (peer-conn token) and append a <p>marker</p> to the
 *  TipTap "default" XmlFragment — a genuine collaborative document edit. Routing
 *  by space_note_key (not local id) is exactly GAP 2's contract. */
async function editDocument(collabUrl: string, snk: string, token: string, marker: string): Promise<void> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: snk,
    token,
    document: doc,
    // @ts-expect-error WebSocketPolyfill is accepted at runtime (node has no global WebSocket)
    WebSocketPolyfill: WebSocket,
  });
  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("collab sync timeout (auth rejected or hub unreachable)")), 8000);
      provider.on("synced", () => { clearTimeout(t); res(); });
    });
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, marker);
    p.insert(0, [text]);
    frag.push([p]);
    // Give the update time to flush to the server before we tear down.
    await sleep(1500);
  } finally {
    provider.destroy();
  }
}

// ── B-side cleanup: drop any spaces + federated_notes rows the mirror created ──
// (belt-and-braces: teardown also deletes B's space over HTTP, which cascades.)
function unmirrorOnB(b: Hub, snk: string, spaceId: string): void {
  try {
    const bdb = new Database(b.dbPath);
    bdb.pragma("busy_timeout = 5000");
    bdb.prepare("DELETE FROM federated_notes WHERE space_note_key = ?").run(snk);
    bdb.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
    bdb.close();
  } catch { /* best-effort */ }
}

// ── main ─────────────────────────────────────────────────────────────────────
const hubA = loadHub("HUB-A", process.env.HUB_A_ENV ?? path.resolve(SERVER_DIR, ".env"), {
  httpUrl: arg("--a-url") ?? process.env.HUB_A_URL ?? "http://localhost:8787",
  collabUrl: arg("--a-collab") ?? process.env.HUB_A_COLLAB ?? "ws://localhost:8787/collab",
});
const hubB = loadHub("HUB-B", process.env.HUB_B_ENV ?? path.resolve(SERVER_DIR, ".env.b"), {
  httpUrl: arg("--b-url") ?? process.env.HUB_B_URL ?? "http://localhost:8788",
  collabUrl: arg("--b-collab") ?? process.env.HUB_B_COLLAB ?? "ws://localhost:8788/collab",
});

// state to tear down
let aSpaceId = "";
let snk = "";
let aNoteId = "";
let bNoteId = "";
let pairedAonB = false;
let pairedBonA = false;

async function main(): Promise<void> {
  console.log(`Hub A: ${hubA.httpUrl}  (collab ${hubA.collabUrl})`);
  console.log(`Hub B: ${hubB.httpUrl}  (collab ${hubB.collabUrl}, db ${hubB.dbPath})`);

  // Fail fast if Hub B isn't up.
  if (!(await reachable(hubB))) {
    console.error(`\n❌ Hub B not running at ${hubB.httpUrl} — see apps/server/scripts/two-hub-up.sh to bring up the isolated second stack.`);
    process.exit(2);
  }
  if (!(await reachable(hubA))) {
    console.error(`\n❌ Hub A not running at ${hubA.httpUrl} — start it: cd apps/server && npm run dev (or pm2 prism-server).`);
    process.exit(2);
  }

  // ── AC-1: two independent stacks ───────────────────────────────────────────
  log("AC-1  two independent stacks");
  rec("AC-1", "PASS", `both /auth/me reachable (A=${hubA.httpUrl}, B=${hubB.httpUrl})`);

  // ── AC-2: identity exchange + bidirectional pairing ────────────────────────
  log("AC-2  identity exchange + bidirectional pairing");
  interface Identity { publicKey: string; fingerprint: string }
  const idA = await ownerJson<Identity>(hubA, "/api/federation/identity");
  const idB = await ownerJson<Identity>(hubB, "/api/federation/identity");
  rec("AC-2", idA.fingerprint !== idB.fingerprint ? "PASS" : "FAIL", `fpA=${idA.fingerprint} fpB=${idB.fingerprint}`);

  // Sanity: the harness's locally-derived pubkeys must match each hub's identity,
  // else .env / .env.b carry the wrong PEER_SIGNING_KEY and tokens won't validate.
  if (hubA.peerPub !== idA.publicKey) throw new Error("Hub A PEER_SIGNING_KEY in .env does not match its /api/federation/identity — wrong key file?");
  if (hubB.peerPub !== idB.publicKey) throw new Error("Hub B PEER_SIGNING_KEY in .env.b does not match its /api/federation/identity — wrong key file?");
  rec("AC-2", "INFO", `local key derivation matches both identities (fpA=${fingerprint(hubA.peerPub)})`);

  // Pair A→B: mint a code on A, redeem on A registering B (+ B's collab URL).
  const codeA = await ownerJson<{ code: string }>(hubA, "/acl/peers/pair", { method: "POST", body: JSON.stringify({ label: "hub-B" }) });
  const pairBonA = await ownerJson<{ ok: boolean }>(hubA, "/api/federation/pair", {
    method: "POST",
    body: JSON.stringify({ code: codeA.code, pubkey: idB.publicKey, label: "hub-B", collabUrl: hubB.collabUrl }),
  });
  pairedBonA = !!pairBonA.ok;

  // Pair B→A: mint a code on B, redeem on B registering A (+ A's collab URL).
  const codeB = await ownerJson<{ code: string }>(hubB, "/acl/peers/pair", { method: "POST", body: JSON.stringify({ label: "hub-A" }) });
  const pairAonB = await ownerJson<{ ok: boolean }>(hubB, "/api/federation/pair", {
    method: "POST",
    body: JSON.stringify({ code: codeB.code, pubkey: idA.publicKey, label: "hub-A", collabUrl: hubA.collabUrl }),
  });
  pairedAonB = !!pairAonB.ok;

  interface PeerRow { pubkey: string; pairedAt: number | null; fingerprint: string }
  const peersA = await ownerJson<PeerRow[]>(hubA, "/acl/peers");
  const peersB = await ownerJson<PeerRow[]>(hubB, "/acl/peers");
  const aListsB = peersA.find((p) => p.pubkey === idB.publicKey && p.pairedAt);
  const bListsA = peersB.find((p) => p.pubkey === idA.publicKey && p.pairedAt);
  rec("AC-2", aListsB && bListsA ? "PASS" : "FAIL", `A lists B (paired=${!!aListsB}); B lists A (paired=${!!bListsA})`);

  // ── AC-3 / AC-4: space + key mint on A, mirror on B, grants ────────────────
  log("AC-3 / AC-4  space + space_note_key + peer grants");
  const space = await ownerJson<{ id: string }>(hubA, "/acl/spaces", { method: "POST", body: JSON.stringify({ title: "TwoHubTest" }) });
  aSpaceId = space.id;
  const rnd = crypto.randomUUID().slice(0, 8);
  const noteA = await createNote(hubA, { content: "<p>seed-A</p>", path: `_test/twohub/${rnd}-a.md`, metadata: { type: "document" } });
  aNoteId = noteA.id;
  const fed = await ownerJson<{ space_note_key: string; kind: string }>(hubA, `/acl/spaces/${aSpaceId}/notes`, {
    method: "POST",
    body: JSON.stringify({ noteId: aNoteId }),
  });
  snk = fed.space_note_key;
  rec("AC-3", snk && fed.kind === "document" ? "PASS" : "FAIL", `snk=${snk} kind=${fed.kind}`);

  // B-side mirror via the REAL endpoint: A pushes the space manifest to B's
  // /api/federation/mirror (peer-conn token signed with A's key — B verifies it
  // against A's pubkey, which B holds from pairing), then B's owner accepts it.
  // Accept materializes B's space + the A→space peer grant + a placeholder note
  // per shared key + the federated_notes mapping (snk → B's local id). This is
  // exactly what the old manual SQLite insert (mirrorOnB) faked.
  const tokenAtoB = mkPeerConnToken(hubA.peerPriv, idA.publicKey, aSpaceId);
  const mirrorRes = await fetch(`${hubB.httpUrl}/api/federation/mirror`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenAtoB}`, "Content-Type": "application/json" },
    body: JSON.stringify({ spaceId: aSpaceId, spaceTitle: "TwoHubTest", notes: [{ spaceNoteKey: snk, kind: "document" }] }),
  });
  if (!mirrorRes.ok) throw new Error(`B /api/federation/mirror → ${mirrorRes.status} ${await mirrorRes.text().catch(() => "")}`);
  const mirrorBody = (await mirrorRes.json()) as { requestId: string };
  const accept = await ownerJson<{ mapped: Array<{ spaceNoteKey: string; localId: string }> }>(
    hubB,
    `/acl/federation/mirrors/${mirrorBody.requestId}/accept`,
    { method: "POST", body: JSON.stringify({ level: "edit" }) },
  );
  bNoteId = accept.mapped[0]?.localId ?? "";

  // Grant on A (B already has its A→space grant from the accept above). The A
  // grant triggers A's syncSpaces; B's accept already kicked B's.
  const grantB = await ownerJson<{ grant: { level: string } }>(hubA, `/acl/spaces/${aSpaceId}/peers`, {
    method: "POST",
    body: JSON.stringify({ pubkey: idB.publicKey, level: "edit" }),
  });
  // Verify B mirrored the SAME snk → its own local id, via the accept response
  // and B's /api/federated read-back (no direct SQLite peek needed).
  let bMirrorOk = accept.mapped[0]?.spaceNoteKey === snk && !!bNoteId;
  try {
    const mapB0 = await ownerJson<{ spaceNoteKey?: string; spaceId?: string }>(hubB, `/api/federated/${encodeURIComponent(bNoteId)}`);
    bMirrorOk = bMirrorOk && mapB0.spaceNoteKey === snk && mapB0.spaceId === aSpaceId;
  } catch { /* /api/federated is gated off unless FEDERATION_ENABLED — accept-response check still stands */ }
  // The B-side peer grant for A now exists from the accept (idempotently re-asserted).
  const grantA = await ownerJson<{ grant: { level: string } }>(hubB, `/acl/spaces/${aSpaceId}/peers`, {
    method: "POST",
    body: JSON.stringify({ pubkey: idA.publicKey, level: "edit" }),
  });
  rec("AC-3", bMirrorOk ? "PASS" : "FAIL", `B mirror via /mirror+accept: snk→${bNoteId} in space ${aSpaceId} (${bMirrorOk})`);
  rec("AC-4", grantB.grant.level === "edit" && grantA.grant.level === "edit" ? "PASS" : "FAIL", `A→B=${grantB.grant.level}, B→A=${grantA.grant.level}`);

  // Give both FederationManagers a beat to (re)bind after the grant hooks fired.
  await sleep(2000);

  // ── AC-6: client routes by space_note_key (/api/federated) ─────────────────
  log("AC-6  client routes by space_note_key");
  const mapA = await ownerJson<{ spaceNoteKey?: string }>(hubA, `/api/federated/${encodeURIComponent(aNoteId)}`);
  const mapB = await ownerJson<{ spaceNoteKey?: string }>(hubB, `/api/federated/${encodeURIComponent(bNoteId)}`);
  // A non-federated note must return 204 (no body).
  const nonFed = await createNote(hubA, { content: "<p>x</p>", path: `_test/twohub/${rnd}-plain.md`, metadata: { type: "document" } });
  const nfResp = await ownerFetch(hubA, `/api/federated/${encodeURIComponent(nonFed.id)}`);
  const nfIs204 = nfResp.status === 204;
  await deleteNote(hubA, nonFed.id);
  rec("AC-6", mapA.spaceNoteKey === snk && mapB.spaceNoteKey === snk && nfIs204 ? "PASS" : "FAIL",
    `A→${mapA.spaceNoteKey === snk}, B→${mapB.spaceNoteKey === snk}, nonFed→204=${nfIs204}`);

  // ── AC-7: A → B convergence ────────────────────────────────────────────────
  log("AC-7  A → B convergence");
  const markA = `MARK-A-${crypto.randomUUID().slice(0, 8)}`;
  // To inject an edit into A's SNK doc we present a peer-conn token from a peer of
  // A — that is B. (Editing under SNK ALWAYS routes through the federation auth
  // branch; the owner token cannot open an SNK doc.) The edit lands in A's doc,
  // A persists it to A's vault, and A's bridge propagates it to B.
  const tokenToA = mkPeerConnToken(hubB.peerPriv, idB.publicKey, aSpaceId);
  let ac7 = false;
  try {
    await editDocument(hubA.collabUrl, snk, tokenToA, markA);
    ac7 = await pollFor(hubB, bNoteId, markA, 15000);
  } catch (e) {
    rec("AC-7", "INFO", `editor error: ${(e as Error).message}`);
  }
  rec("AC-7", ac7 ? "PASS" : "FAIL", `${markA} ${ac7 ? "reached" : "did NOT reach"} B's vault within 15s`);
  // AC-5 binding-live is not HTTP-introspectable; a successful A→B converge proves
  // the binding came up automatically (post-GAP-1 syncSpaces). In-process binding
  // assertions live in verify-federation.ts / test/federation.test.ts.
  rec("AC-5", ac7 ? "PASS" : "FAIL", ac7 ? "binding live (implied by AC-7; activeBindings asserted in verify-federation.ts)" : "no converge → binding not live");

  // ── AC-8: B → A convergence ────────────────────────────────────────────────
  log("AC-8  B → A convergence");
  const markB = `MARK-B-${crypto.randomUUID().slice(0, 8)}`;
  const tokenToB = mkPeerConnToken(hubA.peerPriv, idA.publicKey, aSpaceId); // A is B's peer
  let ac8 = false;
  try {
    await editDocument(hubB.collabUrl, snk, tokenToB, markB);
    ac8 = await pollFor(hubA, aNoteId, markB, 15000);
  } catch (e) {
    rec("AC-8", "INFO", `editor error: ${(e as Error).message}`);
  }
  rec("AC-8", ac8 ? "PASS" : "FAIL", `${markB} ${ac8 ? "reached" : "did NOT reach"} A's vault within 15s`);

  // ── AC-9: offline outbox flush (operator kills + restarts Hub B) ───────────
  log("AC-9  offline outbox flush");
  if (process.env.TWO_HUB_AC9 !== "1") {
    rec("AC-9", "SKIP", "set TWO_HUB_AC9=1 and be ready to kill+restart Hub B to exercise outbox replay");
  } else {
    console.log("  → Kill Hub B now (Ctrl-C its `node --env-file=.env.b ...` process). Waiting up to 60s for it to go DOWN…");
    let wentDown = false;
    for (let i = 0; i < 80; i++) { if (!(await reachable(hubB))) { wentDown = true; break; } await sleep(750); }
    if (!wentDown) {
      rec("AC-9", "SKIP", "Hub B never went down within 60s — could not exercise offline path");
    } else {
      const markC = `MARK-C-${crypto.randomUUID().slice(0, 8)}`;
      // Edit A while B is offline → A's bridge buffers to federation_outbox.
      await editDocument(hubA.collabUrl, snk, mkPeerConnToken(hubB.peerPriv, idB.publicKey, aSpaceId), markC).catch(() => {});
      console.log(`  → Edited A while B offline (${markC}). Restart Hub B now (two-hub-up.sh or node --env-file=.env.b …). Waiting up to 90s for it to come UP…`);
      let cameUp = false;
      for (let i = 0; i < 120; i++) { if (await reachable(hubB)) { cameUp = true; break; } await sleep(750); }
      if (!cameUp) {
        rec("AC-9", "SKIP", "Hub B did not come back within 90s");
      } else {
        const converged = await pollFor(hubB, bNoteId, markC, 45000);
        rec("AC-9", converged ? "PASS" : "FAIL", `${markC} ${converged ? "replayed to B after reconnect" : "did NOT replay within 45s"}`);
      }
    }
  }

  // ── AC-10: suggest → inbox (not covered here) ──────────────────────────────
  rec("AC-10", "SKIP", "suggest→inbox needs a suggest-mode client payload; covered by test/federation.test.ts, not this harness");

  // ── AC-11: revocation stops sync ───────────────────────────────────────────
  log("AC-11  revocation stops sync");
  await ownerFetch(hubA, `/acl/spaces/${aSpaceId}/peers/${encodeURIComponent(idB.publicKey)}`, { method: "DELETE" });
  await sleep(2000); // let kickFederationSync tear the A→B binding down
  const markD = `MARK-D-${crypto.randomUUID().slice(0, 8)}`;
  // B's grant on A is now gone, so the peer-conn editor can no longer open A's SNK
  // doc. Make the A-side edit via the vault (owner passthrough) — an external edit
  // that A would normally fold into the live doc and federate, IF a binding existed.
  await patchNote(hubA, aNoteId, `<p>seed-A</p><p>${markD}</p>`);
  const stoppedFromA = await stayAbsent(hubB, bNoteId, markD, 8000);
  rec("AC-11", stoppedFromA ? "PASS" : "FAIL", `post-revocation A edit ${stoppedFromA ? "did NOT reach" : "LEAKED to"} B (8s window)`);

  // ── AC-12: no regression (run the in-process suites separately) ────────────
  rec("AC-12", "SKIP", "run `npm run verify:federation` (14/14) and `npm test` (federation suite, 42/42) with federation disabled");
}

async function teardown(): Promise<void> {
  log("teardown");
  if (snk && aSpaceId) {
    // A: deleting the space drops its federated_notes + peer grants (acl.delete).
    try { await ownerFetch(hubA, `/acl/spaces/${aSpaceId}`, { method: "DELETE" }); } catch { /* */ }
    // B: same handler (the space row exists from the mirror); plus belt-and-braces.
    try { await ownerFetch(hubB, `/acl/spaces/${aSpaceId}`, { method: "DELETE" }); } catch { /* */ }
    unmirrorOnB(hubB, snk, aSpaceId);
  }
  if (aNoteId) await deleteNote(hubA, aNoteId);
  if (bNoteId) await deleteNote(hubB, bNoteId);
  // Unpair both directions (removes peer rows + their grants).
  try { const idB = await ownerJson<{ publicKey: string }>(hubB, "/api/federation/identity"); if (pairedBonA) await ownerFetch(hubA, `/acl/peers/${encodeURIComponent(idB.publicKey)}`, { method: "DELETE" }); } catch { /* */ }
  try { const idA = await ownerJson<{ publicKey: string }>(hubA, "/api/federation/identity"); if (pairedAonB) await ownerFetch(hubB, `/acl/peers/${encodeURIComponent(idA.publicKey)}`, { method: "DELETE" }); } catch { /* */ }
  console.log("  cleaned test notes, space, federated rows, and peer pairings on both hubs");
}

main()
  .catch((e) => {
    console.error("\nERROR:", e instanceof Error ? e.message : e);
    fail++;
  })
  .finally(async () => {
    await teardown().catch((e) => console.error("teardown error:", e));
    const pass = results.filter((r) => r.status === "PASS").length;
    const skip = results.filter((r) => r.status === "SKIP").length;
    console.log(`\n=== ${pass} PASS, ${fail} FAIL, ${skip} SKIP ===`);
    process.exit(fail === 0 ? 0 : 1);
  });
