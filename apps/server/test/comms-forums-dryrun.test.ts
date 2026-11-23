// scripts/comms-forums-dryrun.ts — forum/topic counts and merge outcomes only, read-only, GETs only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { config } from "../src/config";

const KEY = Buffer.alloc(32, 7);
const ME = "@omni-agent:localhost";
const topic = (chat: string, t: string, name: string) => [
  { type: "m.bridge", state_key: "b", content: { protocol: { id: "telegram" }, channel: { id: `channel:${chat}:${t}`, displayname: "Topic Secret" }, network: { id: `channel:${chat}:-1`, displayname: name } } },
];
const STATE: Record<string, unknown[]> = {
  "!a1:hs": topic("1001", "1", "Treegens Secret"),
  "!a2:hs": topic("1001", "7", "Treegens Secret"),
  "!a3:hs": topic("1001", "9", "Treegens Secret"),
  "!b1:hs": topic("2002", "1", "Other Secret"),
  "!b2:hs": topic("2002", "4", "Other Secret"),
  "!g:hs": [{ type: "m.bridge", state_key: "b", content: { protocol: { id: "telegram" }, channel: { id: "channel:3003" } } }],
};
let methods: string[] = [];
let server: http.Server;
let dir = "";
let dbFile = "";
before(async () => {
  server = http.createServer((req, res) => {
    methods.push(req.method ?? "");
    const u = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const send = (b: unknown, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.method !== "GET") return send({ errcode: "M_FORBIDDEN" }, 403);
    if (u.endsWith("/account/whoami")) return send({ user_id: ME });
    const m = /\/rooms\/([^/]+)\/state$/.exec(u);
    const s = m ? STATE[m[1]!] : undefined;
    return s ? send(s) : send({ errcode: "M_NOT_FOUND" }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "comms-forums-dryrun-"));
  dbFile = path.join(dir, "prism.db");
  const db = new Database(dbFile);
  db.exec(`CREATE TABLE tenant_secrets (vault_id TEXT, owner_email TEXT, kind TEXT, ciphertext BLOB, iv BLOB, created_at INTEGER);
    CREATE TABLE comms_conversations (id TEXT PRIMARY KEY, source_ref TEXT, network TEXT);
    CREATE TABLE comms_threads (id TEXT PRIMARY KEY, o_archived INTEGER, o_muted INTEGER, o_pinned INTEGER);
    CREATE TABLE comms_thread_members (thread_id TEXT, conversation_id TEXT);
    CREATE TABLE comms_folder_members (folder_id TEXT, thread_id TEXT);`);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify({ homeserver: base, accessToken: "fixture-token" }), "utf8"), c.final()]);
  db.prepare(`INSERT INTO tenant_secrets VALUES ('primary', ?, 'matrix', ?, ?, 0)`).run(config.ownerEmail, Buffer.concat([enc, c.getAuthTag()]), iv);
  const rows: Array<[string, number | null, number | null, number | null]> = [
    ["!a1:hs", 1, 1, null], ["!a2:hs", 1, 1, null], ["!a3:hs", 1, 1, null], // forum A: all archived + muted
    ["!b1:hs", 1, 1, 1], ["!b2:hs", null, null, null], // forum B: partly archived, partly muted, one pinned
    ["!g:hs", null, null, null],
  ];
  for (const [i, [room, a, m, p]] of rows.entries()) {
    db.prepare(`INSERT INTO comms_conversations VALUES (?, ?, 'telegram')`).run(`c${i}`, room);
    db.prepare(`INSERT INTO comms_threads VALUES (?, ?, ?, ?)`).run(`th_c${i}`, a, m, p);
    db.prepare(`INSERT INTO comms_thread_members VALUES (?, ?)`).run(`th_c${i}`, `c${i}`);
  }
  db.prepare(`INSERT INTO comms_folder_members VALUES ('f', 'th_c3')`).run();
  db.close();
});
after(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("prints forum + topic counts and merge outcomes only; writes nothing; GETs only", async () => {
  const sha = () => crypto.createHash("sha256").update(fs.readFileSync(dbFile)).digest("hex");
  const before = sha();
  methods = [];
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--env-file=.env.test", "--import", "tsx", "scripts/comms-forums-dryrun.ts", "--db", dbFile], {
      cwd: process.cwd(), env: { ...process.env, SECRETS_KEY: KEY.toString("base64") }, timeout: 60_000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
  assert.equal(sha(), before, "the database file is untouched");
  assert.ok(methods.length && methods.every((m) => m === "GET"));
  assert.match(out, /6 Telegram conversations, 0 unreadable/);
  assert.match(out, /forums 2, topics 5 \(largest: 3, 2\)/);
  assert.match(out, /Telegram list rows: 6 now → 3 after grouping/);
  assert.match(out, /merge: 1 forums archived \(every topic was\), 1 partly archived → inbox, 1 muted, 1 partly muted → unmuted, 1 pinned, 1 in an owner folder/);
  assert.doesNotMatch(out, /Secret|!a1|!g|channel:|1001/, "counts only");
});
