/**
 * Server Proton Mail Bridge ingest (Architecture v2 WP1.2b). Fake IMAP source +
 * fake vault only — Bridge (127.0.0.1:1143) and the vault are never contacted.
 * All message data is synthetic.
 *
 * test/fixtures/proton-script-fixture.json holds synthetic raw messages and the
 * note the ORIGINAL script would write for each: it was produced by running
 * proton_mail.py's own parse_message / note_content / note_path / metadata dict
 * (copied verbatim, no I/O) under Python 3.9.6 — the launchd job's interpreter —
 * with TZ=America/Denver and a synthetic account. proton-script-micro.json pins
 * the header/date/HTML semantics the same way. The port must match byte-for-byte.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import type { Note, NoteLinkInput } from "../src/parachute";
import {
  LIST_METADATA_KEYS,
  PROTON_CREDENTIAL,
  protonMode,
  readProtonIntents,
  runProtonOnce,
  scrubProtonError,
  setProtonSourceForTests,
  sinceDate,
  syncProton,
  validateProtonCredential,
  verifyProtonIntents,
  type ImapRef,
  type ImapSession,
  type ImapSource,
  type ProtonPassOptions,
  type ProtonVault,
} from "../src/worker/proton";
import {
  addresses,
  htmlToText,
  noteContent,
  noteMetadata,
  notePath,
  parseDateMs,
  parseMessage,
  parseMime,
  pyDecodeHeader,
  relabelUnread,
  renderAddressHeader,
  senderAddress,
  slugify,
} from "../src/worker/proton-parse";
import { assertConfig, config } from "../src/config";
import { setMembership } from "../src/db";
import { resetDb, installFakeVault, makeSession, sessionCookie, type FakeVault } from "./helpers";
import { putSecret } from "../src/secrets";
import { getVaultRegistry } from "../src/db";
import { getSourceHealth, recordSourceOutcome, resetSourceHealth } from "../src/worker/health";
import { acl } from "../src/routes/acl";
import { runGmailOnce } from "../src/worker/scheduler";
import { integrations } from "../src/routes/integrations";

const here = path.dirname(fileURLToPath(import.meta.url));
interface FixtureMsg {
  name: string;
  uid: number;
  flags: string[];
  mailbox: string;
  rawBase64: string;
  expected: { path: string; content: string; metadata: Record<string, unknown>; tags: string[]; cc: string };
}
const FIX = JSON.parse(fs.readFileSync(path.join(here, "fixtures/proton-script-fixture.json"), "utf8")) as { account: string; timezone: string; messages: FixtureMsg[] };
const MICRO = JSON.parse(fs.readFileSync(path.join(here, "fixtures/proton-script-micro.json"), "utf8")) as {
  from: Array<{ raw: string; rendered: string; addresses: string[]; sender: [string, string] }>;
  subject: Array<{ raw: string; decoded: string }>;
  date: Array<{ raw: string; ms: number | null }>;
  html: Array<{ raw: string; text: string }>;
};
const TZ = FIX.timezone;
const ACCOUNT = FIX.account;
const raw = (m: FixtureMsg) => Buffer.from(m.rawBase64, "base64");
const byName = (n: string) => FIX.messages.find((m) => m.name === n)!;

// ── parity with the script ───────────────────────────────────────────────────

for (const m of FIX.messages) {
  test(`note shape is byte-identical to proton_mail.py: ${m.name}`, () => {
    const p = parseMessage(raw(m), m.flags, m.mailbox, m.uid);
    assert.equal(notePath(p), m.expected.path);
    assert.equal(noteContent(p, TZ), m.expected.content);
    // Same keys, same ORDER, same values (JSON text equality).
    assert.equal(JSON.stringify(noteMetadata(p, ACCOUNT, TZ)), JSON.stringify(m.expected.metadata));
    assert.equal(p.cc, m.expected.cc);
  });
}

test("micro: address headers render like policy.default + getaddresses", () => {
  for (const f of MICRO.from) {
    const msg = parseMime(Buffer.from(`From: ${f.raw}\r\n\r\n`, "utf8"));
    assert.equal(pyDecodeHeader(renderAddressHeader(msg.headers[0]?.[1] ?? null)), f.rendered, `rendered: ${f.raw}`);
    assert.deepEqual(addresses(msg.headers[0]?.[1] ?? null), f.addresses, `addresses: ${f.raw}`);
    assert.deepEqual(senderAddress(msg), f.sender, `sender: ${f.raw}`);
  }
});

test("micro: subjects (RFC 2047), dates (parsedate_to_datetime), html_to_text", () => {
  for (const s of MICRO.subject) {
    const msg = parseMime(Buffer.from(`Subject: ${s.raw}\r\n\r\n`, "utf8"));
    assert.equal(pyDecodeHeader(msg.headers[0]![1]), s.decoded, s.raw);
  }
  for (const d of MICRO.date) assert.equal(parseDateMs(d.raw), d.ms, d.raw);
  for (const h of MICRO.html) assert.equal(htmlToText(h.raw), h.text, JSON.stringify(h.raw));
});

test("slug + flag-refresh label rule", () => {
  assert.equal(slugify("Café — déjà vu!"), "cafe-deja-vu");
  assert.equal(slugify("日本語"), "");
  assert.deepEqual(relabelUnread(["INBOX", "UNREAD", "BULK"], false), ["INBOX", "BULK"]);
  assert.deepEqual(relabelUnread(["INBOX", "BULK"], true), ["INBOX", "UNREAD", "BULK"]);
  assert.deepEqual(relabelUnread([], true), ["UNREAD"]);
  assert.deepEqual(relabelUnread(undefined, false), []);
});

// ── fakes ────────────────────────────────────────────────────────────────────

interface FakeMsg {
  uid: number;
  flags: string[];
  source: Buffer;
  messageId: string;
  size?: number;
}

function fakeImap(msgs: FakeMsg[], opts: { selectable?: boolean; uidValidity?: string } = {}) {
  const calls = { connect: 0, search: [] as string[], refs: 0, sources: [] as number[], closed: 0, opened: [] as string[] };
  const state = { msgs };
  const session: ImapSession = {
    async openMailbox(name) {
      calls.opened.push(name);
      return opts.selectable === false ? null : { uidValidity: opts.uidValidity ?? "1" };
    },
    async searchSince(since) {
      calls.search.push(since.toISOString().slice(0, 10));
      return state.msgs.map((m) => m.uid);
    },
    async fetchRefs(uids) {
      calls.refs++;
      return state.msgs.filter((m) => uids.includes(m.uid)).map((m): ImapRef => ({ uid: m.uid, flags: [...m.flags], messageId: m.messageId, ...(m.size !== undefined ? { size: m.size } : {}) }));
    },
    async fetchSource(uid) {
      calls.sources.push(uid);
      const m = state.msgs.find((x) => x.uid === uid);
      return m ? { source: m.source, flags: [...m.flags] } : null;
    },
    async close() {
      calls.closed++;
    },
  };
  const source: ImapSource = {
    async connect() {
      calls.connect++;
      return session;
    },
  };
  return { source, calls, state };
}

/** The fixture messages as Bridge would serve them (header-fetch Message-ID included). */
const fixtureImap = () =>
  FIX.messages.map((m): FakeMsg => ({ uid: m.uid, flags: [...m.flags], source: raw(m), messageId: messageIdFromExpected(m) }));
