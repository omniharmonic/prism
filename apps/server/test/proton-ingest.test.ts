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
import { config } from "../src/config";
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
      return state.msgs.filter((m) => uids.includes(m.uid)).map((m): ImapRef => ({ uid: m.uid, flags: [...m.flags], messageId: m.messageId }));
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
  assert.equal(create.path, missing.expected.path);
  assert.match(create.contentSha256!, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(create.metadataHashes!).length, Object.keys(missing.expected.metadata).length);
  const flag = r.intents.find((i) => i.action === "update-flags")!;
  assert.equal(flag.effect, "shadow");
  assert.deepEqual(flag.change, { isUnread: false });
  // Intents never carry message text, subjects or addresses.
  const blob = JSON.stringify(r.intents);
  assert.ok(!blob.includes("example.org") && !blob.includes("Casey") && !blob.includes("quick brown fox"));

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

test("Gmail stands down while the Proton ingest is on (both would write vault/messages/email/)", async () => {
  await withConfig({ gmailSyncEnabled: true, protonShadow: true }, async () => {
    putSecret("primary", config.ownerEmail, "google", JSON.stringify({ account: "someone@example.test" }));
    let ran = 0;
    const n = await runGmailOnce(getVaultRegistry()[0]!, {
      force: true,
      run: async () => {
        ran++;
        return "{}";
      },
    });
    assert.equal(n, 0);
    assert.equal(ran, 0);
    assert.equal(fv.calls.length, 0);
  });
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
  // Re-save without the password keeps the stored one.
  assert.equal((await integrations.request("/proton-bridge", { method: "PUT", headers: J, body: JSON.stringify({ ...CRED, password: undefined, port: 1144 }) })).status, 200);
  assert.equal((await integrations.request("/proton-bridge/sync", { method: "POST", headers: J })).status, 409, "off → refused");
  await integrations.request("/proton-bridge", { method: "DELETE", headers: J });
  assert.equal(((await (await integrations.request("/proton-bridge", { headers: J })).json()) as { configured: boolean }).configured, false);
});
