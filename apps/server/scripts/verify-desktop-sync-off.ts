/**
 * Confirm the desktop's message_sync is OFF after the cutover: send a marked
 * Matrix message, let the SERVER ingest it (once), then wait > one desktop tick
 * interval and confirm the marker appears EXACTLY ONCE in the note. Twice ⇒ the
 * desktop is still syncing too (cutover failed). Cleans up after.
 *
 *   DB_PATH=/Users/benjaminlife/dev/prism/apps/server/prism-server.db \
 *   node --env-file=/Users/benjaminlife/dev/prism/apps/server/.env \
 *        --import tsx scripts/verify-desktop-sync-off.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

async function main() {
  const { runMatrixOnce } = await import("../src/worker/scheduler.js");
  const { vaultClient } = await import("../src/parachute.js");
  const { resolveVaultEntry } = await import("../src/db.js");

  const cfg = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/prism/prism-config.json`, "utf8"));
  console.log(`  desktop config disable_message_sync = ${cfg.disable_message_sync}`);
  const hs = String(cfg.matrix_homeserver).replace(/\/+$/, "");
  const tok = String(cfg.matrix_access_token);
  const mx = (p: string, init?: RequestInit) =>
    fetch(`${hs}/_matrix/client/v3${p}`, { ...init, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...(init?.headers as Record<string, string>) } });

  // The marker must appear ONLY in the message body — NOT in the room name (the
  // room name becomes the note title, which would inflate the count).
  const marker = `desktopoffcheck${Date.now()}xyz`;
  const room = (await (await mx("/createRoom", { method: "POST", body: JSON.stringify({ name: "prism-sync-verify-room", preset: "private_chat" }) })).json()) as { room_id: string };
  await mx(`/rooms/${encodeURIComponent(room.room_id)}/send/m.room.message/${Date.now()}`, { method: "PUT", body: JSON.stringify({ msgtype: "m.text", body: marker }) });
  console.log(`  sent marker to ${room.room_id}`);
  await sleep(1500);

  await runMatrixOnce(resolveVaultEntry("primary"));
  const vault = vaultClient("primary");
  const note1 = (await vault.listNotes({ tags: ["message-thread"], includeContent: true })).find((n) => n.metadata?.matrixRoomId === room.room_id);
  console.log(`  after server ingest: marker count = ${note1 ? count(note1.content, marker) : "(no note)"}`);

  console.log("  waiting 70s for any desktop tick to (not) double-append…");
  await sleep(70_000);
  await runMatrixOnce(resolveVaultEntry("primary")); // server idempotent (cursor past it)
  const note2 = (await vault.listNotes({ tags: ["message-thread"], includeContent: true })).find((n) => n.metadata?.matrixRoomId === room.room_id);
  const finalCount = note2 ? count(note2.content, marker) : 0;
  const pass = finalCount === 1;
  console.log(`  final marker count = ${finalCount}`);

  // cleanup
  try {
    if (note2) await vault.deleteNote(note2.id);
    await mx(`/rooms/${encodeURIComponent(room.room_id)}/leave`, { method: "POST", body: "{}" });
    await mx(`/rooms/${encodeURIComponent(room.room_id)}/forget`, { method: "POST", body: "{}" });
  } catch {
    /* best effort */
  }

  console.log(`\n=== ${pass ? "PASS — desktop sync is OFF; server is the sole syncer (no duplication)" : `FAIL — marker appeared ${finalCount}× (desktop still syncing)`} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