/** A header-only fetch of a message with no Message-ID yields "" (the worker then keys `<mailbox>-uid-<uid>`). */
const messageIdFromExpected = (m: FixtureMsg) => (String(m.expected.metadata.messageId).startsWith(`${m.mailbox}-uid-`) ? "" : String(m.expected.metadata.messageId));

interface Stored extends Note {
  linkSet: Array<{ targetId: string; relationship: string }>;
}

function fakeVault(seed: Array<Partial<Note> & { id: string }> = []) {
  const notes = new Map<string, Stored>();
  let seq = 0;
  let clock = 0;
  const stamp = () => `2026-09-30T00:00:${String(++clock).padStart(2, "0")}.000Z`;
  for (const n of seed) notes.set(n.id, { content: "", path: null, metadata: null, createdAt: "", updatedAt: stamp(), tags: null, ...n, linkSet: [] } as Stored);
  const log = { lists: [] as Array<Record<string, unknown>>, gets: 0, creates: 0, updates: 0, conflicts: 0, posts: [] as Array<{ path?: string; ifExists?: string; links?: NoteLinkInput[] }>, patches: [] as Array<{ id: string; metadata?: Record<string, unknown>; ifUpdatedAt?: string }> };
  const control = { conflictOnce: new Set<string>() };
  const lean = (n: Stored, keys?: string[]): Note =>
    ({
      id: n.id,
      path: n.path,
      metadata: n.metadata ? (keys ? Object.fromEntries(Object.entries(n.metadata).filter(([k]) => keys.includes(k))) : { ...n.metadata }) : null,
      tags: n.tags ? [...n.tags] : null,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    }) as unknown as Note;
  const vault: ProtonVault = {
    async listNotes(o) {
      log.lists.push({ ...o });
      return [...notes.values()]
        .filter((n) => !o.tags?.length || o.tags.some((t) => n.tags?.includes(t)))
        .filter((n) => !("pathPrefix" in o) || !o.pathPrefix || (n.path ?? "").startsWith(o.pathPrefix))
        .map((n) => lean(n, "includeMetadata" in o ? o.includeMetadata : undefined));
    },
    async getNote(idOrPath) {
      log.gets++;
      const n = notes.get(idOrPath) ?? [...notes.values()].find((x) => x.path === idOrPath);
      if (!n) throw Object.assign(new Error(`GET /notes/${idOrPath}: 404`), { status: 404 });
      return { ...lean(n), content: n.content };
    },
    async createNote(p) {
      log.posts.push({ path: p.path, ifExists: p.ifExists, links: p.links });
      const hit = p.path ? [...notes.values()].find((n) => n.path === p.path) : undefined;
      if (hit) {
        if ((p.ifExists ?? "error") === "error") {
          log.conflicts++;
          throw Object.assign(new Error("POST /notes: 409 path_conflict"), { status: 409 });
        }
        return { ...lean(hit), content: hit.content, existed: true };
      }
      const id = `n${++seq}`;
      const n: Stored = { id, content: p.content, path: p.path ?? null, metadata: p.metadata ? { ...p.metadata } : null, tags: p.tags ?? null, createdAt: "t", updatedAt: stamp(), linkSet: [] };
      for (const l of p.links ?? []) n.linkSet.push({ targetId: l.target, relationship: l.relationship });
      notes.set(id, n);
      log.creates++;
      return { ...lean(n), content: n.content, ...(p.ifExists ? { existed: false } : {}) };
    },
    async updateNote(id, p) {
      log.patches.push({ id, metadata: p.metadata, ifUpdatedAt: p.ifUpdatedAt });
      const n = notes.get(id);
      if (!n) throw Object.assign(new Error(`PATCH /notes/${id}: 404`), { status: 404 });
      if (control.conflictOnce.delete(id) || (p.ifUpdatedAt && p.ifUpdatedAt !== n.updatedAt)) {
        log.conflicts++;
        throw Object.assign(new Error(`PATCH /notes/${id}: 409 conflict`), { status: 409 });
      }
      n.metadata = { ...(n.metadata ?? {}), ...(p.metadata ?? {}) };
      n.updatedAt = stamp();
      log.updates++;
      return { ...lean(n), content: n.content };
    },
  };
  const writes = () => log.creates + log.updates;
  return { vault, notes, log, control, writes };
}

const NOW = Date.UTC(2026, 8, 30, 18, 0);
const passOpts = (over: Partial<ProtonPassOptions> = {}): ProtonPassOptions => ({
  mailboxes: ["INBOX"],
  sinceDays: 7,
  maxPerMailbox: 200,
  shadow: false,
  account: ACCOUNT,
  tz: TZ,
  now: NOW,
  ...over,
});

/** A vault already holding exactly what the script wrote for every fixture message. */
const scriptVault = () =>
  fakeVault(FIX.messages.map((m, i) => ({ id: `s${i}`, path: m.expected.path, content: m.expected.content, metadata: { ...m.expected.metadata }, tags: ["email", "triaged"] })));

// ── the pass ─────────────────────────────────────────────────────────────────

test("fresh vault: one note per message, exactly the script's shape, ONE lean list, creates use if_exists", async () => {
  const imap = fakeImap(fixtureImap());
  const v = fakeVault();
  const r = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(r.created, FIX.messages.length);
  assert.equal(r.failed, 0);
  assert.equal(v.log.lists.length, 1, "one vault list per pass");
  assert.deepEqual(v.log.lists[0], { tags: ["email"], pathPrefix: "vault/messages/email/", includeMetadata: LIST_METADATA_KEYS });
  assert.equal(v.log.gets, 0, "no per-note GETs");
  assert.ok(v.log.posts.every((p) => p.ifExists === "ignore"));
  assert.equal(v.log.conflicts, 0);
  for (const m of FIX.messages) {
    const n = [...v.notes.values()].find((x) => x.path === m.expected.path)!;
    assert.ok(n, m.name);
    assert.equal(n.content, m.expected.content, m.name);
    assert.equal(JSON.stringify(n.metadata), JSON.stringify(m.expected.metadata), m.name);
    assert.deepEqual(n.tags, ["email"]);
  }
  assert.equal(imap.calls.connect, 1, "one connection per pass");
  assert.equal(imap.calls.closed, 1);
  assert.deepEqual(imap.calls.search, [sinceDate(NOW, 7).toISOString().slice(0, 10)]);
  assert.equal(imap.calls.search[0], "2026-09-23", "UTC date of now − 7d, like the script");
});

