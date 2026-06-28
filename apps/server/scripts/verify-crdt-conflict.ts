/**
 * verify-crdt-conflict.ts — LIVE two-hub CONCURRENT-EDIT conflict test.
 *
 * Companion to verify-two-hub.ts. Where that harness proves sequential A⇄B
 * convergence + offline outbox replay (AC-7/8/9), THIS script proves the harder
 * property the user asked about: two clients editing the SAME shared doc at the
 * SAME logical time both survive (Yjs CRDT merge — no lost update / clobber),
 * and BOTH hubs' vaults converge to the identical content.
 *
 *   # Hub A: the live default stack (.env, :8787).  Hub B: the isolated stack
 *   #        from scripts/two-hub-up.sh (.env.b, :8788). Federation must be ON
 *   #        for BOTH (A via the runtime toggle, B via FEDERATION_ENABLED=true).
 *   cd apps/server && node --import tsx scripts/verify-crdt-conflict.ts
 *
 * It is self-contained: it pairs A↔B, mints a space + space_note_key on A,
 * mirrors it to B via the real /api/federation/mirror + accept flow, then opens
 * TWO Yjs HocuspocusProvider clients to the SAME documentName (the snk) — one
 * through A's /collab, one through B's /collab — applies DIFFERENT edits
 * (client-A inserts "AAA…" at the start, client-B inserts "BBB…" at the end)
 * back-to-back before either syncs out, lets them converge, and asserts both
 * markers are present in BOTH vaults and the two vault contents are identical.
 * Tears everything down (space, notes, pairings) on exit. Hub-agnostic: imports
 * NO server singletons; reads each hub's secrets from its .env file.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";

type Status = "PASS" | "FAIL" | "INFO";
let fail = 0;
function rec(label: string, status: Status, msg = ""): void {
  if (status === "FAIL") fail++;
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "ℹ️ ";
  console.log(`${icon} ${label.padEnd(10)} ${status.padEnd(4)} ${msg}`);
}
const log = (s: string) => console.log(`\n=== ${s} ===`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const b64url = (b: Buffer): string => b.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");
function pubFromPriv(privB64url: string): string {
  const priv = crypto.createPrivateKey({ key: fromB64url(privB64url), format: "der", type: "pkcs8" });
  return b64url(crypto.createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer);
}
function mkPeerConnToken(privB64url: string, pubB64url: string, spaceId: string, ttlMs = 5 * 60_000): string {
  const claims = { pubkey: pubB64url, spaceId, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const priv = crypto.createPrivateKey({ key: fromB64url(privB64url), format: "der", type: "pkcs8" });
  const sig = b64url(crypto.sign(null, Buffer.from(body, "utf8"), priv));
  return `${body}.${sig}`;
}

interface Hub {
  name: string;
  httpUrl: string;
  collabUrl: string;
  ownerBearer: string;
  peerPriv: string;
  peerPub: string;
}
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
function loadHub(name: string, envFile: string, d: { httpUrl: string; collabUrl: string }): Hub {
  const env = parseEnv(envFile);
  const peerPriv = env.PEER_SIGNING_KEY ?? "";
  const ownerBearer = env.COLLAB_TOKEN ?? env.PARACHUTE_TOKEN ?? "";
  if (!peerPriv) throw new Error(`Hub ${name}: PEER_SIGNING_KEY missing in ${envFile}`);
  if (!ownerBearer) throw new Error(`Hub ${name}: COLLAB_TOKEN/PARACHUTE_TOKEN missing in ${envFile}`);
  return { name, httpUrl: d.httpUrl, collabUrl: d.collabUrl, ownerBearer, peerPriv, peerPub: pubFromPriv(peerPriv) };
}

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
interface NoteJson { id: string; content: string }
const createNote = (hub: Hub, body: { content: string; path: string; metadata?: Record<string, unknown> }) =>
  ownerJson<NoteJson>(hub, "/api/notes", { method: "POST", body: JSON.stringify(body) });
const getNote = (hub: Hub, id: string) => ownerJson<NoteJson>(hub, `/api/notes/${encodeURIComponent(id)}`);
const deleteNote = async (hub: Hub, id: string) => { try { await ownerFetch(hub, `/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { /* */ } };

async function reachable(hub: Hub): Promise<boolean> {
  try { const r = await fetch(`${hub.httpUrl}/auth/me`); return r.status === 200 || r.status === 401; } catch { return false; }
}
async function pollBoth(hub: Hub, id: string, m1: string, m2: string, timeoutMs: number): Promise<{ ok: boolean; content: string }> {
  const deadline = Date.now() + timeoutMs;
  let content = "";
  while (Date.now() < deadline) {
    try { const n = await getNote(hub, id); content = n.content ?? ""; if (content.includes(m1) && content.includes(m2)) return { ok: true, content }; } catch { /* */ }
    await sleep(750);
  }
  return { ok: false, content };
}

/** Open a live Yjs client to `collabUrl` under documentName `snk`, authed as a
 *  paired peer. Returns the synced doc + provider so the caller can drive a
 *  concurrent edit against TWO of these at once. */
