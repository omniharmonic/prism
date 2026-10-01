/**
 * Server Gmail ingest (Architecture v2 WP1.2) + the shared person linker
 * (worker/people.ts, the WP0.6 create→409 storm fix). Fake vault + fake `gog`
 * runner only — the real CLI is never invoked. All fixture data is synthetic.
 *
 * The fake vault enforces what the real one does on the paths that matter here:
 * a POST to a taken path is a 409 unless `if_exists` is set; `update` merges
 * metadata and unions links; lean listings carry `byteSize` + `links`.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Note, NoteLinkInput } from "../src/parachute";
import {
  buildThreadNote,
  extractDisplayName,
  extractEmailAddress,
  groupThreads,
  ingestGmail,
  parseEmailDateToMillis,
  GmailClient,
  EMAIL_FROM,
  type GmailMessage,
  type GmailVault,
} from "../src/worker/gmail";
import { PeopleIndex, rustSanitizePath, cleanDisplayName, creationRefusal, isNonhumanEmail } from "../src/worker/people";
import { config } from "../src/config";
import { resetDb } from "./helpers";
import { putSecret } from "../src/secrets";
import { getVaultRegistry } from "../src/db";
import { resetGmailBackfill, runGmailOnce } from "../src/worker/scheduler";
import { getSourceHealth, recordSourceOutcome, resetSourceHealth } from "../src/worker/health";

// ── fake vault ───────────────────────────────────────────────────────────────

interface Stored extends Note {
  linkSet: Array<{ targetId: string; relationship: string }>;
}

function fakeVault(seed: Array<Partial<Note> & { id: string }> = []) {
  const notes = new Map<string, Stored>();
  for (const n of seed)
    notes.set(n.id, { content: "", path: null, metadata: null, createdAt: "", updatedAt: "", tags: null, ...n, linkSet: [] } as Stored);
  const log = { creates: 0, updates: 0, conflicts: 0, lists: [] as string[], posts: [] as Array<{ path?: string; ifExists?: string }> };
  let seq = 0;
  const resolve = (target: string): Stored | undefined => notes.get(target) ?? [...notes.values()].find((n) => n.path === target);
  const addLinks = (n: Stored, links: NoteLinkInput[] = []) => {
    for (const l of links) {
      const t = resolve(l.target);
      if (!t) continue;
      if (!n.linkSet.some((x) => x.targetId === t.id && x.relationship === l.relationship)) n.linkSet.push({ targetId: t.id, relationship: l.relationship });
    }
  };
  const lean = (n: Stored): Note =>
    ({
      id: n.id,
      path: n.path,
      metadata: n.metadata,
      tags: n.tags,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      byteSize: Buffer.byteLength(n.content, "utf8"),
      displayTitle: n.content.startsWith("# ") ? n.content.split("\n")[0]!.slice(2) : null,
      links: n.linkSet.map((l) => ({ sourceId: n.id, targetId: l.targetId, relationship: l.relationship })),
    }) as unknown as Note;
  const vault: GmailVault = {
    async listNotes(o) {
      log.lists.push((o.tags ?? []).join(","));
      return [...notes.values()].filter((n) => !o.tags?.length || o.tags.some((t) => n.tags?.includes(t))).map(lean);
    },
    async createNote(p) {
      log.posts.push({ path: p.path, ifExists: p.ifExists });
      const hit = p.path ? [...notes.values()].find((n) => n.path === p.path) : undefined;
      if (hit) {
        const mode = p.ifExists ?? "error";
        if (mode === "error") {
          log.conflicts++;
          throw new Error(`POST /notes: 409 path_conflict`);
        }
        if (mode === "update") {
          if (p.content !== undefined) hit.content = p.content;
          if (p.metadata) hit.metadata = { ...(hit.metadata ?? {}), ...p.metadata };
          hit.tags = [...new Set([...(hit.tags ?? []), ...(p.tags ?? [])])];
          addLinks(hit, p.links);
          log.updates++;
        }
        return { ...lean(hit), content: hit.content, existed: true };
      }
      const id = `n${++seq}`;
      const n: Stored = { id, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "t", updatedAt: "t", linkSet: [] };
      notes.set(id, n);
      addLinks(n, p.links);
      log.creates++;
      return { ...lean(n), content: n.content, ...(p.ifExists ? { existed: false } : {}) };
    },
    async updateNote(id, p) {
      const n = notes.get(id);
      if (!n) throw new Error(`PATCH /notes/${id}: 404`);
      if (p.content !== undefined) n.content = p.content;
      if (p.metadata) n.metadata = { ...(n.metadata ?? {}), ...p.metadata };
      addLinks(n, p.links?.add);
      log.updates++;
      return { ...lean(n), content: n.content };
    },
  };
  const byTag = (t: string) => [...notes.values()].filter((n) => n.tags?.includes(t));
  return { vault, notes, log, byTag };
}

/** A fake gog: records argv, returns the canned search payload. */
function fakeGog(messages: GmailMessage[]) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ messages, nextPageToken: null });
  };
  return { calls, client: new GmailClient("someone@example.test", run), run };
}