test("converges on notes the script already wrote: zero writes, zero full fetches", async () => {
  const imap = fakeImap(fixtureImap());
  const v = scriptVault();
  const r = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(v.writes(), 0);
  assert.equal(imap.calls.sources.length, 0, "known messages are never re-fetched");
  assert.equal(r.unchanged, FIX.messages.length);
  assert.equal(v.log.lists.length, 1);
});

test("second pass with nothing changed → no writes at all", async () => {
  const imap = fakeImap(fixtureImap());
  const v = fakeVault();
  await syncProton(imap.source, v.vault, passOpts());
  const before = v.writes();
  const r = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(v.writes(), before);
  assert.equal(r.created + r.flagUpdates, 0);
  assert.equal(r.unchanged, FIX.messages.length);
});

test("flag diffing: read → {isUnread:false, labels without UNREAD}; unread again → UNREAD back at index 1; if_updated_at carried", async () => {
  const imap = fakeImap(fixtureImap());
  const v = scriptVault();
  const target = byName("plain-direct");
  const note = [...v.notes.values()].find((n) => n.path === target.expected.path)!;
  imap.state.msgs.find((m) => m.uid === target.uid)!.flags = ["\\Seen"];
  let r = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(r.flagUpdates, 1);
  assert.equal(v.log.patches.length, 1);
  assert.deepEqual(v.log.patches[0]!.metadata, { isUnread: false, labels: ["INBOX", "TRANSACTIONAL", "DIRECT"] });
  assert.ok(v.log.patches[0]!.ifUpdatedAt, "compare-and-swap, not force");
  assert.equal(note.metadata!.isUnread, false);
  assert.equal(note.content, target.expected.content, "content is never rewritten");
  assert.deepEqual(note.tags, ["email", "triaged"], "tags untouched");

  imap.state.msgs.find((m) => m.uid === target.uid)!.flags = [];
  r = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(r.flagUpdates, 1);
  assert.deepEqual(note.metadata!.labels, ["INBOX", "UNREAD", "TRANSACTIONAL", "DIRECT"]);
  assert.ok(r.intents.some((i) => i.action === "update-flags" && i.effect === "applied" && i.change?.isUnread === true));
  // \Flagged alone is not tracked (the script never stored it).
  imap.state.msgs.find((m) => m.uid === target.uid)!.flags = ["\\Flagged"];
  r = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(r.flagUpdates, 0);
});

test("flag update hitting a 409 re-reads the note and retries once", async () => {
  const imap = fakeImap(fixtureImap());
  const v = scriptVault();
  const target = byName("plain-direct");
  const note = [...v.notes.values()].find((n) => n.path === target.expected.path)!;
  imap.state.msgs.find((m) => m.uid === target.uid)!.flags = ["\\Seen"];
  v.control.conflictOnce.add(note.id);
  const r = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(r.flagUpdates, 1);
  assert.equal(r.failed, 0);
  assert.equal(v.log.gets, 1);
  assert.equal(note.metadata!.isUnread, false);
});

test("stale uid on a known note (Bridge rebuilt its store) is corrected in the same PATCH, nothing else", async () => {
  const imap = fakeImap(fixtureImap(), { uidValidity: "2" });
  const v = scriptVault();
  const target = byName("promo-bulk");
  imap.state.msgs.find((m) => m.uid === target.uid)!.uid = 9106;
  const uv = { INBOX: "1" };
  const r = await syncProton(imap.source, v.vault, passOpts({ uidValidity: uv }));
  assert.equal(r.mailboxes[0]!.uidValidityChanged, true);
  assert.equal(uv.INBOX, "2");
  assert.equal(v.log.patches.length, 1);
  assert.deepEqual(v.log.patches[0]!.metadata, { uid: 9106 });
  assert.equal(imap.calls.sources.length, 0);
});

test("same Message-ID under two UIDs → one note, represented by the highest UID", async () => {
  const msgs = fixtureImap().filter((m) => m.uid === 101);
  msgs.push({ ...msgs[0]!, uid: 150 });
  const imap = fakeImap(msgs);
  const v = fakeVault();
  const r = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(r.created, 1);
  assert.equal([...v.notes.values()][0]!.metadata!.uid, 150);
  const r2 = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(r2.flagUpdates + r2.created, 0, "no flip-flop between the duplicates");
});

test("over the cap → the newest (highest) UIDs this pass, the rest deferred", async () => {
  const imap = fakeImap(fixtureImap());
  const v = fakeVault();
  const r = await syncProton(imap.source, v.vault, passOpts({ maxPerMailbox: 3 }));
  assert.equal(r.created, 3);
  assert.equal(r.deferred, FIX.messages.length - 3);
  assert.deepEqual(imap.calls.sources, [111, 110, 109]);
  const r2 = await syncProton(imap.source, v.vault, passOpts({ maxPerMailbox: 3 }));
  assert.deepEqual(imap.calls.sources.slice(3), [108, 107, 106]);
  assert.equal(r2.created, 3);
});

test("a path held by a note that is not this message is never overwritten", async () => {
  const m = byName("plain-direct");
  const imap = fakeImap(fixtureImap().filter((x) => x.uid === m.uid));
  const v = fakeVault([{ id: "foreign", path: m.expected.path, content: "hand-written", metadata: { other: true }, tags: ["email"] }]);
  const r = await syncProton(imap.source, v.vault, passOpts());
  assert.equal(v.writes(), 0);
  assert.equal(r.collisions, 1);
  assert.ok(r.intents.some((i) => i.action === "skip-collision" && i.noteId === "foreign"));
  assert.equal(v.notes.get("foreign")!.content, "hand-written");
});

test("unselectable mailbox is skipped; empty window lists nothing", async () => {
  const v = fakeVault();
  const r = await syncProton(fakeImap(fixtureImap(), { selectable: false }).source, v.vault, passOpts());
  assert.equal(r.mailboxes[0]!.skipped, "cannot select");
  assert.equal(v.log.lists.length, 0);
  const r2 = await syncProton(fakeImap([]).source, v.vault, passOpts());
  assert.equal(r2.lists, 0, "no vault list when the window is empty");
});

test("PROTON_LINK_PEOPLE: a new note links to an EXISTING person; nobody is ever created", async () => {
  const msgs = fixtureImap().filter((m) => m.uid === 101 || m.uid === 102);
  const v = fakeVault([{ id: "p-ada", path: "vault/people/ada-example", content: "# Ada Example", metadata: { type: "person", name: "Ada Example", email: "ada@example.org" }, tags: ["person"] }]);
  const r = await syncProton(fakeImap(msgs).source, v.vault, passOpts({ linkPeople: true }));
  assert.equal(r.created, 2);
  assert.equal(r.linked, 1);
  const ada = [...v.notes.values()].find((n) => n.path === byName("plain-direct").expected.path)!;
  assert.deepEqual(ada.linkSet, [{ targetId: "p-ada", relationship: "email-from" }]);
  assert.equal([...v.notes.values()].filter((n) => n.tags?.includes("person")).length, 1, "no person created");
  // Off by default: no links at all.
  const v2 = fakeVault();
  await syncProton(fakeImap(msgs).source, v2.vault, passOpts());
  assert.ok(v2.log.posts.every((p) => !p.links));
});

