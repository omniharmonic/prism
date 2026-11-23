/**
 * Behavioural check for Messages over Comms (Comms sprint Task 6, D19). No network.
 * Run: npm run verify:comms -w @prism/web
 *
 * Covers:
 *  - groupRuns (the Comms app's rule): one run per sender + direction + local day + ≤ 60-minute gap; a
 *    gap > 60 min starts a run with `afterGap`; a new day starts one with `newDay`; system notices and
 *    unsent (redacted) messages never join a run;
 *    the same sender as you vs them (isSelf) never share a run; an out-of-order time never joins;
 *  - threadQueryString: every filter on the wire as the server parses it (comma lists, attention,
 *    person/note, trimmed q capped at 200, no empty params);
 *  - commsUnavailable: only 401/403/404/409 fall back to the vault notes; 5xx/429/network do not;
 *  - the native image proxy accepts a signed comms media path (bearer fetch) and nothing looser, and
 *    re-points a real comms <img> to a blob: URL fetched from that exact server path;
 *  - which view Messages shows for every probe outcome (offline / 5xx → saved vault view);
 *  - the transcript poll backs off after failures and stops at 5 min.
 */
import assert from "node:assert/strict";
import { groupRuns, threadQueryString, commsUnavailable, TIME_GAP_MS } from "../../../packages/core/src/lib/comms/model.ts";
import type { CommsMessage } from "../../../packages/core/src/lib/comms/types.ts";
import { ownAttachmentPath, proxyImageElement, ImageBlobCache } from "../src/native/externalImages.ts";
import { messagesSource } from "../../../packages/core/src/components/comms/useCommsProbe.ts";
import { backoff, commsTransient } from "../../../packages/core/src/lib/comms/model.ts";
import { Window } from "happy-dom";

const T0 = new Date(2026, 9, 6, 9, 0).getTime(); // local 09:00
const MIN = 60_000;
let n = 0;
const m = (sender: string, at: number, over: Partial<CommsMessage> = {}): CommsMessage => ({
  id: `$${++n}`, threadId: "th", channel: { network: "telegram", accountLabel: null },
  source: { network: "telegram", eventId: `$${n}`, ref: `$${n}` },
  sender: { id: sender, name: sender, avatar: null, isSelf: sender === "me", isOmni: false },
  sentAt: new Date(at).toISOString(), body: null, attachments: [], linkPreviews: [], reactions: [], delivery: null, redacted: false, ...over,
});
const shape = (msgs: CommsMessage[]) => groupRuns(msgs).map((r) => `${r.messages.length}${r.newDay ? "D" : ""}${r.afterGap ? "G" : ""}`);

// same sender, close together → one run; another sender → a new run
assert.deepEqual(shape([m("a", T0), m("a", T0 + MIN), m("b", T0 + 2 * MIN), m("a", T0 + 3 * MIN)]), ["2D", "1", "1"]);
// the gap rule is MORE than 60 minutes (Comms: `> gap`): exactly 60:00 still joins, 60:00.001 breaks
assert.deepEqual(shape([m("a", T0), m("a", T0 + TIME_GAP_MS)]), ["2D"]);
assert.deepEqual(shape([m("a", T0), m("a", T0 + TIME_GAP_MS + 1)]), ["1D", "1G"]);
// an unsent (redacted) message stands alone and breaks the run around it (Comms `joinable`)
assert.deepEqual(shape([m("a", T0), m("a", T0 + MIN, { redacted: true }), m("a", T0 + 2 * MIN)]), ["1D", "1", "1"]);
// the gap is measured from the PREVIOUS message, not the run's first
assert.deepEqual(shape([m("a", T0), m("a", T0 + 50 * MIN), m("a", T0 + 100 * MIN)]), ["3D"]);
// a new local day always starts a run (and is not also a "gap")
const nextDay = new Date(2026, 9, 7, 0, 5).getTime();
assert.deepEqual(shape([m("a", new Date(2026, 9, 6, 23, 58).getTime()), m("a", nextDay)]), ["1D", "1D"]);
// direction: an id shared by your message and theirs never forms one run
assert.deepEqual(shape([m("me", T0), m("me", T0 + MIN, { sender: { id: "me", name: "me", avatar: null, isSelf: false, isOmni: false } })]), ["1D", "1"]);
// system notices stand alone and break the run around them
assert.deepEqual(shape([m("a", T0), m("a", T0 + MIN, { system: { kind: "member", text: "joined" } }), m("a", T0 + 2 * MIN)]), ["1D", "1", "1"]);
// an older time after a newer one (clock skew) does not join
assert.deepEqual(shape([m("a", T0 + 5 * MIN), m("a", T0)]), ["1D", "1"]);
// runs keep the first id as a stable key and the isSelf flag
const runs = groupRuns([m("me", T0), m("me", T0 + MIN)]);
assert.equal(runs[0]!.key, runs[0]!.messages[0]!.id);
assert.equal(runs[0]!.isSelf, true);
assert.deepEqual(groupRuns([]), []);