async function openClient(collabUrl: string, snk: string, token: string): Promise<{ doc: Y.Doc; provider: HocuspocusProvider }> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: snk,
    token,
    document: doc,
    // @ts-expect-error WebSocketPolyfill accepted at runtime (node has no global WebSocket)
    WebSocketPolyfill: WebSocket,
  });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`collab sync timeout @ ${collabUrl} (auth rejected or hub unreachable)`)), 8000);
    provider.on("synced", () => { clearTimeout(t); res(); });
  });
  return { doc, provider };
}
/** Append a <p>marker</p> at START (pos 0) or END (push) of the TipTap fragment. */
function insertParagraph(doc: Y.Doc, marker: string, where: "start" | "end"): void {
  const frag = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, marker);
  p.insert(0, [text]);
  if (where === "start") frag.insert(0, [p]);
  else frag.push([p]);
}

const hubA = loadHub("HUB-A", path.resolve(SERVER_DIR, ".env"), { httpUrl: "http://localhost:8787", collabUrl: "ws://localhost:8787/collab" });
const hubB = loadHub("HUB-B", path.resolve(SERVER_DIR, ".env.b"), { httpUrl: "http://localhost:8788", collabUrl: "ws://localhost:8788/collab" });

let aSpaceId = "";
let snk = "";
let aNoteId = "";
let bNoteId = "";
let pairedAonB = false;
let pairedBonA = false;

async function main(): Promise<void> {
  console.log(`Hub A: ${hubA.httpUrl}  Hub B: ${hubB.httpUrl}`);
  if (!(await reachable(hubB))) { console.error(`❌ Hub B not up at ${hubB.httpUrl} — run scripts/two-hub-up.sh`); process.exit(2); }
  if (!(await reachable(hubA))) { console.error(`❌ Hub A not up at ${hubA.httpUrl}`); process.exit(2); }

  // ── pair A↔B (with collab URLs so syncSpaces self-discovers the bridge) ──
  log("setup: pair A↔B, space + space_note_key, mirror to B");
  interface Identity { publicKey: string; fingerprint: string }
  const idA = await ownerJson<Identity>(hubA, "/api/federation/identity");
  const idB = await ownerJson<Identity>(hubB, "/api/federation/identity");
  if (hubA.peerPub !== idA.publicKey) throw new Error("Hub A PEER_SIGNING_KEY ≠ its identity");
  if (hubB.peerPub !== idB.publicKey) throw new Error("Hub B PEER_SIGNING_KEY ≠ its identity");

  const codeA = await ownerJson<{ code: string }>(hubA, "/acl/peers/pair", { method: "POST", body: JSON.stringify({ label: "hub-B" }) });
  pairedBonA = !!(await ownerJson<{ ok: boolean }>(hubA, "/api/federation/pair", { method: "POST", body: JSON.stringify({ code: codeA.code, pubkey: idB.publicKey, label: "hub-B", collabUrl: hubB.collabUrl }) })).ok;
  const codeB = await ownerJson<{ code: string }>(hubB, "/acl/peers/pair", { method: "POST", body: JSON.stringify({ label: "hub-A" }) });
  pairedAonB = !!(await ownerJson<{ ok: boolean }>(hubB, "/api/federation/pair", { method: "POST", body: JSON.stringify({ code: codeB.code, pubkey: idA.publicKey, label: "hub-A", collabUrl: hubA.collabUrl }) })).ok;
  rec("pair", pairedAonB && pairedBonA ? "PASS" : "FAIL", `A→B=${pairedBonA}, B→A=${pairedAonB}`);

  // ── space + snk on A, real mirror→accept on B ──
  aSpaceId = (await ownerJson<{ id: string }>(hubA, "/acl/spaces", { method: "POST", body: JSON.stringify({ title: "CrdtConflictTest" }) })).id;
  const rnd = crypto.randomUUID().slice(0, 8);
  aNoteId = (await createNote(hubA, { content: "<p>seed</p>", path: `_test/crdt/${rnd}-a.md`, metadata: { type: "document" } })).id;
  const fed = await ownerJson<{ space_note_key: string; kind: string }>(hubA, `/acl/spaces/${aSpaceId}/notes`, { method: "POST", body: JSON.stringify({ noteId: aNoteId }) });
  snk = fed.space_note_key;

  const tokenAtoB = mkPeerConnToken(hubA.peerPriv, idA.publicKey, aSpaceId);
  const mirrorRes = await fetch(`${hubB.httpUrl}/api/federation/mirror`, { method: "POST", headers: { Authorization: `Bearer ${tokenAtoB}`, "Content-Type": "application/json" }, body: JSON.stringify({ spaceId: aSpaceId, spaceTitle: "CrdtConflictTest", notes: [{ spaceNoteKey: snk, kind: "document" }] }) });
  if (!mirrorRes.ok) throw new Error(`B /mirror → ${mirrorRes.status} ${await mirrorRes.text().catch(() => "")}`);
  const requestId = ((await mirrorRes.json()) as { requestId: string }).requestId;
  const accept = await ownerJson<{ mapped: Array<{ spaceNoteKey: string; localId: string }> }>(hubB, `/acl/federation/mirrors/${requestId}/accept`, { method: "POST", body: JSON.stringify({ level: "edit" }) });
  bNoteId = accept.mapped[0]?.localId ?? "";
  await ownerJson(hubA, `/acl/spaces/${aSpaceId}/peers`, { method: "POST", body: JSON.stringify({ pubkey: idB.publicKey, level: "edit" }) });
  await ownerJson(hubB, `/acl/spaces/${aSpaceId}/peers`, { method: "POST", body: JSON.stringify({ pubkey: idA.publicKey, level: "edit" }) });
  rec("mirror", snk && bNoteId ? "PASS" : "FAIL", `snk=${snk} → B local ${bNoteId}`);

  // Let both FederationManagers bind the bridge after the grant hooks fired.
  await sleep(3000);

  // ── CONCURRENT EDIT: two clients, same snk, different ends, before sync ──
  log("concurrent edit: client-A @start, client-B @end (same documentName)");
  const markA = `AAA-${crypto.randomUUID().slice(0, 8)}`;
  const markB = `BBB-${crypto.randomUUID().slice(0, 8)}`;
  // Editing the snk doc ALWAYS routes through the federation auth branch — present
  // a peer-conn token from a PEER of the hub being edited. A's peer is B; B's peer is A.
  const tokenToA = mkPeerConnToken(hubB.peerPriv, idB.publicKey, aSpaceId); // edit A's /collab as peer B
  const tokenToB = mkPeerConnToken(hubA.peerPriv, idA.publicKey, aSpaceId); // edit B's /collab as peer A

  const clientA = await openClient(hubA.collabUrl, snk, tokenToA);
  const clientB = await openClient(hubB.collabUrl, snk, tokenToB);
  // Apply BOTH edits back-to-back, no await between → genuinely concurrent
  // (neither has propagated to the other when the second is applied).
  insertParagraph(clientA.doc, markA, "start");
  insertParagraph(clientB.doc, markB, "end");
  rec("inject", "INFO", `applied ${markA} @A:start and ${markB} @B:end concurrently`);
  // Let the CRDT updates flush both ways and persist to both vaults.
  await sleep(4000);
  clientA.provider.destroy();
  clientB.provider.destroy();

  // ── assert: both markers survive in BOTH vaults; contents converge ──
  log("assert: no lost update + both hubs converge");
  const aRes = await pollBoth(hubA, aNoteId, markA, markB, 20000);
  const bRes = await pollBoth(hubB, bNoteId, markA, markB, 20000);
  rec("survive-A", aRes.ok ? "PASS" : "FAIL", aRes.ok ? `both ${markA} & ${markB} present in A's vault` : `A missing a marker (has A=${aRes.content.includes(markA)} B=${aRes.content.includes(markB)})`);
  rec("survive-B", bRes.ok ? "PASS" : "FAIL", bRes.ok ? `both ${markA} & ${markB} present in B's vault` : `B missing a marker (has A=${bRes.content.includes(markA)} B=${bRes.content.includes(markB)})`);

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const converged = aRes.ok && bRes.ok && norm(aRes.content) === norm(bRes.content);
  rec("converge", converged ? "PASS" : "FAIL", converged ? "A's vault === B's vault (identical merged content)" : "vault contents DIVERGED");
  console.log(`\n  A's content: ${norm(aRes.content)}`);
  console.log(`  B's content: ${norm(bRes.content)}`);
}