test("shadow: fetch + diff, ZERO vault writes, every intended write recorded with hashes only", async () => {
  const imap = fakeImap(fixtureImap());
  const v = scriptVault();
  // One message the script has not written yet, one flag change.
  const missing = byName("long-body");
  v.notes.delete([...v.notes.values()].find((n) => n.path === missing.expected.path)!.id);
  imap.state.msgs.find((m) => m.uid === byName("chat-notification").uid)!.flags = ["\\Seen"];
  const r = await syncProton(imap.source, v.vault, passOpts({ shadow: true }));
  assert.equal(v.writes(), 0);
  assert.equal(r.mode, "shadow");
  const create = r.intents.find((i) => i.action === "create")!;
  assert.equal(create.effect, "shadow");
  assert.equal(create.pathHash, missing.expected.path.slice(-8), "only the hash suffix of the path");
  assert.equal((create as unknown as Record<string, unknown>).path, undefined);
  assert.match(create.contentSha256!, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(create.metadataHashes!).length, Object.keys(missing.expected.metadata).length);
  const flag = r.intents.find((i) => i.action === "update-flags")!;
  assert.equal(flag.effect, "shadow");
  assert.deepEqual(flag.change, { isUnread: false });
  // Intents never carry message text, subjects or addresses.
  const blob = JSON.stringify(r.intents);
  assert.ok(!blob.includes("example.org") && !blob.includes("Casey") && !blob.includes("quick brown fox"));
  assert.ok(!blob.includes("daily-report") && !blob.includes("vault/messages/email/"), "no subject slug / path in intents");

  // Verify: before the script writes → missing; after it writes the same note → match; a different note → differs (+ key names).
  assert.equal((await verifyProtonIntents("primary", r.intents, v.vault)).find((x) => x.action === "create")!.now, "missing");
  v.notes.set("late", { id: "late", path: missing.expected.path, content: missing.expected.content, metadata: { ...missing.expected.metadata }, tags: ["email"], createdAt: "", updatedAt: "", linkSet: [] } as Stored);
  const chat = [...v.notes.values()].find((n) => n.path === byName("chat-notification").expected.path)!;
  chat.metadata = { ...chat.metadata, isUnread: false };
  let ver = await verifyProtonIntents("primary", r.intents, v.vault);
  assert.equal(ver.find((x) => x.action === "create")!.now, "match");
  assert.equal(ver.find((x) => x.action === "update-flags")!.now, "match");
  v.notes.get("late")!.metadata = { ...missing.expected.metadata, date: "1999-01-01 00:00" };
  ver = await verifyProtonIntents("primary", r.intents, v.vault);
  assert.deepEqual(ver.find((x) => x.action === "create")!.differs, ["date"]);
});

// ── runner, config, health, routes (fetch-stubbed vault) ─────────────────────

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  resetSourceHealth();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
  fv = installFakeVault();
});
afterEach(() => {
  fv.restore();
  setProtonSourceForTests(null);
});

function withConfig<T>(over: Partial<typeof config>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, unknown> = {};
  for (const k of Object.keys(over)) prev[k] = (config as Record<string, unknown>)[k];
  Object.assign(config, over);
  return fn().finally(() => Object.assign(config, prev));
}
const SECRET_PW = "s3cr3t-bridge-pass-word";
const CRED = { host: "127.0.0.1", port: 1143, username: ACCOUNT, password: SECRET_PW, security: "starttls", certSha256: "ab".repeat(32) };
const putCred = () => putSecret("primary", config.ownerEmail, PROTON_CREDENTIAL, JSON.stringify(CRED));
const ownerCookie = () => sessionCookie(makeSession(config.ownerEmail));

test("defaults: PROTON_SYNC_ENABLED/SHADOW off — the worker does nothing, never connects", async () => {
  assert.equal(config.protonSyncEnabled, false);
  assert.equal(config.protonShadow, false);
  assert.equal(config.protonIntervalMs, 300_000, "the script's launchd StartInterval");
  assert.equal(config.protonSinceDays, 7);
  assert.equal(config.protonMaxPerPass, 200);
  assert.deepEqual(config.protonMailboxes, ["INBOX"]);
  assert.equal(protonMode(), "off");
  putCred();
  const imap = fakeImap(fixtureImap());
  assert.equal(await runProtonOnce(getVaultRegistry()[0]!, { source: imap.source, force: true }), 0);
  assert.equal(imap.calls.connect, 0);
  assert.equal(fv.calls.length, 0);
});

test("shadow wins over enabled; worker shadow pass makes zero vault writes and persists intents", async () => {
  await withConfig({ protonSyncEnabled: true, protonShadow: true, protonTimezone: TZ }, async () => {
    assert.equal(protonMode(), "shadow");
    putCred();
    const imap = fakeImap(fixtureImap());
    await runProtonOnce(getVaultRegistry()[0]!, { source: imap.source, force: true, now: NOW });
    assert.equal(fv.calls.filter((c) => c.method !== "GET").length, 0, "zero vault writes");
    assert.equal(fv.calls.filter((c) => c.method === "GET").length, 1, "one lean list");
    const intents = readProtonIntents("primary");
    assert.equal(intents.filter((i) => i.action === "create" && i.effect === "shadow").length, FIX.messages.length);
  });
});

test("live worker pass: POSTs with if_exists ignore, throttled per PROTON_INTERVAL_MS slot, account = credential username", async () => {
  await withConfig({ protonSyncEnabled: true, protonTimezone: TZ, protonIntervalMs: 300_000 }, async () => {
    putCred();
    let made = 0;
    const imap = fakeImap(fixtureImap());
    setProtonSourceForTests(() => {
      made++;
      return imap.source;
    });
    const entry = getVaultRegistry()[0]!;
    assert.equal(await runProtonOnce(entry, { now: NOW }), FIX.messages.length);
    await runProtonOnce(entry, { now: NOW + 1000 });
    assert.equal(made, 1, "same slot → throttled");
    const posts = fv.calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, FIX.messages.length);
    assert.ok(posts.every((p) => (p.body as { if_exists?: string }).if_exists === "ignore"));
    assert.ok(posts.every((p) => (p.body as { metadata: { account: string } }).metadata.account === ACCOUNT));
    const lists = fv.calls.filter((c) => c.method === "GET");
    assert.equal(lists.length, 1);
    assert.match(lists[0]!.search, /include_metadata=source%2CmessageId%2Cmailbox%2Cuid%2CisUnread%2Clabels/);
    assert.match(lists[0]!.search, /path_prefix=vault%2Fmessages%2Femail%2F/);
    assert.doesNotMatch(lists[0]!.search, /include_content=true/);
  });
});

