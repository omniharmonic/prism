/**
 * Registry token-expiry visibility (auth/vault-token.ts tokenExpiries +
 * /acl/server `tokens`): status per token from its peeked `exp`, and the
 * endpoint exposes dates/status only — never token material.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tokenExpiries } from "../src/auth/vault-token";
import { acl } from "../src/routes/acl";
import { config } from "../src/config";
import { addVaultEntry } from "../src/db";
import { resetDb, makeSession, sessionCookie } from "./helpers";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30);
function jwt(expMs: number | null): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(expMs === null ? { sub: "x" } : { exp: Math.floor(expMs / 1000) })}.sig`;
}

test("classifies ok / expiring / expired / unknown", () => {
  const out = tokenExpiries(
    [
      { id: "a", vault: "va", token: jwt(NOW + 200 * DAY) },
      { id: "b", vault: "vb", token: jwt(NOW + 11 * DAY) },
      { id: "c", vault: "vc", token: jwt(NOW - 4 * DAY) },
      { id: "d", vault: "vd", token: jwt(null) },
      { id: "e", vault: "ve", token: "pvt_opaque" },
    ],
    NOW,
  );
  assert.deepEqual(
    out.map((t) => [t.id, t.status]),
    [
      ["a", "ok"],
      ["b", "expiring"],
      ["c", "expired"],
      ["d", "unknown"],
      ["e", "unknown"],
    ],
  );
  assert.equal(out[1]!.daysLeft, 11);
  assert.equal(out[2]!.expiresAt, new Date(NOW - 4 * DAY).toISOString());
});

beforeEach(() => resetDb());

test("GET /acl/server lists token expiry without leaking the token", async () => {
  const token = jwt(Date.now() - DAY);
  addVaultEntry({ id: "commons", label: "Commons", url: "http://vault.test", vault: "front-range-commons", token });
  const r = await acl.request("/server", { headers: { cookie: sessionCookie(makeSession(config.ownerEmail)) } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { tokens: Array<{ id: string; status: string }> };
  const commons = body.tokens.find((t) => t.id === "commons");
  assert.equal(commons?.status, "expired");
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(token) && !serialized.includes(token.split(".")[1]!), "no token material");
  assert.ok(!serialized.includes(config.parachuteToken), "primary token not leaked");
});