// query strings
assert.equal(threadQueryString({}), "");
assert.equal(
  threadQueryString({ folder: "low", statuses: ["urgent", "social"], attention: true, networks: ["signal", "x"], unread: true, cursor: "abc", limit: 50 }),
  "?folder=low&status=urgent%2Csocial&attention=true&network=signal%2Cx&unread=true&cursor=abc&limit=50",
);
assert.equal(threadQueryString({ person: "p/1", note: "n 1" }), "?person=p%2F1&note=n+1");
assert.equal(threadQueryString({ q: "   " }), "");
assert.equal(threadQueryString({ q: ` ${"x".repeat(300)} ` }), `?q=${"x".repeat(200)}`);
assert.equal(threadQueryString({ statuses: [], networks: [], attention: false, unread: false }), "");

// fallback decision
for (const s of [401, 403, 404, 409]) assert.equal(commsUnavailable({ status: s }), true, String(s));
for (const s of [400, 429, 500, 502, 503]) assert.equal(commsUnavailable({ status: s }), false, String(s));
assert.equal(commsUnavailable(new TypeError("Failed to fetch")), false);
assert.equal(commsUnavailable(null), false);

// native media proxy: signed comms media paths only
const sig = "A".repeat(43);
const origin = "https://prism.example.test";
assert.equal(ownAttachmentPath(`/api/comms/media/eyJ2IjoxfQ.${sig}`, origin), `/api/comms/media/eyJ2IjoxfQ.${sig}`);
assert.equal(ownAttachmentPath(`${origin}/api/comms/media/eyJ2IjoxfQ.${sig}`, origin), `/api/comms/media/eyJ2IjoxfQ.${sig}`);
assert.equal(ownAttachmentPath(`https://elsewhere.test/api/comms/media/eyJ2IjoxfQ.${sig}`, origin), null);
assert.equal(ownAttachmentPath(`/api/comms/media/eyJ2IjoxfQ.${sig}?x=1`, origin), null);
assert.equal(ownAttachmentPath(`/api/comms/media/../admin.${sig}`, origin), null);
assert.equal(ownAttachmentPath(`/api/comms/threads`, origin), null);
assert.equal(ownAttachmentPath(`/api/comms/media/eyJ2IjoxfQ.short`, origin), null);
assert.equal(ownAttachmentPath(`/api/attachments/a_${"b".repeat(22)}`, origin), `/api/attachments/a_${"b".repeat(22)}`);

// native: a comms <img> goes through the server fetch (bearer), keeping the original in data-prism-src
{
  const win = new Window({ url: "tauri://localhost/" });
  const doc = win.document as unknown as Document;
  const fetched: string[] = [];
  const cache = new ImageBlobCache(async (u) => {
    fetched.push(u);
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), { status: 200, headers: { "content-type": "image/png" } });
  }, { createObjectURL: () => "blob:tauri://localhost/comms-1", revokeObjectURL: () => {} });
  const path = `/api/comms/media/eyJ2IjoxfQ.${sig}`;
  const img = doc.createElement("img");
  img.setAttribute("src", `${origin}${path}`);
  proxyImageElement(img as unknown as HTMLImageElement, cache, origin);
  assert.equal(img.getAttribute("data-prism-src"), `${origin}${path}`);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(fetched, [path], "fetched by its server path, with the shell's credential");
  assert.equal(img.getAttribute("src"), "blob:tauri://localhost/comms-1");
}

// which view: refusals → vault; no answer / 5xx → vault with the offline notice; 429 / 400 → Comms' own error
const p = (error: unknown, over = {}) => ({ isPending: false, isError: error !== undefined, error, ...over });
assert.equal(messagesSource(false, p(undefined)), "vault");
assert.equal(messagesSource(true, p(undefined, { isPending: true })), "pending");
assert.equal(messagesSource(true, p(undefined)), "comms");
for (const s of [401, 403, 404, 409]) assert.equal(messagesSource(true, p({ status: s })), "vault");
for (const e of [new TypeError("Failed to fetch"), { status: 500 }, { status: 503 }]) assert.equal(messagesSource(true, p(e)), "vault-offline");
for (const s of [400, 429]) assert.equal(messagesSource(true, p({ status: s })), "comms");
assert.equal(commsTransient({ status: 502 }), true);
assert.equal(commsTransient({ status: 429 }), false);

// poll backoff
assert.equal(backoff(15_000, 0), 15_000);
assert.equal(backoff(15_000, 1), 30_000);
assert.equal(backoff(15_000, 3), 120_000);
assert.equal(backoff(15_000, 10), 300_000);
assert.equal(backoff(false, 2), false);

console.log("verify:comms — grouping, query strings, fallback decision, media paths, native rewrite, view choice and poll backoff OK");