test("credentials never reach logs or errors", async () => {
  await withConfig({ protonSyncEnabled: true }, async () => {
    putCred();
    const lines: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      const evil: ImapSource = {
        async connect() {
          throw new Error(`LOGIN failed for ${ACCOUNT} with password ${SECRET_PW}`);
        },
      };
      await assert.rejects(runProtonOnce(getVaultRegistry()[0]!, { source: evil, force: true }), (e: Error) => {
        assert.ok(!e.message.includes(SECRET_PW), e.message);
        return true;
      });
      // Health keeps only the scrubbed text.
      recordSourceOutcome("primary", "proton", new Error(scrubProtonError(`x ${SECRET_PW}`, CRED)));
      const h = await getSourceHealth({ list: async () => [] });
      assert.ok(!JSON.stringify(h).includes(SECRET_PW));
    } finally {
      Object.assign(console, orig);
    }
    assert.ok(lines.every((l) => !l.includes(SECRET_PW)), lines.join("\n"));
  });
});

test("credential validation: loopback only, pinned cert required, messages never echo the password", () => {
  assert.throws(() => validateProtonCredential({ ...CRED, host: "mail.example.test" }), /loopback/);
  assert.throws(() => validateProtonCredential({ ...CRED, certSha256: "" }), /certSha256/);
  assert.throws(() => validateProtonCredential({ ...CRED, security: "none" }), /security/);
  assert.throws(() => validateProtonCredential({ ...CRED, password: "" }), /password required/);
  for (const bad of [{ ...CRED, host: "10.0.0.1" }, { ...CRED, port: 0 }]) {
    try {
      validateProtonCredential(bad);
    } catch (e) {
      assert.ok(!(e as Error).message.includes(SECRET_PW));
    }
  }
  const ok = validateProtonCredential({ ...CRED, certSha256: "AB:".repeat(31) + "AB" });
  assert.equal(ok.certSha256, "ab".repeat(32), "colon/uppercase fingerprints normalise to the script's format");
});

test("assertConfig refuses GMAIL_SYNC_ENABLED + PROTON_SYNC_ENABLED (two live email writers); shadow never affects Gmail", async () => {
  await withConfig({ gmailSyncEnabled: true, protonSyncEnabled: true }, async () => {
    assert.throws(() => assertConfig(), /GMAIL_SYNC_ENABLED and PROTON_SYNC_ENABLED/);
  });
  await withConfig({ gmailSyncEnabled: true, protonShadow: true }, async () => {
    assert.doesNotThrow(() => assertConfig());
    // Gmail still runs normally next to a Proton shadow.
    putSecret("primary", config.ownerEmail, "google", JSON.stringify({ account: "someone@example.test" }));
    let ran = 0;
    await runGmailOnce(getVaultRegistry()[0]!, {
      force: true,
      run: async () => {
        ran++;
        return JSON.stringify({ messages: [] });
      },
    });
    assert.equal(ran, 1);
  });
  await withConfig({ protonSyncEnabled: true }, async () => assert.doesNotThrow(() => assertConfig()));
});

test("the pin hook relies on ImapFlow.prototype.authenticate (guard against an imapflow refactor)", () => {
  assert.equal(typeof (ImapFlow.prototype as unknown as { authenticate?: unknown }).authenticate, "function");
});

test("health: proton is a SERVER source in shadow and live; live drops the inferred desktop email source", async () => {
  const list = async () => [];
  let h = await getSourceHealth({ list });
  assert.equal(h.find((s) => s.name === "proton"), undefined);
  assert.ok(h.find((s) => s.name === "email"));
  await withConfig({ protonShadow: true }, async () => {
    h = await getSourceHealth({ list });
    assert.equal(h.find((s) => s.name === "proton")!.kind, "server");
    assert.equal(h.find((s) => s.name === "proton")!.status, "disabled", "no credential yet");
    assert.ok(h.find((s) => s.name === "email"), "the script still owns email while shadowing");
  });
  await withConfig({ protonSyncEnabled: true }, async () => {
    putCred();
    recordSourceOutcome("primary", "proton", null);
    h = await getSourceHealth({ list });
    const p = h.find((s) => s.name === "proton")!;
    assert.equal(p.status, "ok");
    assert.equal(p.staleAfterMs, config.workerStaleMs.proton);
    assert.equal(h.find((s) => s.name === "email"), undefined);
  });
});

test("GET /acl/workers/proton/intents: server owner only; filter + verify", async () => {
  assert.equal((await acl.request("/workers/proton/intents")).status, 403);
  assert.equal((await acl.request("/workers/proton/intents", { headers: { cookie: sessionCookie(makeSession("member@example.test")) } })).status, 403);
  await withConfig({ protonShadow: true, protonTimezone: TZ }, async () => {
    putCred();
    await runProtonOnce(getVaultRegistry()[0]!, { source: fakeImap(fixtureImap().slice(0, 2)).source, force: true, now: NOW });
    const r = await acl.request("/workers/proton/intents?action=create&verify=1", { headers: { cookie: ownerCookie() } });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { mode: string; total: number; intents: Array<{ action: string }>; verify: Array<{ now: string }> };
    assert.equal(body.mode, "shadow");
    assert.equal(body.total, 2);
    assert.ok(body.intents.every((i) => i.action === "create"));
    assert.ok(body.verify.every((x) => x.now === "missing"), "the fake vault has no such notes yet");
  });
});

test("integrations: proton-bridge credential is stored encrypted, the password is never echoed, bad input refused", async () => {
  const J = { "content-type": "application/json", cookie: ownerCookie() };
  assert.equal((await integrations.request("/proton-bridge")).status, 403);
  const bad = await integrations.request("/proton-bridge", { method: "PUT", headers: J, body: JSON.stringify({ ...CRED, host: "imap.example.test" }) });
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes(SECRET_PW));
  assert.equal((await integrations.request("/proton-bridge", { method: "PUT", headers: J, body: JSON.stringify(CRED) })).status, 200);
  const st = (await (await integrations.request("/proton-bridge", { headers: J })).json()) as Record<string, unknown>;
  assert.equal(st.configured, true);
  assert.equal(st.username, ACCOUNT);
  assert.equal(st.password, undefined);
  assert.ok(!JSON.stringify(st).includes(SECRET_PW));
  // A no-change re-save may omit the password; any repoint must re-enter it.
  assert.equal((await integrations.request("/proton-bridge", { method: "PUT", headers: J, body: JSON.stringify({ ...CRED, password: undefined }) })).status, 200);
  for (const change of [{ port: 1144 }, { host: "::1" }, { security: "tls" }, { username: "other@example.test" }, { certSha256: "cd".repeat(32) }]) {
    const r = await integrations.request("/proton-bridge", { method: "PUT", headers: J, body: JSON.stringify({ ...CRED, password: undefined, ...change }) });
    assert.equal(r.status, 400, JSON.stringify(change));
  }
  assert.equal((await integrations.request("/proton-bridge", { method: "PUT", headers: J, body: JSON.stringify({ ...CRED, port: 1144 }) })).status, 200, "with the password it may change");
  assert.equal((await integrations.request("/proton-bridge/sync", { method: "POST", headers: J })).status, 409, "off → refused");
  await integrations.request("/proton-bridge", { method: "DELETE", headers: J });
  assert.equal(((await (await integrations.request("/proton-bridge", { headers: J })).json()) as { configured: boolean }).configured, false);
});

