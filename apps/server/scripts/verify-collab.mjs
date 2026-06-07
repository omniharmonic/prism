/**
 * P3 collab e2e. Proves, against the running Prism Server + live vault:
 *  - onLoadDocument seeds the Y.Doc from Parachute (owner browser not required)
 *  - two edit clients sync live (CRDT)
 *  - edits persist back to Parachute (onStoreDocument)
 *  - a view-level capability connects read-only (its edits are dropped)
 *
 * Run: node --env-file=.env apps/server/scripts/verify-collab.mjs   (from apps/server)
 */
import { readFileSync } from "node:fs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

const noteId = readFileSync("/tmp/p3-note.txt", "utf8").trim();
const editToken = readFileSync("/tmp/p3-edit.txt", "utf8").trim();
const viewToken = readFileSync("/tmp/p3-view.txt", "utf8").trim();
const URL = "ws://localhost:8787/collab";
const TOKEN = readFileSync(".env", "utf8").match(/PARACHUTE_TOKEN=(.+)/)[1].trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? `  [${detail}]` : ""}`);
};

function connect(token) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: URL,
    name: noteId,
    token,
    document: doc,
    WebSocketPolyfill: WebSocket,
    onAuthenticationFailed: (d) => console.log("  [provider] auth failed:", JSON.stringify(d)),
    onStatus: (d) => console.log("  [provider] status:", d?.status),
    onConnect: () => console.log("  [provider] connected"),
    onClose: (d) => console.log("  [provider] close:", d?.event?.code, d?.event?.reason),
    onSynced: () => console.log("  [provider] synced"),
  });
  return { doc, provider };
}

async function waitSynced(provider, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (provider.isSynced || provider.synced) return true;
    await sleep(100);
  }
  return false;
}

const fragText = (doc) => doc.getXmlFragment("default").toString();

function appendParagraph(doc, text) {
  doc.transact(() => {
    const frag = doc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, text);
    p.push([t]);
    frag.push([p]);
  });
}

(async () => {
  // 1. Client A (edit) — should seed from Parachute
  const A = connect(editToken);
  const aSynced = await waitSynced(A.provider);
  await sleep(500);
  check("A connects (edit) + syncs", aSynced);
  check("onLoadDocument seeded from Parachute", fragText(A.doc).includes("seed line from parachute"), fragText(A.doc).slice(0, 60));

  // 2. Client B (edit) — receives the same doc
  const B = connect(editToken);
  await waitSynced(B.provider);
  await sleep(500);
  check("B connects (edit) + sees seeded content", fragText(B.doc).includes("seed line from parachute"));

  // 3. A edits → B sees it live
  appendParagraph(A.doc, "EDIT FROM A");
  await sleep(800);
  check("live sync A→B", fragText(B.doc).includes("EDIT FROM A"));

  // 4. Persist to Parachute (onStoreDocument debounce ~2s)
  await sleep(3500);
  const note = await (
    await fetch(`http://localhost:1940/vault/default/api/notes/${noteId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  ).json();
  check("edit persisted to Parachute", (note.content || "").includes("EDIT FROM A"), (note.content || "").slice(0, 80));

  // 5. View client is read-only — its edit must NOT propagate or persist
  const C = connect(viewToken);
  const cSynced = await waitSynced(C.provider);
  await sleep(500);
  check("C connects (view) + syncs", cSynced);
  appendParagraph(C.doc, "EDIT FROM C VIEW");
  await sleep(1500);
  check("view edit does NOT reach A (read-only enforced)", !fragText(A.doc).includes("EDIT FROM C VIEW"));
  await sleep(3000);
  const note2 = await (
    await fetch(`http://localhost:1940/vault/default/api/notes/${noteId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  ).json();
  check("view edit not persisted to Parachute", !(note2.content || "").includes("EDIT FROM C VIEW"));

  A.provider.destroy();
  B.provider.destroy();
  C.provider.destroy();

  const ok = checks.every((c) => c.pass);
  console.log(ok ? "\nALL COLLAB CHECKS PASSED" : "\nFAILURES ABOVE");
  process.exit(ok ? 0 : 1);
})();