const msg = (over: Partial<GmailMessage> = {}): GmailMessage => ({
  id: "m1",
  threadId: "18f0aaaabbbbcc01",
  date: "2026-04-25 10:41",
  from: "Ada Example <ada@example.test>",
  subject: "Quarterly plan: draft #2",
  labels: ["INBOX", "UNREAD"],
  body: "  Hello there.\n\nSee attached.  ",
  ...over,
});

const OPTS = { query: "in:inbox newer_than:3h", max: 30 };

// ── pure ports ───────────────────────────────────────────────────────────────

test("date parsing mirrors email_sync.rs (naive = UTC, RFC 3339, RFC 2822, garbage = 0)", () => {
  assert.equal(parseEmailDateToMillis("2026-04-25 10:41"), 1_777_113_660_000);
  assert.equal(parseEmailDateToMillis("2026-04-25 10:41:30"), 1_777_113_690_000);
  assert.ok(parseEmailDateToMillis("2026-04-25T17:24:10Z") > 1_700_000_000_000);
  assert.ok(parseEmailDateToMillis("Sat, 25 Apr 2026 17:24:10 +0000") > 1_700_000_000_000);
  assert.equal(parseEmailDateToMillis(""), 0);
  assert.equal(parseEmailDateToMillis("not a date"), 0);
});

test("sender parsing + path slug match the desktop", () => {
  assert.equal(extractEmailAddress("Ada Example <ada@example.test>"), "ada@example.test");
  assert.equal(extractEmailAddress(" ada@example.test "), "ada@example.test");
  assert.equal(extractDisplayName('"Ada Example" <ada@example.test>'), "Ada Example");
  assert.equal(extractDisplayName("ada@example.test"), "ada");
  assert.equal(rustSanitizePath("Quarterly plan: draft #2"), "quarterly-plan--draft--2");
  assert.equal(rustSanitizePath("Café  Über"), "café--über"); // Unicode alphanumerics kept, like Rust
  assert.equal(cleanDisplayName("Ada Example (WhatsApp)"), "Ada Example");
  assert.equal(cleanDisplayName("@ada:hs.example"), "ada");
});

test("buildThreadNote reproduces the desktop note byte-for-byte", () => {
  const t = buildThreadNote("18f0aaaabbbbcc01", [msg(), msg({ id: "m0", from: "Bo <bo@example.test>", date: "2026-04-24 09:00", body: "" })]);
  assert.equal(t.path, "vault/messages/email/quarterly-plan--draft--2-bbcc01");
  assert.equal(
    t.content,
    "# Quarterly plan: draft #2\n\n" +
      "**From:** Ada Example <ada@example.test>  \n**Date:** 2026-04-25 10:41\n\nHello there.\n\nSee attached.\n\n---\n\n" +
      "**From:** Bo <bo@example.test>  \n**Date:** 2026-04-24 09:00\n\n---\n\n",
  );
  assert.deepEqual(t.metadata, {
    type: "email",
    platform: "email",
    threadId: "18f0aaaabbbbcc01",
    from: "Ada Example <ada@example.test>",
    subject: "Quarterly plan: draft #2",
    date: "2026-04-25 10:41",
    labels: ["INBOX", "UNREAD"],
    isUnread: true,
    messageCount: 2,
    lastMessageAt: 1_777_113_660_000,
  });
  // Short thread ids are used whole; bodies over 20 000 bytes are capped on a char boundary.
  assert.equal(buildThreadNote("abc", [msg({ threadId: "abc" })]).path.endsWith("-abc"), true);
  const big = buildThreadNote("t", [msg({ body: "é".repeat(15_000) })]).content;
  assert.match(big, /…\n\n\*\(truncated\)\*\n\n---/);
  assert.ok(!big.includes("�"));
});

test("groupThreads keeps gog order and falls back to the message id", () => {
  const g = groupThreads([msg({ id: "a", threadId: "T1" }), msg({ id: "b", threadId: undefined }), msg({ id: "c", threadId: "T1" })]);
  assert.deepEqual([...g.keys()], ["T1", "b"]);
  assert.deepEqual(g.get("T1")!.map((m) => m.id), ["a", "c"]);
});