// ── security review fixes (C1, M1, M2, M3, L1–L4) ────────────────────────────

test("C1: the linear HTML scanners agree with the original regexes on random tag soup", () => {
  // The pre-fix regexes, kept ONLY as an oracle (on short inputs they are fine).
  const oracleStrip = (s: string) => s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const oracleTags = (s: string) => s.replace(/<[^>]+>/g, " ");
  const toks = ["<", ">", "<>", "script", "SCRIPT", "style", "StYlE", "</script>", "</style>", "</SCRIPT>", "<script", "<style", "a", " ", "\n", "<br>", "<BR/>", "</p>", "&amp;", "/", "x"];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 3000; n++) {
    let s = "";
    const len = 1 + Math.floor(rnd() * 14);
    for (let i = 0; i < len; i++) s += toks[Math.floor(rnd() * toks.length)];
    assert.equal(stripScriptStyle(s), oracleStrip(s), `strip ${JSON.stringify(s)}`);
    assert.equal(replaceTags(s), oracleTags(s), `tags ${JSON.stringify(s)}`);
  }
});

test("C1: viaSender matches the original regex and is linear", () => {
  const oracle = /\(via [^)]+\)\s*$/i;
  for (const s of ["Sam (via Docs)", "x (VIA y) ", "(via )", "(via a)b", "a) (via b)", "(via (via x)", "(via x) (via y)", "(via", "", "x(via z)\n"]) {
    assert.equal(viaSender(s), oracle.test(s), JSON.stringify(s));
  }
  timed("'(via ' × N + ')x'", () => viaSender("(via ".repeat(MB / 5) + ")x"));
  timed("'(via ' × N + ')'", () => viaSender("(via ".repeat(MB / 5) + ")"));
});

const MB = 1024 * 1024;
function timed(label: string, fn: () => unknown, boundMs = 300): void {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  assert.ok(ms < boundMs, `${label}: ${ms.toFixed(0)} ms (bound ${boundMs} ms)`);
}

test("C1: pathological HTML / text is linear (each well under the bound)", () => {
  timed("1 MB of '<'", () => htmlToText("<".repeat(MB)));
  timed("'<script>' × N, never closed", () => htmlToText("<script>".repeat(MB / 8)));
  timed("'<style' × N, no '>'", () => htmlToText("<style".repeat(MB / 6)));
  timed("'<script>' + '</style>' × N", () => htmlToText("<script>" + "</style><style>".repeat(MB / 15)));
  timed("'<a' + 1 MB of spaces", () => htmlToText("<a" + " ".repeat(MB)));
  timed("'<br' + spaces × N", () => htmlToText(("<br" + " ".repeat(64)).repeat(MB / 67)));
  timed("'&#' + 1 MB of digits", () => htmlToText("&#" + "9".repeat(MB)));
  timed("'&' × 1 MB", () => htmlToText("&".repeat(MB)));
  timed("interior whitespace run (strip)", () => htmlToText("x" + " \t".repeat(MB / 2) + "x"));
});

/** A synthetic message whose headers / parts are adversarial. */
function hostileMessage(): Buffer {
  const big = 200_000;
  const hdr = [
    `From: ${"(via ".repeat(big / 5)} <a@example.org>`,
    `To: ${"a@example.org, ".repeat(big / 15)}`,
    `Subject: ${"=?".repeat(big / 2)}`,
    `References: ${"<x@example.org> ".repeat(big / 16)}`,
    `Return-Path: <${"=".repeat(big)}@example.org>`,
    `Precedence: ${" ".repeat(big)}bulk!`,
    `Date: ${"Tue, ".repeat(big / 5)}`,
    `Message-ID: <hostile@example.org>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="B${" ".repeat(big)}"`,
    "",
    "--B",
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    "",
    "=".repeat(MB) + "=4" + "=3D".repeat(1000),
    "--B",
    `Content-Type: application/octet-stream`,
    `Content-Disposition: attachment; filename*=utf-8''${"%C3%A9".repeat(big / 6)}`,
    "",
    "x",
    "--B",
    `Content-Type: text/html`,
    "",
    "<".repeat(MB),
    "--B--",
    "",
  ];
  return Buffer.from(hdr.join("\r\n"), "utf8");
}

test("C1/L1: a hostile message (huge headers, 100 KB+ RFC 2231 param, 1 MB QP of '=', 1 MB of '<') parses fast, no stack overflow", () => {
  const raw = hostileMessage();
  let p!: ReturnType<typeof parseMessage>;
  timed("parseMessage(hostile)", () => (p = parseMessage(raw, [], "INBOX", 1, NOW)), 1500);
  assert.equal(p.messageId, "hostile@example.org");
  assert.equal(p.attachments.length, 1);
  assert.ok(p.attachments[0]!.startsWith("éé"));
  assert.ok(p.body.endsWith("[… truncated …]") || p.body.length <= 20_000 + 20);
  timed("noteContent/noteMetadata", () => {
    noteContent(p, TZ);
    noteMetadata(p, ACCOUNT, TZ);
  });
});

test("M2: the body cut walks code points (astral chars count once, never split)", () => {
  const emoji = String.fromCodePoint(0x1f600);
  const src = Buffer.from(`Message-ID: <e@example.org>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${emoji.repeat(20_010)}\r\n`, "utf8");
  const p = parseMessage(src, [], "INBOX", 1, NOW);
  assert.equal(p.body, emoji.repeat(20_000) + "\n\n[… truncated …]");
});

test("M2: oversize messages are never downloaded — skip-too-large, remembered per UIDVALIDITY", async () => {
  const msgs = fixtureImap().slice(0, 2);
  msgs[1]!.size = 50 * MB;
  const imap = fakeImap(msgs);
  const v = fakeVault();
  const skips = {};
  const r = await syncProton(imap.source, v.vault, passOpts({ maxMessageBytes: 10 * MB, skips }));
  assert.equal(r.created, 1);
  assert.equal(r.tooLarge, 1);
  assert.deepEqual(imap.calls.sources, [msgs[0]!.uid], "the big one is never fetched");
  assert.ok(r.intents.some((i) => i.action === "skip-too-large" && i.uid === msgs[1]!.uid));
  const r2 = await syncProton(imap.source, v.vault, passOpts({ maxMessageBytes: 10 * MB, skips }));
  assert.equal(r2.tooLarge, 0, "not re-reported");
  assert.equal(r2.skipped, 1);
  // A new UIDVALIDITY forgets the skip list.
  const imap2 = fakeImap(msgs, { uidValidity: "2" });
  const r3 = await syncProton(imap2.source, v.vault, passOpts({ maxMessageBytes: 10 * MB, skips }));
  assert.equal(r3.tooLarge, 1);
});

