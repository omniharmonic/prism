/**
 * LIVE check of server-side Google Docs sync: the server (colocated with `gog`)
 * creates a Google Doc from note content, writes it, reads it back, checks the
 * modified time, then trashes the doc. Proves push+pull work server-side via gog
 * — no desktop app. Uses the account from the desktop config.
 *
 *   node --import tsx scripts/verify-googledocs-sync.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, d = "") => { console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${l}${d ? ` — ${d}` : ""}`); c ? pass++ : fail++; };

async function main() {
  const { GoogleDocsClient, pushNoteToGoogleDoc, pullGoogleDoc } = await import("../src/worker/googledocs.js");
  const cfg = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/prism/prism-config.json`, "utf8"));
  const account = String(cfg.google_account_primary || "");
  ok("google account configured", !!account, account);

  const client = new GoogleDocsClient(account);
  const marker = `prism-gdocs-e2e-${Date.now()}`;
  const note = { path: `vault/_test/${marker}`, content: `# ${marker}\n\nThis document was created by the SERVER-SIDE Google Docs sync via gog.\n\n- point one\n- point two\n` };

  console.log("=== PUSH: create a Google Doc from note content ===");
  let docId = "";
  try {
    const res = await pushNoteToGoogleDoc(client, note);
    docId = res.docId;
    ok("created + wrote a Google Doc", res.created && !!docId, `docId=${docId}`);
  } catch (e) {
    ok("created + wrote a Google Doc", false, (e as Error).message);
  }

  if (docId) {
    console.log("=== PULL: read the doc back ===");
    try {
      const text = await pullGoogleDoc(client, docId);
      ok("read-back contains the marker + a bullet", text.includes(marker) && /point one/.test(text), `len=${text.length}`);
    } catch (e) {
      ok("read-back", false, (e as Error).message);
    }

    console.log("=== update an existing doc (second push) ===");
    try {
      await pushNoteToGoogleDoc(client, { path: note.path, content: `# ${marker}\n\nEDITED BY SERVER.` }, docId);
      const text2 = await pullGoogleDoc(client, docId);
      ok("existing-doc update reflected", text2.includes("EDITED BY SERVER"));
    } catch (e) {
      ok("existing-doc update", false, (e as Error).message);
    }

    console.log("=== remoteRevision (change detection token) ===");
    try {
      const rev = await client.remoteRevision(docId);
      ok("revisionId available for change detection", !!rev, String(rev).slice(0, 24) + "…");
    } catch (e) {
      ok("remoteRevision", false, (e as Error).message);
    }

    console.log("=== teardown: trash the doc ===");
    await client.trashDoc(docId);
    console.log("  trashed");
  }

  console.log(`\n=== ${fail === 0 ? "PASS — server-side Google Docs sync works (push + pull via gog)" : "see failures"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
