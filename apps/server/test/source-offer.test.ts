/**
 * AGPL-3.0 §13: a server offers its source to everyone who uses it over the network.
 * /api/version answers anyone with the licence and the source URL (PRISM_SOURCE_URL, else
 * the public repository); only an https URL without credentials is ever handed out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app";
import { DEFAULT_SOURCE_URL, sourceUrlFrom } from "../src/config";

test("source offer: /api/version names the licence and the source, signed out", async () => {
  const r = await createApp().request("/api/version");
  assert.equal(r.status, 200);
  const body = (await r.json()) as { license: string; source: string; version: string };
  assert.equal(body.license, "AGPL-3.0-only");
  assert.match(body.source, /^https:\/\//);
  assert.ok(body.version);
});

test("source offer: PRISM_SOURCE_URL must be a plain https URL", () => {
  assert.equal(sourceUrlFrom(undefined), DEFAULT_SOURCE_URL);
  assert.equal(sourceUrlFrom(""), DEFAULT_SOURCE_URL);
  assert.equal(sourceUrlFrom("https://git.example.org/me/prism/"), "https://git.example.org/me/prism");
  for (const bad of ["http://git.example.org/x", "javascript:alert(1)", "/relative", "https://u:p@git.example.org/x", "not a url"]) {
    assert.equal(sourceUrlFrom(bad), DEFAULT_SOURCE_URL, bad);
  }
});
