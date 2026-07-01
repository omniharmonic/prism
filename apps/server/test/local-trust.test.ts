/**
 * The local-owner trust gate (P5.2). isLocalRequest may only ever return true
 * when config.trustLocal is on — so a raw exposed port (no proxy, no forwarding
 * header) can NOT be tricked into treating external traffic as the desktop owner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalRequest } from "../src/auth/local";
import { config } from "../src/config";

const noHeaders = () => null;
const withCf = (k: string) => (k === "cf-connecting-ip" ? "1.2.3.4" : null);

test("trustLocal ON: a headerless (loopback) request is local; a forwarded one is not", () => {
  (config as { trustLocal: boolean }).trustLocal = true;
  assert.equal(isLocalRequest(noHeaders), true);
  assert.equal(isLocalRequest(withCf), false, "a forwarding header → came via the proxy, not loopback");
});

test("trustLocal OFF: ALWAYS false — fail closed (the raw-port trust hole is shut)", () => {
  (config as { trustLocal: boolean }).trustLocal = false;
  assert.equal(isLocalRequest(noHeaders), false, "headerless external traffic is NOT trusted as owner");
  assert.equal(isLocalRequest(withCf), false);
  (config as { trustLocal: boolean }).trustLocal = true; // restore for any later tests in-file
});