test("L1: a message that fails to parse is retried, then skip-listed as poison (no re-download every pass)", async () => {
  const boom = new Proxy(Buffer.from("x"), {
    get(t, p) {
      if (p === "length") return 1;
      throw new Error("synthetic parser crash");
    },
  }) as Buffer;
  const msgs: FakeMsg[] = [{ uid: 500, flags: [], source: boom, messageId: "poison@example.org" }];
  const imap = fakeImap(msgs);
  const v = fakeVault();
  const skips: Record<string, { uidValidity: string; uids: Record<string, { reason: string; attempts: number }> }> = {};
  for (let i = 1; i <= 3; i++) {
    const r = await syncProton(imap.source, v.vault, passOpts({ skips: skips as never }));
    assert.equal(r.failed, 1);
  }
  assert.equal(skips.INBOX!.uids["500"]!.reason, "poison");
  const r4 = await syncProton(imap.source, v.vault, passOpts({ skips: skips as never }));
  assert.equal(r4.failed, 0);
  assert.equal(r4.skipped, 1);
  assert.equal(imap.calls.sources.length, 3, "fetched 3 times, then never again");
});

test("L3: a skip-collision is remembered — the message is not re-downloaded every pass", async () => {
  const m = byName("plain-direct");
  const imap = fakeImap(fixtureImap().filter((x) => x.uid === m.uid));
  const v = fakeVault([{ id: "foreign", path: m.expected.path, content: "hand-written", metadata: { other: true }, tags: ["email"] }]);
  const skips = {};
  await syncProton(imap.source, v.vault, passOpts({ skips }));
  const r2 = await syncProton(imap.source, v.vault, passOpts({ skips }));
  assert.equal(imap.calls.sources.length, 1);
  assert.equal(r2.skipped, 1);
  assert.equal(r2.collisions, 0);
});

test("L2: a mailbox select that fails at the connection level fails the pass (not a silent 'skipped')", async () => {
  const src: ImapSource = {
    async connect() {
      const s = fakeImap([]).source;
      const sess = await s.connect();
      return {
        ...sess,
        async openMailbox() {
          throw Object.assign(new Error("Socket closed unexpectedly"), { code: "NoConnection" });
        },
      };
    },
  };
  await assert.rejects(syncProton(src, fakeVault().vault, passOpts()), /Socket closed/);
});

test("L4: failure reasons never carry a note path or a vault response body", async () => {
  const imap = fakeImap(fixtureImap().slice(0, 1));
  const v = fakeVault();
  v.vault.createNote = async () => {
    throw Object.assign(new Error(`POST /notes: 500 {"error":"x","path":"vault/messages/email/quarterly-check-in-notes-next-steps-f5ff057b"}`), { status: 500 });
  };
  const lines: string[] = [];
  const r = await syncProton(imap.source, v.vault, passOpts({ log: (l) => lines.push(l) }));
  const blob = JSON.stringify(r.intents) + lines.join("\n");
  assert.ok(blob.includes("vault HTTP 500"));
  assert.ok(!blob.includes("quarterly"), blob);
  assert.ok(!scrubProtonError("GET /notes/vault/messages/email/secret-subject-1234abcd: 404").includes("secret-subject"));
});

test("M1: /proton-bridge* is SERVER-owner only — a vault admin gets 403 everywhere", async () => {
  setMembership("primary", "admin@example.test", "admin", config.ownerEmail);
  const cookie = sessionCookie(makeSession("admin@example.test"));
  const J = { "content-type": "application/json", cookie };
  assert.equal((await integrations.request("/proton-bridge", { headers: J })).status, 403);
  assert.equal((await integrations.request("/proton-bridge", { method: "PUT", headers: J, body: JSON.stringify(CRED) })).status, 403);
  assert.equal((await integrations.request("/proton-bridge", { method: "DELETE", headers: J })).status, 403);
  assert.equal((await integrations.request("/proton-bridge/sync", { method: "POST", headers: J })).status, 403);
  // …while the same admin still reaches the other integrations.
  assert.equal((await integrations.request("/google", { headers: J })).status, 200);
});

test("M1: a forced sync while a pass runs is refused (409), never queued", async () => {
  await withConfig({ protonShadow: true }, async () => {
    putCred();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ImapSource = {
      async connect() {
        await gate;
        return fakeImap([]).source.connect();
      },
    };
    const entry = getVaultRegistry()[0]!;
    const first = runProtonOnce(entry, { source: slow, force: true });
    await assert.rejects(runProtonOnce(entry, { source: slow, force: true }), (e: Error & { code?: string }) => e.code === "busy");
    assert.equal(await runProtonOnce(entry, { source: slow, now: NOW + 9e9 }), 0, "a worker tick just skips");
    const r = await integrations.request("/proton-bridge/sync", { method: "POST", headers: { cookie: ownerCookie() } });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { error: string }).error, "busy");
    release();
    await first;
  });
});

// ── M3: real loopback TLS against a stub IMAP server ─────────────────────────

import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { imapflowSource } from "../src/worker/proton";
import { replaceTags, stripScriptStyle, viaSender } from "../src/worker/proton-parse";

function selfSigned(): { key: string; cert: string; sha: string } | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proton-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    const key = fs.readFileSync(`${dir}/k.pem`, "utf8");
    const cert = fs.readFileSync(`${dir}/c.pem`, "utf8");
    fs.rmSync(dir, { recursive: true, force: true });
    return { key, cert, sha: crypto.createHash("sha256").update(new crypto.X509Certificate(cert).raw).digest("hex") };
  } catch {
    return null;
  }
}
const TLS = selfSigned();

/** Minimal IMAP stub: greets, answers CAPABILITY / STARTTLS, refuses LOGIN, and
 *  records every byte it receives (decrypted, for TLS). */
