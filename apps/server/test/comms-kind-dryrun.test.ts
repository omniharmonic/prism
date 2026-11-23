// Fix round 1 (I1): scripts/comms-kind-dryrun.ts — per-network flip counts, read-only, no identifiers.
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
const OWNER_WA = "@whatsapp_15550000000:hs";
const rooms: Record<string, { state: unknown[]; members: Record<string, string | null> }> = {
  // WhatsApp, untyped, owner (detected) + 2 contacts: old dm → new group.
  "!wa1:hs": { state: [{ type: "m.bridge", state_key: "b", content: { protocol: { id: "whatsapp" } } }, { type: "m.room.name", state_key: "", content: { name: "Family Secret Name" } }],
    members: { [ME]: "Omni", [OWNER_WA]: "Owner", "@whatsapp_15551110001:hs": "Dana Secret", "@whatsapp_15551110002:hs": "Eli Secret", "@whatsappbot:hs": "bot" } },
  // WhatsApp, untyped DM with one contact: unchanged.
  "!wa2:hs": { state: [{ type: "m.bridge", state_key: "b", content: { protocol: { id: "whatsapp" } } }], members: { [ME]: "Omni", [OWNER_WA]: "Owner", "@whatsapp_15551110003:hs": "Fay" } },
  // Telegram, untyped, an UNDETECTED owner ghost + 1 contact: dm under both (strict-everywhere would flip it).
  "!tg1:hs": { state: [{ type: "m.bridge", state_key: "b", content: { protocol: { id: "telegram" } } }], members: { [ME]: "Omni", "@telegram_9001:hs": "Owner", "@telegram_9002:hs": "Pat" } },
};

let server: http.Server;
let base = "";
let dir = "";
let dbFile = "";
before(async () => {
  server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const send = (b: unknown, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.method !== "GET") return send({ errcode: "M_FORBIDDEN" }, 403);
    if (u.endsWith("/account/whoami")) return send({ user_id: ME });
    const m = /\/rooms\/([^/]+)\/(state|joined_members)$/.exec(u);
    const r = m ? rooms[m[1]!] : undefined;
    if (!r) return send({ errcode: "M_NOT_FOUND" }, 404);
    if (m![2] === "state") return send(r.state);
    return send({ joined: Object.fromEntries(Object.entries(r.members).map(([id, n]) => [id, { display_name: n }])) });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "comms-dryrun-"));
  dbFile = path.join(dir, "prism.db");
  const db = new Database(dbFile);
  db.exec(`CREATE TABLE tenant_secrets (vault_id TEXT, owner_email TEXT, kind TEXT, ciphertext BLOB, iv BLOB, created_at INTEGER);
    CREATE TABLE comms_conversations (id TEXT PRIMARY KEY, source_ref TEXT, kind TEXT);
    CREATE TABLE comms_owner_senders (mxid TEXT PRIMARY KEY, source TEXT, stats_json TEXT);`);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify({ homeserver: base, accessToken: "fixture-token" }), "utf8"), c.final()]);
  db.prepare(`INSERT INTO tenant_secrets VALUES ('primary', ?, 'matrix', ?, ?, 0)`).run(config.ownerEmail, Buffer.concat([enc, c.getAuthTag()]), iv);
  db.prepare(`INSERT INTO comms_owner_senders VALUES (?, 'detected', NULL)`).run(OWNER_WA);
  const ins = db.prepare(`INSERT INTO comms_conversations VALUES (?, ?, ?)`);
  ins.run("a", "!wa1:hs", "dm");
  ins.run("b", "!wa2:hs", "dm");
  ins.run("c", "!tg1:hs", "dm");
  ins.run("d", "bluebubbles-style-ref", "dm"); // not a Matrix room: ignored
  db.close();
});
after(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("prints per-network flip counts only, writes nothing, issues only GETs", async () => {
  const sha = () => crypto.createHash("sha256").update(fs.readFileSync(dbFile)).digest("hex");
  const before = sha();
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ["--env-file=.env.test", "--import", "tsx", "scripts/comms-kind-dryrun.ts", "--db", dbFile], {
      cwd: process.cwd(), // apps/server (npm test runs there)
      env: { ...process.env, SECRETS_KEY: KEY.toString("base64"), OMNI_AGENT_MATRIX_IDS: "" },
      timeout: 60_000,
    }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
  assert.equal(sha(), before, "the database file is untouched");
  assert.match(out, /3 Matrix conversations, 0 unreadable/);
  const line = (n: string) => out.split("\n").find((l) => l.startsWith(n))!;
  assert.match(line("whatsapp"), /rooms\s+2 .*old→new: dm→group 1 .*stored→new \(rebuild changes\): dm→group 1/);
  assert.match(line("telegram"), /rooms\s+1 .*old→new: none .*if strict everywhere: dm→group 1 .*stored→new \(rebuild changes\): none/);
  assert.doesNotMatch(out, /Secret|Dana|Eli|Pat|!wa1|!tg1|1555|9002|whatsapp_|telegram_/, "counts only");
});