test("the fake gog is invoked with the desktop's exact argv", async () => {
  const g = fakeGog([]);
  await g.client.searchMessages("in:inbox newer_than:14d", 100);
  assert.deepEqual(g.calls[0], ["gmail", "messages", "search", "in:inbox newer_than:14d", "--max", "100", "--include-body", "--account", "someone@example.test", "--json"]);
});

// ── ingest ───────────────────────────────────────────────────────────────────

test("converges on a desktop-created note: updated in place, never duplicated", async () => {
  const t = buildThreadNote("18f0aaaabbbbcc01", [msg({ labels: ["INBOX"] })]); // desktop saw it before it was UNREAD… or after
  const fv = fakeVault([
    { id: "desk-1", path: t.path, tags: ["email", "urgent"], content: t.content, metadata: { ...t.metadata, triagedBy: "skill" } },
  ]);
  const g = fakeGog([msg()]);
  const r = await ingestGmail(g.client, fv.vault, OPTS);
  assert.equal(r.created, 0);
  assert.equal(r.updated, 1);
  assert.equal(fv.byTag("email").length, 1, "no duplicate thread note");
  const n = fv.notes.get("desk-1")!;
  assert.equal(n.metadata!.isUnread, true);
  assert.equal(n.metadata!.triagedBy, "skill", "keys other writers added survive (metadata merge)");
  assert.deepEqual(n.tags, ["email", "urgent"]);
  assert.equal(fv.log.conflicts, 0);
});

test("a thread found by threadId is updated even when its path differs (older desktop slug)", async () => {
  const fv = fakeVault([{ id: "old", path: "vault/messages/email/renamed-thing-bbcc01", tags: ["email"], content: "# x", metadata: { threadId: "18f0aaaabbbbcc01" } }]);
  const r = await ingestGmail(fakeGog([msg()]).client, fv.vault, OPTS);
  assert.equal(r.updated, 1);
  assert.equal(fv.byTag("email").length, 1);
  assert.equal(fv.notes.get("old")!.path, "vault/messages/email/renamed-thing-bbcc01", "path never moved");
});

test("a new thread creates exactly one note (with if_exists), linked to its sender", async () => {
  const fv = fakeVault();
  const r = await ingestGmail(fakeGog([msg()]).client, fv.vault, OPTS);
  assert.equal(r.created, 1);
  const [email] = fv.byTag("email");
  assert.equal(email!.path, "vault/messages/email/quarterly-plan--draft--2-bbcc01");
  const [person] = fv.byTag("person");
  assert.equal(person!.path, "vault/people/ada-example");
  assert.deepEqual(person!.metadata, { type: "person", name: "Ada Example", channels: { email: ["ada@example.test"] }, email: "ada@example.test" });
  assert.deepEqual(email!.linkSet, [{ targetId: person!.id, relationship: EMAIL_FROM }]);
  assert.ok(fv.log.posts.every((p) => p.ifExists), "every create carries if_exists");
});

test("re-running the same pass is idempotent — and writes nothing", async () => {
  const fv = fakeVault();
  const g = fakeGog([msg(), msg({ id: "m2", threadId: "18f0cccc00000002", subject: "Other" })]);
  await ingestGmail(g.client, fv.vault, OPTS);
  const writes = fv.log.creates + fv.log.updates;
  const r2 = await ingestGmail(g.client, fv.vault, OPTS);
  assert.equal(r2.created + r2.updated, 0);
  assert.equal(r2.unchanged, 2);
  assert.equal(fv.log.creates + fv.log.updates, writes, "an unchanged thread is not rewritten");
  assert.equal(fv.byTag("email").length, 2);
  assert.equal(fv.byTag("person").length, 1);
});

test("an unchanged thread missing its person link IS rewritten to add the link", async () => {
  const t = buildThreadNote("18f0aaaabbbbcc01", [msg()]);
  const fv = fakeVault([
    { id: "desk-1", path: t.path, tags: ["email"], content: t.content, metadata: t.metadata },
    { id: "p1", path: "vault/people/ada", tags: ["person"], content: "# Ada Example", metadata: { name: "Ada Example", email: "ada@example.test" } },
  ]);
  const r = await ingestGmail(fakeGog([msg()]).client, fv.vault, OPTS);
  assert.equal(r.updated, 1);
  assert.deepEqual(fv.notes.get("desk-1")!.linkSet, [{ targetId: "p1", relationship: EMAIL_FROM }]);
});

