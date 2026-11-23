/**
 * The browser-editable .env writer (security review C1/H1). Pure — never touches
 * a real .env. Every injection vector must be refused before a write, and every
 * accepted write must parse (node's own dotenv parser) to exactly the intended keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv } from "node:util";
import { EDITABLE_ENV, applyEnvEdit, isSafeEnvValue, validateEnvEdit } from "../src/env-edit";

const BASE = "OWNER_EMAIL=owner@example.test\nSESSION_SECRET=abc\nMAGIC_FROM=Prism <login@example.test>\nRESEND_API_KEY=re_real\n";

test("only MAGIC_FROM is browser-editable (APP_ORIGIN / RESEND_API_KEY are host-only)", () => {
  assert.deepEqual(Object.keys(EDITABLE_ENV), ["MAGIC_FROM"]);
  for (const k of ["APP_ORIGIN", "RESEND_API_KEY", "OWNER_EMAIL", "__proto__", "constructor", "hasOwnProperty"]) {
    assert.deepEqual(validateEnvEdit(k, "Prism <a@b.co>"), { ok: false, error: "not_editable" }, k);
  }
});

const INJECTIONS = [
  "a@b.co\nOWNER_EMAIL=attacker@evil.test",
  "a@b.co\r\nOWNER_EMAIL=attacker@evil.test",
  "a@b.co\rRESEND_API_KEY=re_x",
  "a@b.co\u0000",
  "Prism <a@b.co>\u2028OWNER_EMAIL=x@y.zz",
  "Prism <a@b.co>\tx",
  "\nOWNER_EMAIL=attacker@evil.test",
  " Prism <a@b.co>",
  "$& <a@b.co>",
  "$' <a@b.co>",
  "a$&@b.co",
  "\"Prism\" <a@b.co>",
  "Prism <a@b.co> # comment",
  "Prism <a@b.co",
  "Prism a@b.co>",
  "Prism <a@b>",
  "",
  "x".repeat(300) + "@b.co",
];

for (const key of Object.keys(EDITABLE_ENV)) {
  test(`${key}: newline / CR / NUL / control / $-pattern / quote injection is refused, and applyEnvEdit throws on it`, () => {
    for (const v of INJECTIONS) {
      assert.equal(validateEnvEdit(key, v).ok, false, JSON.stringify(v));
      assert.throws(() => applyEnvEdit(BASE, key, v), JSON.stringify(v));
    }
  });
}

test("isSafeEnvValue is the central guard (any key)", () => {
  for (const v of ["a\nb", "a\rb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2029b", " a", "a ", "", 5, null]) assert.equal(isSafeEnvValue(v), false, JSON.stringify(v));
  assert.equal(isSafeEnvValue("Prism <a@b.co>"), true);
});

test("accepted MAGIC_FROM forms write exactly one line and parse to exactly the intended keys", () => {
  for (const v of ["login@example.test", "Prism <login@example.test>", "Prism Notes-2.0 <no.reply+x@mail.example.co>"]) {
    const next = applyEnvEdit(BASE, "MAGIC_FROM", v);
    const parsed = parseEnv(next);
    assert.deepEqual(Object.keys(parsed).sort(), ["MAGIC_FROM", "OWNER_EMAIL", "RESEND_API_KEY", "SESSION_SECRET"]);
    assert.equal(parsed.MAGIC_FROM, v);
    assert.equal(parsed.OWNER_EMAIL, "owner@example.test");
    assert.equal(parsed.RESEND_API_KEY, "re_real");
    assert.equal(next.split("\n").length, BASE.split("\n").length, "no line added");
  }
});

test("append when absent; every duplicate line is replaced (a later duplicate can't win)", () => {
  const appended = applyEnvEdit("OWNER_EMAIL=o@x.co", "MAGIC_FROM", "a@b.co");
  assert.equal(appended, "OWNER_EMAIL=o@x.co\nMAGIC_FROM=a@b.co\n");
  const dup = applyEnvEdit("MAGIC_FROM=old@x.co\nOWNER_EMAIL=o@x.co\nMAGIC_FROM=evil@x.co\n", "MAGIC_FROM", "new@x.co");
  assert.deepEqual(parseEnv(dup), { MAGIC_FROM: "new@x.co", OWNER_EMAIL: "o@x.co" });
  assert.ok(!dup.includes("evil@x.co"));
});

test("replacement is literal: $-patterns already in the file are untouched and never expanded", () => {
  // Even if a future validator allowed '$', the function replacer keeps it literal.
  const raw = "PREFIX=keep$&\nMAGIC_FROM=old@x.co\nSUFFIX=tail\n";
  const next = applyEnvEdit(raw, "MAGIC_FROM", "new@x.co");
  assert.equal(next, "PREFIX=keep$&\nMAGIC_FROM=new@x.co\nSUFFIX=tail\n");
});
