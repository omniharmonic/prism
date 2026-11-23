// Batch contact tidy (src/comms/tidy-batch.ts, scripts/comms-batch-tidy.ts): tiers, plan staleness,
// apply through the tidy routes' own writes, resume, undo. Synthetic fixtures; the vault is the fake.
process.env.SECRETS_KEY ??= Buffer.alloc(32, 9).toString("base64");
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db";
import { ensureSingleThread, getThread, replaceConversationMembers, upsertConversation, type ConversationRow } from "../src/comms/store";
import { recentActions, tidyCandidates } from "../src/comms/tidy";
import {
  applyPlan, botOrShortCode, buildPlan, checkPlanIntegrity, DEFAULT_BATCH_OPTIONS, realName, StalePlanError, summarize, undoBatch,
  type BatchOptions, type Plan,
} from "../src/comms/tidy-batch";
import { invalidatePeople } from "../src/people-cache";
import { listRecommendations } from "../src/people-agent-store";
import { installFakeVault, resetDb, type FakeVault } from "./helpers";

let fv: FakeVault;
beforeEach(() => {
  resetDb();
  invalidatePeople();
  fv = installFakeVault();
  // The owner's own person note (OWNER_EMAIL in .env.test claims it): never a target, never a candidate.
  fv.put({ id: "p_owner", path: "vault/people/ben-owner", tags: ["person"], content: "# Ben Owner", metadata: { type: "person", name: "Ben Owner", email: "owner@test.local", phone: "+15550000000" } });
});
afterEach(() => fv.restore());

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const actor = { email: "owner@example.test", via: "test" };
const noSleep = async () => {};

function dm(id: string, title: string, member: string, over: Partial<ConversationRow> = {}): string {
  upsertConversation({
    id, network: "whatsapp", sourceRef: `!${id}:hs`, kind: "dm", title, titleSource: "contact", avatar: null,
    lastEventAt: new Date(NOW).toISOString(), lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox",
    pinned: false, muted: false, archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: `n_${id}`, ...over,
  });
  replaceConversationMembers(id, [{ memberId: member, personId: null }]);
  return ensureSingleThread(id);
}
/** `total` indexed messages in a thread's note scope, `owner` of them from the owner. */
function messages(convId: string, total: number, owner: number): void {
  const ins = db.prepare(`INSERT INTO comms_search_rows (dedupe_key, origin, thread_id, thread_note_id, source_note_id, message_id, sender_name, from_self, sent_at)
    VALUES (?, 'vault', NULL, ?, ?, NULL, ?, ?, ?)`);
  for (let i = 0; i < total; i++) ins.run(`${convId}:${i}`, `n_${convId}`, `n_${convId}`, i < owner ? "Me" : "Them", i < owner ? 1 : 0, NOW - i * 60_000);
}
function person(id: string, name: string, metadata: Record<string, unknown> = {}) {
  return fv.put({ id, path: `vault/people/${name.toLowerCase().replace(/\s+/g, "-")}`, tags: ["person"], content: `# ${name}`, metadata: { type: "person", name, ...metadata } });
}

/** One of every tier. */
function world() {
  const t = {
    ann: dm("c_ann", "Ann (WhatsApp)", "@whatsapp_15550001111:hs"), // A: phone held by exactly one person
    imsg: dm("c_imsg", "Cara", "tel:+15550006666", { network: "imessage" }), // A: iMessage number
    shared: dm("c_shared", "Pat", "@whatsapp_15550002222:hs"), // C: two people share the phone
    bea: dm("c_bea", "Bea Frequent", "@whatsapp_15550003333:hs"), // B: new + frequent + real name
    carl: dm("c_carl", "Carl Rare", "@whatsapp_15550004444:hs"), // D: infrequent
    dana: dm("c_dana", "Dana Smith", "@whatsapp_15550005555:hs"), // C: same name, no key
    code: dm("c_code", "Bank Alerts", "tel:72345", { network: "sms" }), // D: short code
    bot: dm("c_bot", "Acme Bot", "@whatsapp_15550007777:hs"), // D: bot, even though a person holds the number
    num: dm("c_num", "+1 555 000 8888", "@whatsapp_15550008888:hs"), // D: a number, no name
    dmOnly: dm("c_dmonly", "Eve Owner-Heavy", "@whatsapp_15550009999:hs"), // B via the DM rule (few total, ≥3 from owner)
  };
  person("p_ann", "Ann Lee", { phone: "+15550001111" });
  person("p_cara", "Cara Diaz", { phone: "+15550006666" });
  person("p_pat1", "Pat One", { phone: "+15550002222" });
  person("p_pat2", "Pat Two", { phone: "+15550002222" });
  person("p_dana", "Dana Smith");
  person("p_acme", "Acme Support Person", { phone: "+15550007777" });
  messages("c_bea", 12, 4);
  messages("c_carl", 2, 1);
  messages("c_dana", 30, 10);
  messages("c_num", 40, 20);
  messages("c_dmonly", 4, 3);
  return t;
}

const tierOf = (p: Plan, threadId: string) => p.entries.find((e) => e.threadId === threadId)!;

test("names and bots: real display names only; short codes and bots are excluded", () => {
  assert.deepEqual(realName("Bea Frequent"), { name: "Bea Frequent" });
  assert.deepEqual(realName("Zoë"), { name: "Zoë" });
  for (const bad of ["+1 555 000 8888", "@annlee", "john_doe92", "ann@example.test", "Unknown", "WhatsApp User", "  ", "12345", "Verify Bot"]) {
    assert.ok("reason" in realName(bad), bad);
  }
  assert.equal(botOrShortCode(["tel:72345"], "Bank"), "short-code");
  assert.equal(botOrShortCode(["@telegram_annlee:hs"], "Ann"), null);
  assert.equal(botOrShortCode(["mailto:noreply@shop.test"], "Shop"), "bot");
  assert.equal(botOrShortCode(["@whatsapp_15550001111:hs"], "Acme Bot"), "bot");
  assert.equal(botOrShortCode(["@whatsapp_15550001111:hs"], "Ann Lee"), null);
});