async function teardown(): Promise<void> {
  log("teardown");
  if (aSpaceId) {
    try { await ownerFetch(hubA, `/acl/spaces/${aSpaceId}`, { method: "DELETE" }); } catch { /* */ }
    try { await ownerFetch(hubB, `/acl/spaces/${aSpaceId}`, { method: "DELETE" }); } catch { /* */ }
  }
  if (aNoteId) await deleteNote(hubA, aNoteId);
  if (bNoteId) await deleteNote(hubB, bNoteId);
  try { const idB = await ownerJson<{ publicKey: string }>(hubB, "/api/federation/identity"); if (pairedBonA) await ownerFetch(hubA, `/acl/peers/${encodeURIComponent(idB.publicKey)}`, { method: "DELETE" }); } catch { /* */ }
  try { const idA = await ownerJson<{ publicKey: string }>(hubA, "/api/federation/identity"); if (pairedAonB) await ownerFetch(hubB, `/acl/peers/${encodeURIComponent(idA.publicKey)}`, { method: "DELETE" }); } catch { /* */ }
  console.log("  cleaned test note, space, federated rows, and peer pairings on both hubs");
}

main()
  .catch((e) => { console.error("\nERROR:", e instanceof Error ? e.message : e); fail++; })
  .finally(async () => {
    await teardown().catch((e) => console.error("teardown error:", e));
    console.log(`\n=== CRDT conflict: ${fail === 0 ? "ALL PASS" : `${fail} FAIL`} ===`);
    process.exit(fail === 0 ? 0 : 1);
  });