test(">500 existing email notes still dedupe (no 500-note window)", async () => {
  const seed: Array<Partial<Note> & { id: string }> = [];
  for (let i = 0; i < 750; i++)
    seed.push({ id: `e${i}`, path: `vault/messages/email/s-${i}`, tags: ["email"], content: "# s", metadata: { threadId: `thread-${String(i).padStart(4, "0")}` } });
  const fv = fakeVault(seed);
  // The OLDEST thread (last in a desc listing) re-appears in the inbox.
  const r = await ingestGmail(fakeGog([msg({ threadId: "thread-0749", subject: "s" })]).client, fv.vault, OPTS);
  assert.equal(r.created, 0);
  assert.equal(r.updated, 1);
  assert.equal(fv.byTag("email").length, 750);
});

test("person found by email case-insensitively (channels.email, email, contact)", async () => {
  const fv = fakeVault([
    { id: "p-ch", path: "vault/people/someone-else", tags: ["person"], content: "# Someone Else", metadata: { name: "Someone Else", channels: { email: ["ADA@Example.TEST"] } } },
  ]);
  const r = await ingestGmail(fakeGog([msg()]).client, fv.vault, OPTS);
  assert.equal(r.peopleCreated, 0);
  assert.equal(fv.byTag("person").length, 1);
  assert.deepEqual(fv.byTag("email")[0]!.linkSet, [{ targetId: "p-ch", relationship: EMAIL_FROM }]);

  const idx = new PeopleIndex([
    { id: "a", path: "vault/people/x", tags: ["person"], content: "", metadata: { email: "Bo@Example.Test" }, createdAt: "", updatedAt: "" },
    { id: "b", path: "vault/people/y", tags: ["person"], content: "", metadata: { contact: "cy@example.test" }, createdAt: "", updatedAt: "" },
    { id: "c", path: "vault/people/Dee_Example", tags: ["person"], content: "", metadata: {}, createdAt: "", updatedAt: "" },
    { id: "d", path: "vault/people/z", tags: ["person"], content: "", metadata: { channels: { matrix: "@Eve:hs.example" } }, createdAt: "", updatedAt: "" },
  ]);
  assert.equal(idx.find({ email: " bo@example.test" })?.id, "a");
  assert.equal(idx.find({ email: "CY@example.test" })?.id, "b");
  assert.equal(idx.find({ name: "dee example" }), null, "a display name is not a unique external identity");
  assert.equal(idx.resolve({ name: "dee example" }).status, "candidates");
  assert.equal(idx.find({ matrixId: "@eve:hs.example" })?.id, "d", "channels.matrix (the desktop never looked there)");
});

test("the storm case: a path-only match stays unresolved without duplicate creation", async () => {
  // The desktop's path check compared normalize(\"j--smith\") to normalize(\"J. Smith\") → miss → 409.
  const fv = fakeVault([{ id: "pj", path: "vault/people/j--smith", tags: ["person"], content: "", metadata: null }]);
  const r = await ingestGmail(fakeGog([msg({ from: "J. Smith <js@example.test>" })]).client, fv.vault, OPTS);
  assert.equal(r.peopleCreated, 0);
  assert.equal(fv.log.conflicts, 0);
  assert.deepEqual(fv.byTag("email")[0]!.linkSet, []);
});

test("a missing person is created once across many messages/threads in one pass", async () => {
  const fv = fakeVault();
  const many = Array.from({ length: 12 }, (_, i) => msg({ id: `m${i}`, threadId: `thr-${i}-000000`, subject: `Topic ${i}` }));
  const r = await ingestGmail(fakeGog(many).client, fv.vault, OPTS);
  assert.equal(r.created, 12);
  assert.equal(r.peopleCreated, 1);
  assert.equal(fv.byTag("person").length, 1);
  assert.equal(fv.log.lists.filter((l) => l === "person").length, 1, "people indexed once per pass");
});

test("a path taken behind our back never becomes a fabricated person identity", async () => {
  // The person path is taken by a note the person listing cannot see (not person-tagged).
  const fv = fakeVault([{ id: "x", path: "vault/people/ada-example", tags: ["contact"], content: "", metadata: {} }]);
  const r = await ingestGmail(fakeGog([msg()]).client, fv.vault, OPTS);
  assert.equal(r.failed, 0);
  assert.equal(fv.log.conflicts, 0);
  assert.deepEqual(fv.byTag("email")[0]!.linkSet, []);
  assert.ok(fv.log.posts.every((p) => p.ifExists === "ignore" || p.ifExists === "update"));
});

