/**
 * Prints approval-digest test vectors by running the SERVER's own functions
 * (apps/server/src/omni/approvals.ts: canonicalJson + approvalDigest). PrismKit's Swift
 * canonicaliser must reproduce every `canonical` string and `digest` byte for byte
 * (Tests/PrismModelsTests/Fixtures/approval-digest-vectors.json).
 *
 * Regenerate from the repo root (needs `npm install`; the in-memory DB keeps it off any
 * real database, and nothing here reads a secret or the network):
 *
 *   DB_PATH=:memory: npx tsx swift/PrismKit/Scripts/digest-vectors.ts \
 *     "$PWD/apps/server/src/omni/approvals.ts" \
 *     > swift/PrismKit/Tests/PrismModelsTests/Fixtures/approval-digest-vectors.json
 */
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("usage: digest-vectors.ts <absolute path to apps/server/src/omni/approvals.ts>");
const { canonicalJson, approvalDigest } = (await import(pathToFileURL(target).href)) as {
  canonicalJson: (v: unknown) => string;
  approvalDigest: (kind: string, payload: unknown) => string;
};

const cases: Array<{ name: string; kind: string; payload: unknown }> = [
  { name: "email-basic", kind: "email", payload: { to: ["kevin@example.com"], subject: "Buoy spec", body: "Hi Kevin,\n\nHere is the spec.\n\nBenjamin" } },
  { name: "email-keys-out-of-order", kind: "email", payload: { subject: "Buoy spec", body: "Hi Kevin,\n\nHere is the spec.\n\nBenjamin", to: ["kevin@example.com"] } },
  { name: "email-with-cc", kind: "email", payload: { to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], subject: "Two recipients", body: "x" } },
  { name: "email-recipient-order-matters", kind: "email", payload: { to: ["b@example.com", "a@example.com"], cc: ["c@example.com"], subject: "Two recipients", body: "x" } },
  { name: "email-reply", kind: "email-reply", payload: { noteId: "01JABCDEF0123456789", expectTo: ["dana@example.org"], body: "Friday works." } },
  { name: "message", kind: "message", payload: { roomId: "!abc123:example.org", body: "on my way" } },
  { name: "calendar-invite", kind: "calendar-invite", payload: { title: "Call Dana", start: "2026-10-09T15:00:00-06:00", end: "2026-10-09T15:30:00-06:00", attendees: ["dana@example.org"], location: "Zoom", description: "Agenda: buoy" } },
  { name: "tweet", kind: "tweet", payload: { text: "Shipping PrismKit." } },
  { name: "wallet-proposal", kind: "wallet-proposal", payload: { to: "0x0000000000000000000000000000000000000001", amount: "1.5", token: "USDC", chain: "base", purpose: "test vector" } },
  { name: "escapes-quotes-backslashes", kind: "email", payload: { to: ["a@example.com"], subject: 'He said "hi" \\ and left / done', body: "tab\there\r\nCRLF\bbackspace\fformfeed" } },
  { name: "control-characters", kind: "message", payload: { roomId: "!r:example.org", body: "nul\u0000 bell\u0007 esc\u001b unit\u001f del\u007f" } },
  { name: "unicode-raw", kind: "message", payload: { roomId: "!r:example.org", body: "café naïve — 日本語 🌊👩‍👩‍👧  line-sep  é vs é" } },
  { name: "html-like", kind: "email", payload: { to: ["a@example.com"], subject: "<b>&amp;</b>", body: "</script><!-- x -->" } },
  { name: "empty-strings-and-arrays", kind: "calendar-invite", payload: { title: "t", start: "s", end: "e", attendees: [] } },
  { name: "nested-and-mixed", kind: "x-future", payload: { z: null, a: true, m: false, list: [1, "two", [3, { b: 1, a: 2 }], {}], obj: { y: { b: [], a: {} }, x: "1" } } },
  { name: "numbers", kind: "x-future", payload: { ints: [0, 1, -1, 42, 9007199254740991, -9007199254740991, 1e21, 1e20, 123456789012345680000], floats: [0.1, 1.5, -2.25, 1e-7, 0.000001, 1.0e-6, 123456.789, 5e-324, 1.7976931348623157e308, 100, 1.0, 0.5e1, 3.14159] } },
  { name: "key-sort-utf16", kind: "x-future", payload: { b: 1, a: 2, B: 3, A: 4, "": 5, "10": 6, "9": 7, aa: 8, "a b": 9, "é": 10, "😀": 11, "￿": 12, "": 13, _: 14, "a.b": 15, "a-b": 16 } },
  { name: "key-needs-escaping", kind: "x-future", payload: { 'quote"key': 1, "back\\slash": 2, "new\nline": 3 } },
  { name: "empty-payload", kind: "x-future", payload: {} },
  { name: "long-body", kind: "email", payload: { to: ["a@example.com"], subject: "long", body: "0123456789 ".repeat(500) } },
];

const out = cases.map((c) => ({
  name: c.name,
  kind: c.kind,
  payload: c.payload,
  canonical: canonicalJson({ kind: c.kind, payload: c.payload }),
  digest: approvalDigest(c.kind, c.payload),
}));
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
