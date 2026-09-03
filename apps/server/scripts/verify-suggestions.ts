/**
 * verify-suggestions.ts — LIVE suggest-mode capture + apply (G2b / handoff AC-10).
 *
 * Drives a REAL suggest-level Yjs client against a running Prism Server and
 * asserts the full loop the handoff deferred:
 *
 *   1. a suggest-capability client connects to /collab and types marked
 *      insertions/deletions (the shared schema's insertion/deletion marks)
 *   2. the server PERSISTS the doc and captures a durable pending_suggestions
 *      row per suggesting author (the owner's review queue)
 *   3. POST /acl/suggestions/:id/accept APPLIES the author's suggestions to the
 *      live note (insertions kept unmarked, deletions removed)
 *   4. reject applies the inverse (insertions removed, deletions kept)
 *
 * Stack-agnostic: HUB_ENV (default apps/server/.env) + HUB_URL/HUB_COLLAB.
 * Works against the mock stack too:
 *   ./scripts/two-hub-mock.sh --keep
 *   cd apps/server && HUB_ENV=.env.mock-a node --import tsx scripts/verify-suggestions.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Status = "PASS" | "FAIL" | "INFO";
let fail = 0;
function rec(step: string, status: Status, msg = ""): void {
  if (status === "FAIL") fail++;
  console.log(`${status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "ℹ️ "} ${step.padEnd(18)} ${msg}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

const env = parseEnv(process.env.HUB_ENV ?? path.resolve(SERVER_DIR, ".env"));
const BASE = process.env.HUB_URL ?? `http://localhost:${env.PORT ?? "8787"}`;
const COLLAB = process.env.HUB_COLLAB ?? BASE.replace(/^http/, "ws") + "/collab";
const BEARER = env.COLLAB_TOKEN || env.PARACHUTE_TOKEN || "";
if (!BEARER) throw new Error("COLLAB_TOKEN/PARACHUTE_TOKEN missing (set HUB_ENV)");

async function owner<T = unknown>(p: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${BEARER}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${p} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

interface SuggestionRow {
  id: string;
  noteId: string;
  author: string | null;
  summary: string | null;
  status: string;
}

/** Connect as a suggest-level client and type marked suggestion runs. */
async function suggestEdit(noteId: string, token: string, runs: Array<{ text: string; mark: "insertion" | "deletion" }>): Promise<void> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: COLLAB,
    name: noteId,
    token,
    document: doc,
    // @ts-expect-error runtime polyfill (node has no global WebSocket)
    WebSocketPolyfill: WebSocket,
  });
  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("collab sync timeout")), 8000);
      provider.on("synced", () => {
        clearTimeout(t);
        res();
      });
    });
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    const parts: Y.XmlText[] = [];
    for (const run of runs) {
      const t = new Y.XmlText();
      t.insert(0, run.text, { [run.mark]: { user: "Suggester", color: run.mark === "insertion" ? "#22c55e" : "#ef4444" } });
      parts.push(t);
    }
    p.insert(0, parts);
    frag.push([p]);
    await sleep(1500); // let the update flush
  } finally {
    provider.destroy(); // last connection closing triggers the store
  }
}

async function pollUntil<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 20000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(500);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
console.log(`Hub: ${BASE}  (collab ${COLLAB})`);
const note = await owner<{ id: string }>("/api/notes", { method: "POST", body: JSON.stringify({ content: "<p>hello world</p>" }) });
rec("setup", "INFO", `note ${note.id}`);

let suggestionId = "";
try {
  // suggest-level capability (the recipient's only credential)
  const link = await owner<{ url: string }>(`/acl/notes/${note.id}/links`, { method: "POST", body: JSON.stringify({ level: "suggest" }) });
  const token = new URL(link.url).searchParams.get("t") ?? "";
  if (!token) throw new Error("no capability token in link url");
  rec("capability", "PASS", "suggest-level link minted");

  // 1+2: live marked edit → durable capture
  await suggestEdit(note.id, token, [
    { text: "brave ", mark: "insertion" },
    { text: " cruel", mark: "deletion" },
  ]);
  const captured = await pollUntil("pending suggestion row", async () => {
    const rows = await owner<SuggestionRow[]>("/acl/suggestions?status=pending");
    return rows.find((r) => r.noteId === note.id && r.author === "Suggester") ?? null;
  });
  suggestionId = captured.id;
  rec("capture", "PASS", `queued: "${captured.summary}"`);

  const withMarks = await owner<{ content: string }>(`/api/notes/${note.id}`);
  if (!withMarks.content.includes("data-suggestion")) throw new Error("persisted content lost the marks");
  rec("persist", "PASS", "marks survived the HTML round-trip (attribution intact)");

  // 3: accept applies
  const acc = await owner<{ applied: boolean }>(`/acl/suggestions/${suggestionId}/accept`, { method: "POST" });
  if (!acc.applied) throw new Error("accept did not apply");
  const after = await pollUntil("accepted content", async () => {
    const n = await owner<{ content: string }>(`/api/notes/${note.id}`);
    return n.content.includes("brave") && !n.content.includes("cruel") && !n.content.includes("data-suggestion") ? n : null;
  });
  rec("accept-applies", "PASS", `content: ${after.content.slice(0, 60)}…`);

  // 4: a second suggested run, rejected → text does NOT land
  await suggestEdit(note.id, token, [{ text: " REJECTME", mark: "insertion" }]);
  const captured2 = await pollUntil("second pending row", async () => {
    const rows = await owner<SuggestionRow[]>("/acl/suggestions?status=pending");
    return rows.find((r) => r.noteId === note.id && r.author === "Suggester") ?? null;
  });
  await owner(`/acl/suggestions/${captured2.id}/reject`, { method: "POST" });
  await pollUntil("rejected content", async () => {
    const n = await owner<{ content: string }>(`/api/notes/${note.id}`);
    return !n.content.includes("REJECTME") && !n.content.includes("data-suggestion") ? n : null;
  });
  rec("reject-applies", "PASS", "rejected insertion removed, no marks remain");
} finally {
  // teardown: remove the test note (+ any leftover suggestion rows)
  try {
    const rows = await owner<SuggestionRow[]>("/acl/suggestions");
    for (const r of rows) if (r.noteId === note.id) await owner(`/acl/suggestions/${r.id}`, { method: "DELETE" });
    await fetch(`${BASE}/api/notes/${note.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${BEARER}` } });
  } catch {
    /* best-effort */
  }
}

console.log(fail === 0 ? "\n=== suggest-mode capture + apply: ALL PASS ===" : `\n=== ${fail} FAILURE(S) ===`);
process.exit(fail === 0 ? 0 : 1);