test("the dry run decides every tier, per the rules, and writes nothing", async () => {
  const t = world();
  const before = fv.calls.filter((c) => c.method !== "GET").length;
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW });
  assert.equal(fv.calls.filter((c) => c.method !== "GET").length, before, "a dry run writes nothing to the vault");
  assert.equal(db.prepare(`SELECT COUNT(*) FROM comms_tidy_actions`).pluck().get(), 0);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM identity_candidates`).pluck().get(), 0);

  assert.deepEqual([tierOf(plan, t.ann).tier, tierOf(plan, t.ann).personId], ["A", "p_ann"]);
  assert.deepEqual([tierOf(plan, t.imsg).tier, tierOf(plan, t.imsg).personId], ["A", "p_cara"]);
  const shared = tierOf(plan, t.shared);
  assert.deepEqual([shared.tier, shared.reason, shared.candidateIds], ["C", "ambiguous-key", ["p_pat1", "p_pat2"]], "two people share the phone → C, never A");
  assert.deepEqual([tierOf(plan, t.bea).tier, tierOf(plan, t.bea).name], ["B", "Bea Frequent"]);
  assert.deepEqual([tierOf(plan, t.dmOnly).tier], ["B"], "a DM with ≥ 3 owner messages is frequent");
  assert.deepEqual([tierOf(plan, t.carl).tier, tierOf(plan, t.carl).reason], ["D", "infrequent"]);
  const dana = tierOf(plan, t.dana);
  assert.deepEqual([dana.tier, dana.reason, dana.candidateIds, dana.sourceNoteId], ["C", "name-only", ["p_dana"], "n_c_dana"]);
  assert.deepEqual([tierOf(plan, t.code).tier, tierOf(plan, t.code).reason], ["D", "short-code"]);
  assert.deepEqual([tierOf(plan, t.bot).tier, tierOf(plan, t.bot).reason], ["D", "bot"], "a bot is excluded even with a strong-key match");
  assert.equal(tierOf(plan, t.num).tier, "D");

  const s = summarize(plan);
  assert.deepEqual(s.tiers, { A: 2, B: 2, C: 2, D: 4 });
  assert.equal(s.byNetwork.whatsapp!.A, 1);
  assert.equal(s.byNetwork.imessage!.A, 1);
  assert.ok(s.samples.A.includes("Ann (WhatsApp) → Ann Lee"));
  assert.ok(s.samples.B.includes("Bea Frequent → (new) Bea Frequent"));
  assert.equal(plan.batchId, `tb_${plan.hash.slice(0, 16)}`);

  // Thresholds are configurable.
  const strict: BatchOptions = { ...DEFAULT_BATCH_OPTIONS, minTotal: 50, minOwner: 20, dmMinOwner: 50 };
  assert.equal(tierOf(await buildPlan("primary", strict, { now: NOW }), t.bea).tier, "D");
});

test("two counterparts sharing a handle or a name never produce two creates", async () => {
  dm("c_wa", "Gus Green", "@whatsapp_15550001234:hs");
  dm("c_im", "Gus Green", "tel:+15550001234", { network: "imessage" });
  dm("c_other", "Gus Green", "@whatsapp_15550004321:hs");
  for (const c of ["c_wa", "c_im", "c_other"]) messages(c, 20, 5);
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW });
  const tiers = plan.entries.map((e) => `${e.tier}:${e.reason}`).sort();
  assert.equal(tiers.filter((x) => x.startsWith("B:")).length, 1);
  assert.ok(tiers.includes("D:shares-handle-with-planned-create"));
  assert.ok(tiers.includes("D:same-name-as-planned-create"));
});

test("apply runs the plan with the tidy routes' own writes, is idempotent, and undo reverses it", async () => {
  const t = world();
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW });
  const r = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  assert.deepEqual(r.done, { link: 2, create: 2, recommend: 2, ignore: 0 });
  assert.deepEqual(r.skipped, {});

  // A: the handle is on the person, compare-and-set; the thread points at them.
  assert.deepEqual(fv.notes.get("p_ann")!.metadata!.channels, { matrix: "@whatsapp_15550001111:hs" });
  const patch = fv.calls.find((c) => c.method === "PATCH" && c.path.endsWith("/notes/p_ann"))!;
  assert.ok((patch.body as { if_updated_at?: string }).if_updated_at);
  assert.equal(getThread(t.ann)!.personId, "p_ann");
  // B: a new person with the handle in the right field and source "comms-tidy".
  const beaId = getThread(t.bea)!.personId!;
  const bea = fv.notes.get(beaId)!;
  assert.deepEqual(bea.metadata, { type: "person", name: "Bea Frequent", source: "comms-tidy", channels: { matrix: "@whatsapp_15550003333:hs", whatsapp: "@whatsapp_15550003333:hs" } });
  assert.deepEqual(bea.tags, ["person"]);
  // C: questions in the review queue, nothing written to any person; no merge recommendation.
  const cands = db.prepare(`SELECT source_note_id, origin, reason, candidate_ids, status FROM identity_candidates ORDER BY source_note_id`).all() as Record<string, string>[];
  assert.deepEqual(cands.map((c) => [c.source_note_id, c.origin, c.reason, JSON.parse(c.candidate_ids!), c.status]), [
    ["n_c_dana", "backfill:comms-tidy", "name-only", ["p_dana"], "open"],
    ["n_c_shared", "backfill:comms-tidy", "ambiguous-key", ["p_pat1", "p_pat2"], "open"],
  ]);
  assert.equal(fv.calls.some((c) => c.method === "PATCH" && /p_pat|p_dana/.test(c.path)), false);
  assert.equal(listRecommendations("primary").length, 0, "persons are never merged or paired");
  assert.equal(getThread(t.dana)!.personId, undefined, "a question links nothing");
  // D: left alone.
  assert.equal(getThread(t.carl)!.personId, undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM comms_tidy_ignored`).pluck().get(), 0);
  // Audit rows carry the batch id; the client's action list keeps its wire kinds.
  assert.equal(db.prepare(`SELECT COUNT(*) FROM comms_tidy_actions WHERE batch_id = ?`).pluck().get(plan.batchId), 6);
  assert.ok(recentActions().every((a) => a.kind !== "recommend"));

  // Idempotent: the same plan again does nothing new (the fresh plan no longer lists done threads).
  const writes = fv.calls.filter((c) => c.method !== "GET").length;
  const again = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  assert.equal(again.alreadyDone, 6);
  assert.deepEqual(again.done, { link: 0, create: 0, recommend: 0, ignore: 0 });
  assert.equal(fv.calls.filter((c) => c.method !== "GET").length, writes);

  // Undo the whole batch.
  const u = await undoBatch("primary", plan.batchId, { paceMs: 0, sleep: noSleep });
  assert.deepEqual(u.undone, { link: 2, create: 2, recommend: 2 });
  assert.deepEqual(u.refused, {});
  assert.equal(fv.notes.get("p_ann")!.metadata!.channels ?? null, null, "the person note is as it was");
  assert.equal(getThread(t.ann)!.personId, undefined);
  assert.ok(fv.notes.get(beaId)!.tags!.includes("prism-trashed"), "a created person goes to the Trash (restorable)");
  assert.equal(getThread(t.bea)!.personId, undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM identity_candidates`).pluck().get(), 0, "the batch's open questions are withdrawn");
  assert.equal((await undoBatch("primary", plan.batchId, { paceMs: 0, sleep: noSleep })).alreadyUndone, 6);
});

test("undo leaves what was edited or decided since", async () => {
  world();
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW });
  await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  const n = fv.notes.get("p_ann")!;
  fv.put({ ...n, metadata: { ...n.metadata, channels: { matrix: "@whatsapp_15550001111:hs", telegram: "@ann" } }, updatedAt: "2026-12-01T00:00:00.000Z" });
  db.prepare(`UPDATE identity_candidates SET status = 'resolved' WHERE source_note_id = 'n_c_dana'`).run();
  const u = await undoBatch("primary", plan.batchId, { paceMs: 0, sleep: noSleep });
  assert.equal(u.refused.changed_since, 2);
  assert.equal((fv.notes.get("p_ann")!.metadata!.channels as Record<string, string>).telegram, "@ann", "never overwritten");
  assert.equal(db.prepare(`SELECT status FROM identity_candidates WHERE source_note_id = 'n_c_dana'`).pluck().get(), "resolved");
});

test("a stale, edited or too-old plan is refused and writes nothing", async () => {
  const t = world();
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW });
  // Edited plan file → integrity refusal.
  const tampered = JSON.parse(JSON.stringify(plan)) as Plan;
  tampered.entries.find((e) => e.threadId === t.bea)!.name = "Someone Else";
  assert.throws(() => checkPlanIntegrity(tampered), /hash mismatch/);
  assert.equal(checkPlanIntegrity(JSON.parse(JSON.stringify(plan))).batchId, plan.batchId);
  // The world changed: Bea now has a namesake → B would become C. Refused, nothing written.
  person("p_bea", "Bea Frequent");
  invalidatePeople();
  const writes = fv.calls.filter((c) => c.method !== "GET").length;
  await assert.rejects(applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW }), (e: unknown) => e instanceof StalePlanError && e.stale === 1 && e.why === "changed");
  assert.equal(fv.calls.filter((c) => c.method !== "GET").length, writes);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM comms_tidy_actions`).pluck().get(), 0);
  // Too old.
  await assert.rejects(applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW + 48 * 3_600_000, maxAgeMs: 24 * 3_600_000 }), (e: unknown) => e instanceof StalePlanError && e.why === "too_old");
});

