/**
 * READ-ONLY dry run of Telegram forum grouping (comms/forums.ts).
 *
 * For every Telegram conversation the projection holds, reads the room's state from the homeserver
 * (GET only) and prints how many forums and topics a rebuild with grouping would form, and what the
 * merge would decide from the per-topic threads' owner state (archived / muted / pinned / in a folder).
 * Counts only: no room ids, names, titles, member ids or message text are printed.
 *
 * Nothing is written: the server's database is opened read-only, the module-level database the
 * imported code would open is redirected to memory, and the Matrix calls are GETs.
 *
 * Usage (on the server host, from apps/server):
 *   node --env-file=.env --import tsx scripts/comms-forums-dryrun.ts [--db <path>] [--concurrency 4]
 * Needs DB_PATH (or --db), SECRETS_KEY, OWNER_EMAIL and the primary vault in the env (the server's .env).
 */
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const realDbPath = path.resolve(arg("db") ?? process.env.DB_PATH ?? "./prism-server.db");
process.env.DB_PATH = ":memory:";
process.env.TREE_SUBSCRIBE = "0";

function masterKey(): Buffer {
  const raw = (process.env.SECRETS_KEY ?? "").trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("SECRETS_KEY is missing or not 32 bytes");
  return buf;
}

/** Pure: tally forums from (room → forum key | null) and each room's per-thread owner state. */
export function tallyForums(rooms: Array<{ forumKey: string | null; archived: boolean; muted: boolean; pinned: boolean; inFolder: boolean }>) {
  const forums = new Map<string, typeof rooms>();
  for (const r of rooms) if (r.forumKey) forums.set(r.forumKey, [...(forums.get(r.forumKey) ?? []), r]);
  const sizes = [...forums.values()].map((t) => t.length).sort((a, b) => b - a);
  const out = {
    telegramRooms: rooms.length,
    forums: forums.size,
    topics: sizes.reduce((a, b) => a + b, 0),
    listRowsBefore: rooms.length,
    listRowsAfter: rooms.length - sizes.reduce((a, b) => a + b, 0) + forums.size,
    largestForums: sizes.slice(0, 5),
    forumsArchivedAfterMerge: 0, forumsPartlyArchived: 0, forumsMuted: 0, forumsPartlyMuted: 0, forumsPinned: 0, forumsInAFolder: 0,
  };
  for (const t of forums.values()) {
    const archived = t.filter((x) => x.archived).length;
    if (archived === t.length) out.forumsArchivedAfterMerge++;
    else if (archived) out.forumsPartlyArchived++;
    const muted = t.filter((x) => x.muted).length;
    if (muted === t.length) out.forumsMuted++;
    else if (muted) out.forumsPartlyMuted++;
    if (t.some((x) => x.pinned) && archived !== t.length) out.forumsPinned++;
    if (t.some((x) => x.inFolder)) out.forumsInAFolder++;
  }
  return out;
}

async function main(): Promise<void> {
  const { config, vaultRegistry } = await import("../src/config");
  const { MatrixClient } = await import("../src/worker/matrix");
  const { projectionState, roomMetaFromState } = await import("../src/comms/room-meta");

  const real = new Database(realDbPath, { readonly: true, fileMustExist: true });
  const vaultId = vaultRegistry[0]!.id;
  const row = real.prepare(`SELECT ciphertext, iv FROM tenant_secrets WHERE vault_id = ? AND owner_email = ? AND kind = 'matrix'`)
    .get(vaultId, config.ownerEmail) as { ciphertext: Buffer; iv: Buffer } | undefined;
  if (!row) throw new Error("no Matrix credential stored for the primary vault");
  const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), row.iv);
  d.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - 16));
  const creds = JSON.parse(Buffer.concat([d.update(row.ciphertext.subarray(0, row.ciphertext.length - 16)), d.final()]).toString("utf8"));
  const client = new MatrixClient(creds, fetch, 15_000);

  const cols = (t: string) => (real.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  const hasTable = (t: string) => !!real.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  const tc = cols("comms_threads");
  const sel = (c: string) => (tc.includes(c) ? `t.${c}` : "NULL");
  const folders = hasTable("comms_folder_members");
  const rooms = real.prepare(`SELECT c.source_ref AS room, ${sel("o_archived")} AS archived, ${sel("o_muted")} AS muted, ${sel("o_pinned")} AS pinned,
      ${folders ? "EXISTS (SELECT 1 FROM comms_folder_members fm WHERE fm.thread_id = t.id)" : "0"} AS in_folder
    FROM comms_conversations c JOIN comms_thread_members m ON m.conversation_id = c.id JOIN comms_threads t ON t.id = m.thread_id
    WHERE c.network = 'telegram' AND c.source_ref LIKE '!%'`).all() as { room: string; archived: number | null; muted: number | null; pinned: number | null; in_folder: number }[];
  real.close();

  const out: Parameters<typeof tallyForums>[0] = [];
  let failed = 0;
  const concurrency = Math.max(1, Math.min(16, Number(arg("concurrency") ?? 4) || 4));
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= rooms.length) return;
      const r = rooms[i]!;
      try {
        const meta = roomMetaFromState(projectionState(await client.roomState(r.room)), [], []);
        out.push({ forumKey: meta.forum?.key ?? null, archived: r.archived === 1, muted: r.muted === 1, pinned: r.pinned === 1, inFolder: r.in_folder === 1 });
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const t = tallyForums(out);
  console.log(`Comms forum dry run — ${rooms.length} Telegram conversations, ${failed} unreadable`);
  console.log(`forums ${t.forums}, topics ${t.topics} (largest: ${t.largestForums.join(", ") || "-"})`);
  console.log(`Telegram list rows: ${t.listRowsBefore} now → ${t.listRowsAfter} after grouping`);
  console.log(`merge: ${t.forumsArchivedAfterMerge} forums archived (every topic was), ${t.forumsPartlyArchived} partly archived → inbox, ` +
    `${t.forumsMuted} muted, ${t.forumsPartlyMuted} partly muted → unmuted, ${t.forumsPinned} pinned, ${t.forumsInAFolder} in an owner folder`);
}

if (process.argv[1] && /comms-forums-dryrun/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`dry run failed: ${(e as Error)?.message ?? e}`);
    process.exit(1);
  });
}