async function stubImap(mode: "starttls" | "tls" | "no-starttls") {
  const received: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  const serve = (sock: net.Socket, secure: boolean) => {
    let buf = "";
    const onData = (d: Buffer) => {
      received.push(d);
      buf += d.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmdRaw] = line.split(" ");
        const cmd = (cmdRaw ?? "").toUpperCase();
        if (cmd === "CAPABILITY") {
          const caps = secure ? "IMAP4rev1" : mode === "starttls" ? "IMAP4rev1 STARTTLS LOGINDISABLED" : "IMAP4rev1";
          sock.write(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`);
        } else if (cmd === "STARTTLS" && mode === "starttls" && !secure) {
          sock.removeListener("data", onData);
          sock.pause(); // hold the client hello until the TLS wrapper is attached
          sock.write(`${tag} OK begin TLS\r\n`, () => {
            const t = new tls.TLSSocket(sock, { isServer: true, key: TLS!.key, cert: TLS!.cert });
            t.on("error", () => {});
            serve(t, true);
          });
          return;
        } else if (cmd === "LOGIN" || cmd === "AUTHENTICATE") sock.write(`${tag} NO [AUTHENTICATIONFAILED] stub refuses\r\n`);
        else if (cmd === "LOGOUT") sock.end(`* BYE\r\n${tag} OK bye\r\n`);
        else sock.write(`${tag} BAD unsupported\r\n`);
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  };
  const onConn = (secure: boolean) => (sock: net.Socket) => {
    sockets.add(sock);
    sock.write("* OK stub ready\r\n");
    serve(sock, secure);
  };
  const server = mode === "tls" ? tls.createServer({ key: TLS!.key, cert: TLS!.cert }, onConn(true)) : net.createServer(onConn(false));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    text: () => Buffer.concat(received).toString("latin1"),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

const TLS_PW = "stub-only-password-not-real";
const tlsCred = (port: number, security: "starttls" | "tls", pin: string) =>
  validateProtonCredential({ host: "127.0.0.1", port, username: "u@example.test", password: TLS_PW, security, certSha256: pin });

for (const security of ["starttls", "tls"] as const) {
  test(`M3 ${security}: wrong pin ⇒ zero LOGIN/AUTHENTICATE bytes; right pin ⇒ LOGIN reaches the stub`, { skip: TLS ? false : "openssl unavailable" }, async () => {
    const stub = await stubImap(security);
    try {
      await assert.rejects(imapflowSource(tlsCred(stub.port, security, "00".repeat(32)), { timeoutMs: 5000 }).connect(), /fingerprint mismatch/);
      assert.doesNotMatch(stub.text(), /LOGIN|AUTHENTICATE/i);
      assert.ok(!stub.text().includes(TLS_PW));
    } finally {
      await stub.close();
    }
    const stub2 = await stubImap(security);
    try {
      await assert.rejects(imapflowSource(tlsCred(stub2.port, security, TLS!.sha), { timeoutMs: 5000 }).connect(), (e: Error) => {
        assert.match(e.message, /Bridge rejected the login/);
        assert.ok(!e.message.includes(TLS_PW));
        return true;
      });
      assert.match(stub2.text(), /\bLOGIN\b/, "the pinned connection proceeds to LOGIN");
    } finally {
      await stub2.close();
    }
  });
}

test("M3: a server without STARTTLS is refused before any credential is sent", { skip: TLS ? false : "openssl unavailable" }, async () => {
  const stub = await stubImap("no-starttls");
  try {
    await assert.rejects(imapflowSource(tlsCred(stub.port, "starttls", TLS!.sha), { timeoutMs: 5000 }).connect());
    assert.doesNotMatch(stub.text(), /LOGIN|AUTHENTICATE/i);
    assert.ok(!stub.text().includes(TLS_PW));
  } finally {
    await stub.close();
  }
});

// ── detect-cert: owner-driven Bridge certificate read (docs/credentials.md) ──

import { BridgeCertDetectError, certFingerprintOf, detectBridgeCert } from "../src/worker/proton";

const detect = (body: Record<string, unknown>, cookie = ownerCookie()) =>
  integrations.request("/proton-bridge/detect-cert", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

for (const security of ["starttls", "tls"] as const) {
  test(`detect-cert ${security}: returns the pin the worker accepts; the listener receives no auth bytes and no credential`, { skip: TLS ? false : "openssl unavailable" }, async () => {
    putCred(); // a stored credential exists — detect must never load or send it
    const stub = await stubImap(security);
    try {
      const r = await detect({ host: "127.0.0.1", port: stub.port, security });
      assert.equal(r.status, 200);
      const body = (await r.json()) as { certSha256: string; subject?: string; validTo?: string };
      assert.equal(body.certSha256, TLS!.sha, "same format + value as the pin the M3 tests log in with");
      assert.match(body.subject ?? "", /CN=127\.0\.0\.1/);
      assert.ok(body.validTo);
      // Plaintext before STARTTLS = exactly the STARTTLS command; decrypted app
      // data after the handshake = nothing at all (no CAPABILITY/LOGIN/LOGOUT).
      assert.equal(stub.text(), security === "starttls" ? "A1 STARTTLS\r\n" : "");
      assert.doesNotMatch(stub.text(), /LOGIN|AUTHENTICATE/i);
      assert.ok(!stub.text().includes(SECRET_PW) && !stub.text().includes(ACCOUNT));
    } finally {
      await stub.close();
    }
    // …and the detected value is a valid pin for the real login path.
    const stub2 = await stubImap(security);
    try {
      await assert.rejects(imapflowSource(tlsCred(stub2.port, security, TLS!.sha), { timeoutMs: 5000 }).connect(), /Bridge rejected the login/);
    } finally {
      await stub2.close();
    }
  });
}

test("detect-cert: non-loopback hosts are refused before any socket opens; bad port/security → 400", async () => {
  for (const host of ["imap.example.test", "10.0.0.1", "192.168.1.10", "0.0.0.0"]) {
    const r = await detect({ host, port: 1143 });
    assert.equal(r.status, 400, host);
    assert.equal(((await r.json()) as { error: string }).error, "bad_request");
  }
  assert.equal((await detect({ port: 70000 })).status, 400);
  for (const port of [22, 25, 993, 1023]) assert.equal((await detect({ port })).status, 400, `privileged port ${port}`);
  assert.equal((await detect({ security: "plain" })).status, 400);
  await assert.rejects(detectBridgeCert({ host: "example.test" }), (e: BridgeCertDetectError) => e.code === "bad_request");
});

test("detect-cert: SERVER-owner only — a vault admin and anon get 403", async () => {
  setMembership("primary", "admin@example.test", "admin", config.ownerEmail);
  const r = await detect({ host: "127.0.0.1" }, sessionCookie(makeSession("admin@example.test")));
  assert.equal(r.status, 403);
  assert.equal((await integrations.request("/proton-bridge/detect-cert", { method: "POST" })).status, 403);
});

test("detect-cert: a listener without STARTTLS fails cleanly; a silent one times out", { skip: TLS ? false : "openssl unavailable" }, async () => {
  const stub = await stubImap("no-starttls");
  try {
    await assert.rejects(detectBridgeCert({ port: stub.port, timeoutMs: 5000 }), (e: BridgeCertDetectError) => e.code === "no_starttls");
    assert.equal(stub.text(), "A1 STARTTLS\r\n");
  } finally {
    await stub.close();
  }
  const silent = net.createServer(() => {});
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (silent.address() as net.AddressInfo).port;
    await assert.rejects(detectBridgeCert({ port, timeoutMs: 300 }), (e: BridgeCertDetectError) => e.code === "timeout");
  } finally {
    silent.close();
  }
});

test("certFingerprintOf: lowercase hex SHA-256 of the DER; empty → empty", { skip: TLS ? false : "openssl unavailable" }, () => {
  assert.equal(certFingerprintOf(new crypto.X509Certificate(TLS!.cert).raw), TLS!.sha);
  assert.equal(certFingerprintOf(undefined), "");
});
