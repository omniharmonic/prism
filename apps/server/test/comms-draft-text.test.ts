/**
 * The chat-draft character policy (comms/draft-text.ts; review rounds 1–3, controller rulings of
 * round 3). The SAME vectors are in the Swift twin's tests (CommsKit
 * Tests/CommsCoreTests/DraftTextTests.swift): keep them in step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftTextProblem, firstRefusedCodePoint, normalizeDraft, whitespaceProblem } from "../src/comms/draft-text";

const tags = (s: string) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");

export const ALLOWED: Array<[string, string]> = [
  ["plain", "Sure, Thursday works."],
  ["accents, lines", "Ça marche — à jeudi 15h\nÀ plus"],
  ["two blank lines", "a\n\n\nb"],
  ["leading indentation", "  indented"],
  ["family ZWJ (2 ZWJs)", "\u{1F468}‍\u{1F469}‍\u{1F467}"],
  ["heart VS16", "❤️"],
  ["thumbs skin tone", "\u{1F44D}\u{1F3FD}"],
  ["runner woman ZWJ VS16", "\u{1F3C3}‍♀️"],
  ["skin tone inside ZWJ", "\u{1F469}\u{1F3FD}‍\u{1F4BB}"],
  ["keycap", "1️⃣"],
  ["regional flag", "\u{1F1EB}\u{1F1F7}"],
  ["four ZWJs", "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}‍\u{1F476}"],
];
export const REFUSED: Array<[string, string]> = [
  // round 3 reviewer payloads
  ["flag smuggling 7 tags", "Go team \u{1F3F4}" + tags("PW=1234") + "\u{E007F}"],
  ["england flag (tags refused, period)", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
  ["stacked VS16", "\u{1F44D}️️"],
  ["VS15 then VS16", "\u{1F44D}︎️"],
  ["VS15", "☎︎"],
  ["VS16 after skin tone", "\u{1F44D}\u{1F3FD}️"],
  ["VS16 then skin tone", "\u{1F44D}️\u{1F3FD}"],
  ["ZWJ between © and ™", "©‍™"],
  ["ZWJ between regional indicators", "\u{1F1EB}‍\u{1F1F7}"],
  ["five ZWJs", "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}‍\u{1F476}‍\u{1F474}"],
  ["NBSP", "Sure, Thursday"],
  ["ideographic space", "Sure,　Thursday"],
  ["hair space", "a b"],
  ["narrow NBSP", "a b"],
  ["braille blank", "a⠀b"],
  ["object replacement", "a￼b"],
  ["skin tone alone", "a\u{1F3FD}"],
  ["skin tone on a non-base", "❤\u{1F3FD}"],
  // earlier rounds
  ["VS17 smuggling", "a\u{E0100}b"],
  ["VS1 on a letter", "a︀b"],
  ["ZWJ between letters", "a‍b"],
  ["VS16 on a letter", "a️b"],
  ["ZWNJ", "a‌b"],
  ["zero-width space", "Sure​"],
  ["bidi override", "pay ‮evil"],
  ["word joiner", "ok⁠"],
  ["soft hyphen", "­soft"],
  ["BOM", "﻿hi"],
  ["bare tags", "hi\u{E0041}\u{E0042}"],
  ["trailing ZWJ after emoji", "❤️‍"],
  ["Hangul filler", "aㅤb"],
  ["musical formatting", "a\u{1D173}b"],
  ["bell", "a\u0007b"],
  ["C1 control", "a\u0085b"],
  ["line separator", "a b"],
];
export const WHITESPACE_REFUSED: Array<[string, string]> = [
  ["tab", "Sure,\tThursday"],
  ["trailing spaces on a line", "Sure  \nThursday"],
  ["trailing space at end", "Sure "],
  ["CR", "Sure\r\nThursday"],
  ["three blank lines", "a\n\n\n\nb"],
  ["leading blank line", "\nSure"],
  ["trailing blank line", "Sure\n"],
  ["SNOW-style tail", "Sure, Thursday works." + " \t".repeat(50)],
];

test("allowed vectors pass", () => {
  for (const [name, s] of ALLOWED) {
    assert.equal(firstRefusedCodePoint(s), -1, name);
    assert.equal(draftTextProblem(s, 32_000), null, name);
  }
});
test("refused vectors are refused", () => {
  for (const [name, s] of REFUSED) assert.ok(firstRefusedCodePoint(s) >= 0, name);
});
test("whitespace shape is refused unless normalised", () => {
  for (const [name, s] of WHITESPACE_REFUSED) assert.ok(draftTextProblem(s, 32_000), name);
});
test("normalisation at propose: CR, trailing spaces, extra blank lines, edges", () => {
  assert.equal(normalizeDraft("\n\nSure  \r\nThursday \r\n\r\n\r\n\r\n\r\nworks.  \n\n"), "Sure\nThursday\n\n\nworks.");
  assert.equal(whitespaceProblem(normalizeDraft("a \n\n\n\n\nb\n")), null);
  assert.equal(normalizeDraft("Sure,\tThursday"), "Sure,\tThursday", "tabs are refused, not rewritten");
});
test("length and bytes", () => {
  assert.equal(draftTextProblem("x".repeat(4000), 32_000), null);
  assert.match(draftTextProblem("x".repeat(4001), 32_000)!, /at most 4000/);
  assert.equal(draftTextProblem("é".repeat(4000), 7_999), "too long to send");
  assert.equal(draftTextProblem("   ", 32_000), "required");
});