test("automated senders never become people (desktop skip rules)", async () => {
  const fv = fakeVault();
  const r = await ingestGmail(
    fakeGog([msg({ from: "Service Alerts <noreply@example.test>" }), msg({ threadId: "t2-000000", from: "+1 555 0100 <x@example.test>" })]).client,
    fv.vault,
    OPTS,
  );
  assert.equal(r.created, 2);
  assert.equal(fv.byTag("person").length, 0);
  assert.equal(isNonhumanEmail("billing@example.test"), true);
  assert.equal(isNonhumanEmail("ada.lovelace@example.test"), false);
  assert.equal(creationRefusal("Al"), "name too short");
  assert.equal(creationRefusal("5551234567"), "name looks like a phone number or id");
});

test("one bad thread never aborts the pass", async () => {
  const fv = fakeVault();
  const real = fv.vault.createNote.bind(fv.vault);
  fv.vault.createNote = async (p) => {
    if (p.path?.includes("boom")) throw new Error("vault 500");
    return real(p);
  };
  const r = await ingestGmail(fakeGog([msg({ threadId: "t-boom01", subject: "boom" }), msg({ threadId: "t-ok0001", subject: "fine" })]).client, fv.vault, OPTS);
  assert.equal(r.failed, 1);
  assert.equal(r.created, 1);
});

// ── scheduler gate + health ─────────────────────────────────────────────────

beforeEach(() => {
  resetDb();
  resetGmailBackfill();
  resetSourceHealth();
  process.env.SECRETS_KEY = crypto.randomBytes(32).toString("base64");
});

function withConfig<T>(over: Partial<typeof config>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, unknown> = {};
  for (const k of Object.keys(over)) prev[k] = (config as Record<string, unknown>)[k];
  Object.assign(config, over);
  return fn().finally(() => Object.assign(config, prev));
}

test("GMAIL_SYNC_ENABLED=false (the default) does nothing — gog is never run", async () => {
  assert.equal(config.gmailSyncEnabled, false);
  putSecret("primary", config.ownerEmail, "google", JSON.stringify({ account: "someone@example.test" }));
  const g = fakeGog([msg()]);
  const n = await runGmailOnce(getVaultRegistry()[0]!, { run: g.run, force: true });
  assert.equal(n, 0);
  assert.equal(g.calls.length, 0);
});

test("enabled: first pass is the 14-day backfill, then 3h; throttled per slot", async () => {
  await withConfig({ gmailSyncEnabled: true, gmailIntervalMs: 3_600_000 }, async () => {
    putSecret("primary", config.ownerEmail, "google", JSON.stringify({ account: "someone@example.test" }));
    const g = fakeGog([]); // empty inbox → the vault is never touched
    const entry = getVaultRegistry()[0]!;
    await runGmailOnce(entry, { run: g.run });
    assert.equal(g.calls[0]![3], "in:inbox newer_than:14d");
    assert.equal(g.calls[0]![5], "100");
    await runGmailOnce(entry, { run: g.run });
    assert.equal(g.calls.length, 1, "same slot → throttled");
    await runGmailOnce(entry, { run: g.run, force: true });
    assert.equal(g.calls[1]![3], "in:inbox newer_than:3h");
    assert.equal(g.calls[1]![5], "30");
  });
});

test("enabled without a google credential: idle, gog never run", async () => {
  await withConfig({ gmailSyncEnabled: true }, async () => {
    const g = fakeGog([msg()]);
    assert.equal(await runGmailOnce(getVaultRegistry()[0]!, { run: g.run, force: true }), 0);
    assert.equal(g.calls.length, 0);
  });
});

test("health: email is a SERVER source when GMAIL_SYNC_ENABLED, inferred desktop source otherwise", async () => {
  const list = async () => [];
  let h = await getSourceHealth({ list });
  assert.equal(h.find((s) => s.name === "email")!.kind, "desktop");
  await withConfig({ gmailSyncEnabled: true }, async () => {
    resetSourceHealth();
    putSecret("primary", config.ownerEmail, "google", JSON.stringify({ account: "someone@example.test" }));
    recordSourceOutcome("primary", "email", new Error("gog failed"));
    h = await getSourceHealth({ list });
    const email = h.filter((s) => s.name === "email");
    assert.equal(email.length, 1, "no duplicate desktop entry");
    assert.equal(email[0]!.kind, "server");
    assert.equal(email[0]!.failureStreak, 1);
    assert.equal(email[0]!.lastError, "gog failed");
  });
});
