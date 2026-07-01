/**
 * Verify SERVER-SIDE Matrix sync end-to-end on the LIVE stack: create a fresh
 * Matrix room, send a message, run the worker's ingest, and confirm a
 * message-thread note for that room landed in the prod vault with the message —
 * then clean up (delete the note, leave the room). Proves the new connection
 * before we disable the desktop sync.
 *
 * Run with the live db + env (so it shares the worker's secret + cursor):
 *   DB_PATH=/Users/benjaminlife/dev/prism/apps/server/prism-server.db \
 *   node --env-file=/Users/benjaminlife/dev/prism/apps/server/.env \
 *        --import tsx scripts/verify-matrix-cutover.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { runMatrixOnce } = await import("../src/worker/scheduler.js");
  const { vaultClient } = await import("../src/parachute.js");
  const { resolveVaultEntry } = await import("../src/db.js");

  const cfg = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/prism/prism-config.json`, "utf8"));
  const hs = String(cfg.matrix_homeserver).replace(/\/+$/, "");
  const tok = String(cfg.matrix_access_token);
  const mx = (path: string, init?: RequestInit) =>
    fetch(`${hs}/_matrix/client/v3${path}`, { ...init, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...(init?.headers as Record<string, string>) } });

  console.log("=== 1. create a throwaway Matrix room + send a message ===");
  const marker = `server-cutover-verify-${Date.now()}`;
  const room = (await (await mx("/createRoom", { method: "POST", body: JSON.stringify({ name: marker, preset: "private_chat" }) })).json()) as { room_id: string };
  const roomId = room.room_id;
  await mx(`/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${Date.now()}`, { method: "PUT", body: JSON.stringify({ msgtype: "m.text", body: `🟢 ${marker}` }) });
  console.log(`  room ${roomId} created, message sent`);
  await sleep(1500); // let the homeserver settle the event into the timeline

  console.log("=== 2. run the worker ingest (same path the running worker uses) ===");
  const n = await runMatrixOnce(resolveVaultEntry("primary"));
  console.log(`  worker ingested ${n} new message(s)`);

  console.log("=== 3. confirm a message-thread note for the room has the message ===");
  const vault = vaultClient("primary");
  const notes = await vault.listNotes({ tags: ["message-thread"], includeContent: true });
  const note = notes.find((x) => x.metadata?.matrixRoomId === roomId);
  let pass = false;
  if (note) {
    pass = note.content.includes(marker);
    console.log(`  ${pass ? "✓" : "✗"} note ${note.id} ${pass ? "contains" : "MISSING"} the test message`);
  } else {
    console.log("  ✗ no note found for the test room");
  }

  console.log("=== 4. cleanup (delete the test note, leave the room) ===");
  try {
    if (note) await vault.deleteNote(note.id);
    await mx(`/rooms/${encodeURIComponent(roomId)}/leave`, { method: "POST", body: "{}" });
    await mx(`/rooms/${encodeURIComponent(roomId)}/forget`, { method: "POST", body: "{}" });
    console.log("  cleaned up");
  } catch (e) {
    console.log("  (cleanup note:", (e as Error).message, ")");
  }

  console.log(`\n=== ${pass ? "PASS — server-side Matrix sync is live and working" : "FAIL — see above"} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-matrix-cutover crashed:", e);
  process.exit(1);
});
