/**
 * READ-ONLY dry run of the Comms DM-vs-group rule (phase 2b S1, fix round 1 I1).
 *
 * For every Matrix conversation the projection holds, reads the room's state + joined members from
 * the homeserver (GET only) and prints, PER NETWORK, how many rooms would change kind:
 *   old         = the rule before 2b: bridge room type, else "≤ 2 others = DM"
 *   new         = the shipped rule: bridge room type, else strict (one distinct other person) on
 *                 WhatsApp only, the old tolerance elsewhere
 *   strict-all  = what the strict rule would do on EVERY network (for deciding to widen it later)
 *   stored      = the kind the projection holds now (what a rebuild would change)
 * Counts only: no room ids, names, member ids or numbers are printed.
 *
 * Nothing is written: the server's database is opened read-only, the module-level database the
 * imported code would open is redirected to memory, and the Matrix calls are GETs.
 *
 * Usage (on the server host, from apps/server):
 *   node --env-file=.env --import tsx scripts/comms-kind-dryrun.ts [--db <path>] [--concurrency 4] [--owner-ids @a:hs,@b:hs]
 * Needs DB_PATH (or --db), SECRETS_KEY, OWNER_EMAIL and the primary vault in the env (the server's .env).
 * Self ids = whoami + OMNI_AGENT_MATRIX_IDS + the stored owner ghosts (comms_owner_senders) +
 * COMMS_OWNER_GHOSTS + --owner-ids. The owner's person-note Matrix ids are NOT read (no vault call):
 * pass them with --owner-ids if he has any, else rooms holding them may count as flips that a real
 * rebuild would not make (the counts err towards "more flips").
 */
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const realDbPath = path.resolve(arg("db") ?? process.env.DB_PATH ?? "./prism-server.db");
// Every module below that imports ../src/db opens THIS instead of the real file (migrations included).
process.env.DB_PATH = ":memory:";
process.env.TREE_SUBSCRIBE = "0";

function masterKey(): Buffer {
  const raw = (process.env.SECRETS_KEY ?? "").trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("SECRETS_KEY is missing or not 32 bytes");
  return buf;
}

async function main(): Promise<void> {
  const { config, vaultRegistry } = await import("../src/config");
  const { MatrixClient, agentSenderIds, isBridgeBot } = await import("../src/worker/matrix");
  const { bridgeRoomType, projectionState, roomMetaFromState, untypedKind } = await import("../src/comms/room-meta");

  const real = new Database(realDbPath, { readonly: true, fileMustExist: true });
  const vaultId = vaultRegistry[0]!.id;
  const row = real.prepare(`SELECT ciphertext, iv FROM tenant_secrets WHERE vault_id = ? AND owner_email = ? AND kind = 'matrix'`)
    .get(vaultId, config.ownerEmail) as { ciphertext: Buffer; iv: Buffer } | undefined;
  if (!row) throw new Error("no Matrix credential stored for the primary vault");
  const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), row.iv);
  d.setAuthTag(row.ciphertext.subarray(row.ciphertext.length - 16));
  const creds = JSON.parse(Buffer.concat([d.update(row.ciphertext.subarray(0, row.ciphertext.length - 16)), d.final()]).toString("utf8"));
  const client = new MatrixClient(creds, fetch, 15_000);

  const me = await client.whoami();
  const hasTable = (t: string) => !!real.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
  const stored = hasTable("comms_owner_senders") ? (real.prepare(`SELECT mxid FROM comms_owner_senders`).all() as { mxid: string }[]).map((r) => r.mxid) : [];
  const extra = [...(process.env.COMMS_OWNER_GHOSTS ?? "").split(","), ...(arg("owner-ids") ?? "").split(",")];
  const selfIds = [...new Set([me, ...agentSenderIds(), ...stored, ...extra].map((i) => i.trim().toLowerCase()).filter(Boolean))];

  const rooms = real.prepare(`SELECT source_ref AS room, kind FROM comms_conversations WHERE source_ref LIKE '!%'`).all() as { room: string; kind: string }[];
  real.close();

  type Tally = { rooms: number; typed: number; failed: number; oldToNew: Record<string, number>; strictAll: Record<string, number>; storedToNew: Record<string, number> };
  const by = new Map<string, Tally>();
  const tally = (n: string): Tally => {
    let t = by.get(n);
    if (!t) by.set(n, (t = { rooms: 0, typed: 0, failed: 0, oldToNew: {}, strictAll: {}, storedToNew: {} }));
    return t;
  };
  const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
  let failed = 0;

  const concurrency = Math.max(1, Math.min(16, Number(arg("concurrency") ?? 4) || 4));
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= rooms.length) return;
      const r = rooms[i]!;
      try {
        const [stateRaw, profiles] = await Promise.all([client.roomState(r.room), client.memberProfiles(r.room)]);
        const state = projectionState(stateRaw);
        const memberIds = Object.keys(profiles);
        const names = Object.fromEntries(memberIds.map((id) => [id, profiles[id]?.name ?? null]));
        const meta = roomMetaFromState(state, memberIds, selfIds, names);
        const t = tally(meta.network);
        t.rooms++;
        const type = bridgeRoomType(state);
        if (type) t.typed++;
        const self = new Set(selfIds);
        const people = memberIds.filter((m) => !self.has(m.toLowerCase()) && !isBridgeBot(m));
        const oldKind = type ?? (people.length <= 2 ? "dm" : "group");
        const strictAll = type ?? untypedKind(meta.network, people, names, meta.roomName, true);
        if (oldKind !== meta.kind) bump(t.oldToNew, `${oldKind}→${meta.kind}`);
        if (oldKind !== strictAll) bump(t.strictAll, `${oldKind}→${strictAll}`);
        if (r.kind !== meta.kind) bump(t.storedToNew, `${r.kind}→${meta.kind}`);
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  console.log(`Comms kind dry run — ${rooms.length} Matrix conversations, ${failed} unreadable, ${selfIds.length} self ids`);
  for (const [n, t] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${n.padEnd(10)} rooms ${String(t.rooms).padStart(5)}  typed ${String(t.typed).padStart(5)}  | old→new: ${fmt(t.oldToNew)}  | if strict everywhere: ${fmt(t.strictAll)}  | stored→new (rebuild changes): ${fmt(t.storedToNew)}`);
  }
}

main().catch((e) => {
  console.error(`dry run failed: ${(e as Error)?.message ?? e}`);
  process.exit(1);
});