test("rate-limited and resumable: --limit stops, the next run continues; --ignore-low ignores D and undoes", async () => {
  world();
  const plan = await buildPlan("primary", { ...DEFAULT_BATCH_OPTIONS, ignoreLow: true }, { now: NOW });
  const paused: number[] = [];
  const first = await applyPlan(plan, { actor, paceMs: 250, sleep: async (ms) => { paused.push(ms); }, limit: 3, now: NOW });
  assert.equal(first.stoppedEarly, "limit");
  assert.equal(first.done.link + first.done.create + first.done.recommend + first.done.ignore, 3);
  assert.ok(paused.length >= 2 && paused.every((ms) => ms === 250), "a pause after each vault write");
  const second = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  assert.equal(second.alreadyDone, 3);
  assert.equal(second.stoppedEarly, null);
  assert.equal(second.done.ignore, 4, "the D tier is ignored (local only)");
  assert.equal(db.prepare(`SELECT COUNT(*) FROM comms_tidy_ignored`).pluck().get(), 4);
  assert.equal(tidyCandidates(NOW).length, 2, "only the C questions stay in People to Tidy");
  const u = await undoBatch("primary", plan.batchId, { paceMs: 0, sleep: noSleep });
  assert.equal(u.undone.ignore, 4);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM comms_tidy_ignored`).pluck().get(), 0);
  assert.equal(tidyCandidates(NOW).length, 10);
});

test("A and B give the counterpart's DM thread notes a verified messages-with edge (links only); undo removes only those", async () => {
  const t = world();
  const thread = (id: string, platform: string, links: Array<{ sourceId: string; targetId: string; relationship: string }> = []) =>
    fv.put({ id, path: `vault/messages/${id}`, tags: ["message-thread"], content: `[2026-11-20 10:00] Them: hello`, metadata: { type: "message-thread", platform, title: "Kept title" }, links });
  thread("n_c_ann", "whatsapp");
  thread("n_c_bea", "whatsapp");
  thread("n_c_imsg", "imessage", [{ sourceId: "n_c_imsg", targetId: "p_cara", relationship: "messages-with" }]);
  thread("n_c_carl", "whatsapp");
  // A second DM with Ann on another conversation: her thread note gets the edge too.
  upsertConversation({ id: "c_ann2", network: "whatsapp", sourceRef: "!c_ann2:hs", kind: "dm", title: "Ann", titleSource: "contact", avatar: null,
    lastEventAt: new Date(NOW - 86_400_000).toISOString(), lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "archived",
    pinned: false, muted: false, archived: true, triage: null, accountLabel: null, capabilities: null, vaultNoteId: "n_c_ann2" });
  replaceConversationMembers("c_ann2", [{ memberId: "@whatsapp_15550001111:hs", personId: null }]);
  thread("n_c_ann2", "whatsapp");
  const threadsList = async () => [...fv.notes.values()].filter((n) => (n.tags ?? []).includes("message-thread"));

  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: threadsList });
  assert.deepEqual(tierOf(plan, t.ann).threadNotes, ["n_c_ann", "n_c_ann2"]);
  assert.deepEqual(plan.forecast, {
    known: true, threadNotes: 5, withPersonNow: 1, withPersonAfter: 4,
    byPlatform: { whatsapp: { notes: 4, withPersonNow: 0, gain: 3 }, imessage: { notes: 1, withPersonNow: 1, gain: 0 } },
  });
  assert.equal(plan.hash, (await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null })).hash, "the forecast is not part of the decision");

  const before = new Map([...fv.notes.values()].map((n) => [n.id, JSON.stringify({ c: n.content, m: n.metadata })]));
  const r = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  assert.deepEqual(r.threadLinks, { added: 3, existing: 1, failed: 0 });
  const edge = (id: string, to: string) => (fv.notes.get(id)!.links ?? []).some((l) => l.targetId === to && l.relationship === "messages-with");
  const beaId = getThread(t.bea)!.personId!;
  assert.ok(edge("n_c_ann", "p_ann") && edge("n_c_ann2", "p_ann") && edge("n_c_bea", beaId) && edge("n_c_imsg", "p_cara"));
  assert.equal(edge("n_c_carl", beaId) || (fv.notes.get("n_c_carl")!.links ?? []).length > 0, false, "D threads untouched");
  for (const id of ["n_c_ann", "n_c_ann2", "n_c_bea", "n_c_imsg"]) {
    assert.equal(JSON.stringify({ c: fv.notes.get(id)!.content, m: fv.notes.get(id)!.metadata }), before.get(id), "no body, metadata or title change on a thread note");
  }
  const writes = fv.calls.filter((c) => c.method === "PATCH" && /\/notes\/n_c_/.test(c.path));
  assert.equal(writes.length, 3);
  for (const w of writes) {
    const b = w.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(b).sort(), ["if_updated_at", "links"], "links-only, compare-and-set");
  }
  const reads = fv.calls.filter((c) => c.method === "GET" && /\/notes\/n_c_ann\b/.test(c.path)).length;
  assert.ok(reads >= 2, "each write is verified by reading the note back");

  const u = await undoBatch("primary", plan.batchId, { paceMs: 0, sleep: noSleep });
  assert.deepEqual(u.refused, {});
  assert.equal(edge("n_c_ann", "p_ann") || edge("n_c_ann2", "p_ann") || edge("n_c_bea", beaId), false, "the batch's edges are gone");
  assert.ok(edge("n_c_imsg", "p_cara"), "an edge that was there before stays");
  assert.ok(fv.notes.get(beaId)!.tags!.includes("prism-trashed"), "a created person with only the batch's edges is still undoable");
});

test("a thread note that changes between read and write is retried on the new version, never overwritten", async () => {
  world();
  fv.put({ id: "n_c_ann", path: "vault/messages/n_c_ann", tags: ["message-thread"], content: "one", metadata: { type: "message-thread", platform: "whatsapp" }, updatedAt: "2026-11-20T00:00:00.000Z" });
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  // An ingest append lands just before the tidy's first link write to the thread note.
  const real = globalThis.fetch;
  let appended = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!appended && init?.method === "PATCH" && String(input).includes("/notes/n_c_ann")) {
      appended = true;
      const n = fv.notes.get("n_c_ann")!;
      fv.put({ ...n, content: "one\ntwo", updatedAt: "2026-11-21T00:00:00.000Z" });
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    const r = await applyPlan(plan, { actor, paceMs: 0, now: NOW, sleep: noSleep });
    assert.equal(r.threadLinks.added, 1);
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(appended);
  assert.equal(fv.calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/notes/n_c_ann")).length, 2, "refused once (409), retried on the new version");
  assert.equal(fv.notes.get("n_c_ann")!.content, "one\ntwo", "the append survives (compare-and-set, links-only)");
  assert.ok((fv.notes.get("n_c_ann")!.links ?? []).some((l) => l.targetId === "p_ann"));
});

// ── fix round 1 (adversarial review) ─────────────────────────────────────────

function dm2(id: string, title: string, members: string[], over: Partial<ConversationRow> = {}): string {
  const t = dm(id, title, members[0]!, over);
  replaceConversationMembers(id, members.map((m) => ({ memberId: m, personId: null })));
  return t;
}

test("C1: a 'DM' with two non-owner members is never linked or created from; an owner ghost is not a member", async () => {
  person("p_x", "Xena Park", { phone: "+15550001111" });
  const two = dm2("c_two", "Xena", ["@whatsapp_15550001111:hs", "@whatsapp_15559990000:hs"]);
  db.prepare(`INSERT INTO comms_owner_senders (mxid, source, stats_json) VALUES (?, 'detected', NULL)`).run("@signal_owner-ghost:hs");
  const withGhost = dm2("c_ghost", "Yara", ["@signal_owner-ghost:hs", "@whatsapp_15550002345:hs"], { network: "signal" });
  person("p_y", "Yara Quinn", { phone: "+15550002345" });
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  assert.deepEqual([tierOf(plan, two).tier, tierOf(plan, two).reason], ["D", "not-one-counterpart"]);
  const g = tierOf(plan, withGhost);
  assert.deepEqual([g.tier, g.personId, g.members], ["A", "p_y", ["@whatsapp_15550002345:hs"]], "only the single counterpart");
  await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  const ch = JSON.stringify(fv.notes.get("p_y")!.metadata);
  assert.ok(!ch.includes("owner-ghost"), "the owner's ghost id is never written onto anyone");
  assert.equal(JSON.stringify(fv.notes.get("p_x")!.metadata).includes("15559990000"), false);
  // The route refuses the two-member "DM" too.
  await assert.rejects(linkThreadRoute(two, "p_x"), (e: unknown) => (e as { code?: string }).code === "not_one_counterpart");
});

async function linkThreadRoute(threadId: string, personId: string) {
  const { linkThread } = await import("../src/comms/tidy");
  return linkThread("primary", threadId, personId, actor);
}

test("C2: the owner's own person note is never a link target or a candidate", async () => {
  const alt = dm("c_alt", "Ben", "mailto:owner@test.local", { network: "imessage" });
  const phone = dm("c_ph", "Ben iPad", "tel:+15550000000", { network: "imessage" });
  dm("c_namesake", "Ben Owner", "@whatsapp_15550004040:hs");
  messages("c_namesake", 20, 5);
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  assert.equal(tierOf(plan, alt).reason, "owner");
  assert.equal(tierOf(plan, phone).reason, "owner");
  assert.ok(plan.entries.every((e) => e.personId !== "p_owner" && !(e.candidateIds ?? []).includes("p_owner")));
  await assert.rejects(linkThreadRoute(dm("c_any", "Zed", "@whatsapp_15550005050:hs"), "p_owner"), (e: unknown) => (e as { code?: string }).code === "owner_person");
  // No owner person known → the plan refuses (unless explicitly allowed).
  fv.notes.delete("p_owner");
  invalidatePeople();
  await assert.rejects(buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null }), /owner's person note/);
  await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null, allowNoOwnerPerson: true });
});

test("I1: B only creates from a full name; first names, nicknames and businesses never become people", async () => {
  person("p_sj", "Sarah Jones");
  const sarah = dm("c_sarah", "Sarah", "@whatsapp_15550006001:hs");
  const mom = dm("c_mom", "Mom", "tel:+15550006002", { network: "imessage" });
  const pizza = dm("c_pizza", "Joe's Pizza", "tel:+15550006003", { network: "sms" });
  const kid = dm("c_kid", "Timmy", "@whatsapp_15550006004:hs");
  const uncle = dm("c_uncle", "Uncle Bob", "@whatsapp_15550006005:hs");
  for (const c of ["c_sarah", "c_mom", "c_pizza", "c_kid", "c_uncle"]) messages(c, 30, 10);
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  assert.deepEqual([tierOf(plan, sarah).tier, tierOf(plan, sarah).reason, tierOf(plan, sarah).candidateIds], ["C", "single-token-name", ["p_sj"]]);
  assert.deepEqual([tierOf(plan, mom).tier, tierOf(plan, pizza).tier, tierOf(plan, kid).tier, tierOf(plan, uncle).tier], ["D", "D", "D", "D"]);
  assert.equal(tierOf(plan, pizza).reason, "business-name");
  assert.equal(tierOf(plan, kid).reason, "single-token-name");
  assert.equal(plan.entries.filter((e) => e.tier === "B").length, 0);
});

test("I2: a strong-key match whose full name disagrees with the person goes to review, not A", async () => {
  person("p_marg", "Margaret Lee", { phone: "+15550007001", aliases: "Maggie" });
  const dad = dm("c_dad", "David Lee", "tel:+15550007001", { network: "imessage" });
  const maggie = dm("c_mag", "Maggie Lee", "@whatsapp_15550007001:hs");
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  assert.deepEqual([tierOf(plan, dad).tier, tierOf(plan, dad).reason, tierOf(plan, dad).candidateIds], ["C", "name-key-mismatch", ["p_marg"]]);
  assert.deepEqual([tierOf(plan, maggie).tier, tierOf(plan, maggie).personId], ["A", "p_marg"], "a shared token (Lee / Maggie) is consistent");
});

test("M3/M5/I6/I7: an existing question is left alone; failed thread links are retried on resume; one people listing per run; undo is paced", async () => {
  world();
  // An open question for Dana's thread already exists (filed by the link job): never refreshed.
  const { enqueueCandidate } = await import("../src/identity-store");
  enqueueCandidate({ vaultId: "primary", sourceNoteId: "n_c_dana", relationship: "messages-with", key: { kind: "matrix", value: "@whatsapp_15550005555:hs" }, display: "D", candidateIds: ["p_x"], reason: "ambiguous-key", origin: "ingest:matrix" });
  // Ann's thread note fails its first link (vault 500), the resume retries it.
  fv.put({ id: "n_c_ann", path: "vault/messages/n_c_ann", tags: ["message-thread"], content: "x", metadata: { type: "message-thread", platform: "whatsapp" } });
  const real = globalThis.fetch;
  let failOnce = true;
  let peopleLists = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (failOnce && init?.method === "PATCH" && u.includes("/notes/n_c_ann")) { failOnce = false; return new Response("{}", { status: 500 }); }
    if ((!init?.method || init.method === "GET") && u.includes("/notes?") && u.includes("tag=person")) peopleLists++;
    return real(input, init);
  }) as typeof fetch;
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  try {
    peopleLists = 0;
    const r = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
    assert.equal(r.threadLinks.failed, 1);
    assert.equal(r.skipped.already_queued, 1, "the existing question is not touched");
    assert.ok(peopleLists <= 3, `one people listing for the run (+ the staleness plan), not one per entry: ${peopleLists}`);
    const again = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
    assert.equal(again.retried, 1);
    assert.equal(again.threadLinks.added, 1);
  } finally {
    globalThis.fetch = real;
  }
  const q = db.prepare(`SELECT origin, reason, candidate_ids FROM identity_candidates WHERE source_note_id = 'n_c_dana'`).get() as Record<string, string>;
  assert.deepEqual([q.origin, q.reason, q.candidate_ids], ["ingest:matrix", "ambiguous-key", JSON.stringify(["p_x"])]);
  const paused: number[] = [];
  await undoBatch("primary", plan.batchId, { paceMs: 7, sleep: async (ms) => { paused.push(ms); } });
  assert.ok(paused.length >= 4, "paced inside each undo (every thread note), not only between actions");
});

test("I3: undo of a created person also removes ingest-added edges on the counterpart's DM notes; an edited person is reported, not removed", async () => {
  const t = world();
  fv.put({ id: "n_c_bea", path: "vault/messages/n_c_bea", tags: ["message-thread"], content: "x", metadata: { type: "message-thread", platform: "whatsapp" } });
  fv.put({ id: "n_c_dmonly", path: "vault/messages/n_c_dmonly", tags: ["message-thread"], content: "x", metadata: { type: "message-thread", platform: "whatsapp" } });
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  const beaId = getThread(t.bea)!.personId!;
  const eveId = getThread(t.dmOnly)!.personId!;
  // After the batch, Bea writes from a second chat: ingest links that new DM note to her person
  // (she holds the key now) — and Eve's person is edited by the owner.
  upsertConversation({ id: "c_bea2", network: "whatsapp", sourceRef: "!c_bea2:hs", kind: "dm", title: "Bea", titleSource: "contact", avatar: null,
    lastEventAt: new Date(NOW).toISOString(), lastPreview: null, unreadCount: 0, unreadTrusted: false, folder: "inbox",
    pinned: false, muted: false, archived: false, triage: null, accountLabel: null, capabilities: null, vaultNoteId: "n_c_bea2" });
  replaceConversationMembers("c_bea2", [{ memberId: "@whatsapp_15550003333:hs", personId: beaId }]);
  fv.put({ id: "n_c_bea2", path: "vault/messages/n_c_bea2", tags: ["message-thread"], content: "x", metadata: { type: "message-thread", platform: "whatsapp" },
    links: [{ sourceId: "n_c_bea2", targetId: beaId, relationship: "messages-with" }] });
  const eve = fv.notes.get(eveId)!;
  fv.put({ ...eve, content: `${eve.content}\n\nMet at the climbing gym.`, updatedAt: "2026-12-01T00:00:00.000Z" });
  const u = await undoBatch("primary", plan.batchId, { paceMs: 0, sleep: noSleep });
  assert.equal(u.refused.changed_since, 1, "the edited person is reported, not removed");
  assert.ok(fv.notes.get(beaId)!.tags!.includes("prism-trashed"));
  for (const id of ["n_c_bea", "n_c_bea2"]) assert.equal((fv.notes.get(id)!.links ?? []).some((l) => l.targetId === beaId), false, id);
  assert.equal(fv.notes.get(eveId)!.tags!.includes("prism-trashed"), false);
});

// ── fix round 2 (re-review) ──────────────────────────────────────────────────

test("N2: a second note that is the owner, his +tag address and a chat titled as him are never targets or creates", async () => {
  person("p_owner2", "Ben Owner", { phone: "+15550000123" }); // a live duplicate of the owner
  const dupe = dm("c_dupe", "Ben", "tel:+15550000123", { network: "imessage" });
  const plus = dm("c_plus", "Ben O.", "mailto:owner+ipad@test.local", { network: "imessage" });
  const named = dm("c_named", "Ben Owner", "@whatsapp_15550004041:hs");
  for (const c of ["c_dupe", "c_plus", "c_named"]) messages(c, 30, 10);
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  assert.deepEqual([tierOf(plan, dupe).tier, tierOf(plan, dupe).reason], ["D", "owner"]);
  assert.deepEqual([tierOf(plan, plus).tier, tierOf(plan, plus).reason], ["D", "owner"]);
  assert.deepEqual([tierOf(plan, named).tier, tierOf(plan, named).reason], ["D", "owner"]);
  assert.ok(plan.entries.every((e) => !["p_owner", "p_owner2"].includes(e.personId ?? "") && !(e.candidateIds ?? []).some((id) => id.startsWith("p_owner"))));
  const r = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  assert.equal(r.done.create + r.done.link, 0);
  await assert.rejects(linkThreadRoute(dm("c_z", "Zed Zee", "@whatsapp_15550005051:hs"), "p_owner2"), (e: unknown) => (e as { code?: string }).code === "owner_person");
});

test("N3: initials, curly-apostrophe businesses and trades are never full names", async () => {
  const names = { c_i1: "Ana S", c_i2: "Tommy H", c_i3: "Ben O.", c_b1: "Joe’s Diner", c_b2: "Mike Plumber", c_b3: "Acme Studio LLC", c_ok: "Ana Silva" };
  let n = 6100;
  for (const [id, title] of Object.entries(names)) { dm(id, title, `@whatsapp_1555000${n++}:hs`); messages(id, 30, 10); }
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  const tier = (id: string) => plan.entries.find((e) => e.threadId === ensureSingleThread(id))!;
  for (const id of ["c_i1", "c_i2", "c_i3"]) assert.deepEqual([tier(id).tier, tier(id).reason], ["D", "initial-only"], id);
  for (const id of ["c_b1", "c_b2", "c_b3"]) assert.deepEqual([tier(id).tier, tier(id).reason], ["D", "business-name"], id);
  assert.equal(tier("c_ok").tier, "B");
});

test("N5: a looser spelling of a key (Gmail dots/+tag, a phone without '+') is a review question, never a duplicate create", async () => {
  person("p_ana", "Ana Smith", { email: "ana.smith@gmail.com" });
  person("p_tom", "Tom Hill", { phone: "447911123456" });
  person("p_us", "Uma Stone", { phone: "(555) 000-3434" });
  const a = dm("c_a", "Ana Smithers", "mailto:anasmith+work@googlemail.com", { network: "imessage" });
  const t = dm("c_t", "Tommy Hillman", "@whatsapp_447911123456:hs");
  const u = dm("c_u", "Uma Stoner", "tel:+15550003434", { network: "imessage" });
  for (const c of ["c_a", "c_t", "c_u"]) messages(c, 30, 10);
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  assert.deepEqual([tierOf(plan, a).tier, tierOf(plan, a).reason, tierOf(plan, a).candidateIds], ["C", "loose-key", ["p_ana"]]);
  assert.deepEqual([tierOf(plan, t).tier, tierOf(plan, t).candidateIds], ["C", ["p_tom"]]);
  assert.deepEqual([tierOf(plan, u).tier, tierOf(plan, u).candidateIds], ["C", ["p_us"]]);
});

test("C1 follow-up: a WhatsApp phone + LID pair of one contact is one counterpart; both ids are theirs", async () => {
  person("p_wa", "Wanda Park", { phone: "+15550008080" });
  const th = dm2("c_wa", "Wanda", ["@whatsapp_15550008080:hs", "@whatsapp_lid-123456789:hs"]);
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  const e = tierOf(plan, th);
  assert.deepEqual([e.tier, e.personId, [...e.members].sort()], ["A", "p_wa", ["@whatsapp_15550008080:hs", "@whatsapp_lid-123456789:hs"]]);
  await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  assert.ok(JSON.stringify(fv.notes.get("p_wa")!.metadata).includes("@whatsapp_lid-123456789:hs"));
  // Two DIFFERENT phones are still two people.
  const two = dm2("c_two2", "Group-ish", ["@whatsapp_15550008181:hs", "@whatsapp_15550008282:hs"]);
  assert.equal(tierOf(await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null }), two).reason, "not-one-counterpart");
});

test("N7: a plan made with allowNoOwnerPerson can be applied", async () => {
  fv.notes.delete("p_owner");
  invalidatePeople();
  person("p_ann", "Ann Lee", { phone: "+15550001111" });
  dm("c_ann", "Ann", "@whatsapp_15550001111:hs");
  const plan = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null, allowNoOwnerPerson: true });
  assert.equal(checkPlanIntegrity(JSON.parse(JSON.stringify(plan))).allowNoOwnerPerson, true);
  const r = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  assert.equal(r.done.link, 1);
});

// ── owner-approved promotion + exclusions (2026-11-23) ───────────────────────

test("--promote-exact-names links an exact full-name single-candidate match (key written, thread linked, undoable); look-alikes stay C", async () => {
  person("p_jo", "Josie Siegel");
  person("p_al1", "Alex Kim");
  person("p_al2", "Alex Kim", {});
  fv.put({ ...fv.notes.get("p_al2")!, path: "vault/people/alex-kim-2" });
  person("p_mo", "Mona Lisa");
  const jo = dm("c_jo", "Josie Siegel 🌿", "@whatsapp_15550009001:hs");
  const al = dm("c_al", "Alex Kim", "@whatsapp_15550009002:hs");
  const mo = dm("c_mo", "Mona", "@whatsapp_15550009003:hs");
  const accent = dm("c_ac", "JOSÉ  Ruiz!", "@whatsapp_15550009004:hs");
  person("p_jr", "José Ruiz");
  fv.put({ id: "n_c_jo", path: "vault/messages/n_c_jo", tags: ["message-thread"], content: "x", metadata: { type: "message-thread", platform: "whatsapp" } });
  const off = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  assert.deepEqual([tierOf(off, jo).tier, tierOf(off, jo).reason], ["C", "name-only"], "off by default");
  const opts = { ...DEFAULT_BATCH_OPTIONS, promoteExactNames: true };
  const plan = await buildPlan("primary", opts, { now: NOW, threadNotes: null });
  assert.notEqual(plan.hash, off.hash);
  assert.deepEqual([tierOf(plan, jo).tier, tierOf(plan, jo).reason, tierOf(plan, jo).personId], ["A", "exact-name", "p_jo"], "emoji stripped, exact");
  assert.deepEqual([tierOf(plan, accent).tier, tierOf(plan, accent).personId], ["A", "p_jr"], "case, accents, punctuation, spacing normalised");
  assert.deepEqual([tierOf(plan, al).tier, tierOf(plan, al).reason], ["C", "ambiguous-name"], "two candidates: never promoted");
  assert.equal(tierOf(plan, mo).tier === "A", false, "a first name only is never promoted");
  const r = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  assert.equal(r.done.link, 2);
  assert.deepEqual(fv.notes.get("p_jo")!.metadata!.channels, { matrix: "@whatsapp_15550009001:hs" }, "the chat's key is recorded on the person");
  assert.ok((fv.notes.get("n_c_jo")!.links ?? []).some((l) => l.targetId === "p_jo"));
  assert.equal(getThread(jo)!.personId, "p_jo");
  const u = await undoBatch("primary", plan.batchId, { paceMs: 0, sleep: noSleep });
  assert.equal(u.undone.link, 2);
  assert.equal(fv.notes.get("p_jo")!.metadata!.channels ?? null, null);
  assert.equal((fv.notes.get("n_c_jo")!.links ?? []).length, 0);
});

test("a promoted person renamed before the apply is refused (changed_since_plan), nothing written", async () => {
  person("p_jo", "Josie Siegel");
  dm("c_jo", "Josie Siegel", "@whatsapp_15550009001:hs");
  const plan = await buildPlan("primary", { ...DEFAULT_BATCH_OPTIONS, promoteExactNames: true }, { now: NOW, threadNotes: null });
  const fresh = plan; // the freshness check passes (same decisions); the person is renamed between the check and the write
  fv.put({ ...fv.notes.get("p_jo")!, metadata: { type: "person", name: "Josie S. Wong" }, updatedAt: "2026-12-01T00:00:00.000Z" });
  invalidatePeople();
  const r = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW, fresh: async () => fresh });
  assert.equal(r.skipped.changed_since_plan, 1);
  assert.equal(r.done.link, 0);
  assert.equal(fv.notes.get("p_jo")!.metadata!.channels, undefined);
});

test("B: emoji and trailing symbols stripped before creating; --exclude-name; org names and names with digits never created", async () => {
  const names = { c_rc: "Robin Cook 🛡️", c_rz: "Razvan- ZER8🧠", c_cd: "Circularity DAO", c_sh: "Syd Harv", c_ok: "Nora Bell" };
  let n = 7100;
  for (const [id, title] of Object.entries(names)) { dm(id, title, `@whatsapp_1555000${n++}:hs`); messages(id, 30, 10); }
  const opts = { ...DEFAULT_BATCH_OPTIONS, excludeNames: ["Circularity DAO", "syd  harv"] };
  const plan = await buildPlan("primary", opts, { now: NOW, threadNotes: null });
  const tier = (id: string) => plan.entries.find((e) => e.threadId === ensureSingleThread(id))!;
  assert.deepEqual([tier("c_rc").tier, tier("c_rc").name], ["B", "Robin Cook"]);
  assert.deepEqual([tier("c_rz").tier, tier("c_rz").reason], ["D", "not-a-name"]);
  assert.equal(tier("c_cd").tier, "D");
  assert.deepEqual([tier("c_sh").tier, tier("c_sh").reason], ["D", "excluded-by-owner"]);
  assert.equal(tier("c_ok").tier, "B");
  // Without the exclusion, Syd Harv would be a create; the DAO is never one.
  const plain = await buildPlan("primary", DEFAULT_BATCH_OPTIONS, { now: NOW, threadNotes: null });
  assert.equal(plain.entries.find((e) => e.threadId === ensureSingleThread("c_sh"))!.tier, "B");
  assert.equal(plain.entries.find((e) => e.threadId === ensureSingleThread("c_cd"))!.reason, "business-name");
  const r = await applyPlan(plan, { actor, paceMs: 0, sleep: noSleep, now: NOW });
  assert.equal(r.done.create, 2);
  assert.ok([...fv.notes.values()].some((x) => x.metadata?.name === "Robin Cook" && x.path === "vault/people/robin-cook"), "created under the clean name");
});

// ── email senders + --skip-network (2026-11-23) ──────────────────────────────

function emailDm(id: string, title: string, addr: string, from: string, labels: string[] = []): string {
  const t = dm(id, title, `mailto:${addr}`, { network: "email" as never });
  db.prepare(`INSERT INTO comms_email_messages (conversation_id, note_id, message_id, sent_at, is_self, note_version, meta_json, snippet) VALUES (?, ?, ?, ?, 0, NULL, ?, NULL)`)
    .run(id, `e_${id}`, `<${id}@x>`, new Date(NOW).toISOString(), JSON.stringify({ subject: "s", from, to: "owner@test.local", cc: "", labels, account: null }));
  return t;
}

test("email is never promoted or created from by default; platform / list / 'via' senders are never written onto a person", async () => {
  person("p_clare", "Clare Brodeur");
  person("p_dana", "Dana Smith", { email: "dana@smith.test" });
  person("p_eve", "Eve Hall");
  const hylo = emailDm("c_hylo", "Clare Brodeur (via Hylo)", "notifications@hylo.com", "Clare Brodeur (via Hylo) <notifications@hylo.com>");
  const list = emailDm("c_list", "COhere Boulder", "cohere@lists.example.org", "COhere Boulder <cohere@lists.example.org>", ["BULK"]);
  const exact = emailDm("c_exact", "Eve Hall", "eve.hall@gmail.com", "Eve Hall <eve.hall@gmail.com>");
  const strong = emailDm("c_strong", "Dana Smith", "dana@smith.test", "Dana Smith <dana@smith.test>");
  const newbie = emailDm("c_new", "Gary Moss", "gary@moss.test", "Gary Moss <gary@moss.test>");
  const via = emailDm("c_via", "Clare Brodeur", "clare.relay@gmail.com", "Clare Brodeur (via Hylo) <clare.relay@gmail.com>");
  const platform = emailDm("c_plat", "Clare Brodeur", "clare@hylo.com", "Clare Brodeur <clare@hylo.com>");
  messages("c_new", 30, 10);
  const opts = { ...DEFAULT_BATCH_OPTIONS, promoteExactNames: true };
  const plan = await buildPlan("primary", opts, { now: NOW, threadNotes: null });
  assert.equal(tierOf(plan, hylo).tier, "D");
  assert.ok(["bot", "email-not-personal"].includes(tierOf(plan, hylo).reason));
  assert.deepEqual([tierOf(plan, via).tier, tierOf(plan, via).reason], ["D", "email-not-personal"], "a 'via' sender name, even from a personal-looking address");
  assert.deepEqual([tierOf(plan, platform).tier, tierOf(plan, platform).reason], ["D", "email-not-personal"]);
  assert.deepEqual([tierOf(plan, list).tier, tierOf(plan, list).reason], ["D", "email-not-personal"]);
  assert.notEqual(tierOf(plan, exact).tier, "A", "an email exact-name is never promoted by default");
  assert.equal(tierOf(plan, newbie).tier, "D", "never created from email by default");
  assert.equal(tierOf(plan, newbie).reason, "email-not-creatable");
  assert.deepEqual([tierOf(plan, strong).tier, tierOf(plan, strong).personId], ["A", "p_dana"], "a personal address already on the person still links");
  // Opt-in: a personal address may be promoted; a platform sender never.
  const allowed = await buildPlan("primary", { ...opts, allowEmail: true }, { now: NOW, threadNotes: null });
  assert.deepEqual([tierOf(allowed, exact).tier, tierOf(allowed, exact).reason], ["A", "exact-name"]);
  assert.equal(tierOf(allowed, hylo).tier, "D");
  assert.notEqual(allowed.hash, plan.hash);
});

test("--skip-network leaves a network out entirely", async () => {
  person("p_jo", "Josie Siegel");
  const wa = dm("c_wa", "Josie Siegel", "@whatsapp_15550009101:hs");
  const sig = dm("c_sig", "Josie Siegel", "@signal_15550009102:hs", { network: "signal" });
  const plan = await buildPlan("primary", { ...DEFAULT_BATCH_OPTIONS, promoteExactNames: true, skipNetworks: ["Signal"] }, { now: NOW, threadNotes: null });
  assert.deepEqual([tierOf(plan, sig).tier, tierOf(plan, sig).reason], ["D", "skipped-network"]);
  assert.equal(tierOf(plan, wa).tier, "A");
});
