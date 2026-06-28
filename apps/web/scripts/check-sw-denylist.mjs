#!/usr/bin/env node
/**
 * check:sw — guard against the service-worker shadowing footgun.
 *
 * The PWA service worker uses `navigateFallback: index.html`, which makes the SPA
 * shell answer ANY navigation that isn't excluded by `navigateFallbackDenylist`.
 * A server-owned route (auth callback, gateway, public publication JSON) that is
 * NOT denylisted will be silently shadowed by the SPA — and ONLY in the browser
 * (curl still hits the server), which makes it a nightmare to debug.
 *
 * This check parses apps/web/vite.config.ts (no eval, just regex) and asserts:
 *   1. every server-owned route prefix below is present in navigateFallbackDenylist;
 *   2. the public publication DATA path lives under /api (so it's covered by the
 *      /api denylist entry — the human /p/:slug URL is intentionally a CLIENT route).
 *
 * Dependency-free (node:fs + regex). Exits non-zero with a clear message on a miss.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VITE_CONFIG = resolve(__dirname, "../vite.config.ts");

/** Route prefixes the SERVER owns. Each must be in navigateFallbackDenylist or
 *  it will be shadowed by the SPA shell in the browser. Keep in sync with the
 *  server mounts in apps/server/src/app.ts (`app.route("/auth"...)`, etc.). */
const SERVER_ROUTE_PREFIXES = ["/auth", "/api"];

/** The public publication JSON path. It must live under one of the denylisted
 *  prefixes (it's /api/p/*), NOT be its own un-denylisted prefix like /p. */
const PUBLICATION_DATA_PATH = "/api/p";

function fail(msg) {
  console.error(`✗ check:sw — ${msg}`);
  process.exit(1);
}

let src;
try {
  src = readFileSync(VITE_CONFIG, "utf8");
} catch (e) {
  fail(`cannot read ${VITE_CONFIG}: ${e.message}`);
}

// Pull the navigateFallbackDenylist array literal out of the config text.
const m = src.match(/navigateFallbackDenylist\s*:\s*\[([^\]]*)\]/);
if (!m) {
  fail(
    "no `navigateFallbackDenylist: [...]` found in vite.config.ts — without it " +
      "every server route is shadowed by the SPA shell in the browser.",
  );
}
const denylistBody = m[1];

/** Does the denylist cover navigations to `prefix`? Each entry is a RegExp
 *  literal anchored at the start, e.g. `/^\/auth\//`. We normalize escaped
 *  slashes in the denylist text and check for a start-anchored entry on the
 *  prefix's first path segment — so `^\/api\/` covers `/api` AND `/api/p`. */
function covered(prefix) {
  const seg = prefix.replace(/^\//, "").split("/")[0]; // "auth" from "/auth"
  const normalized = denylistBody.replace(/\\\//g, "/"); // \/  →  /
  return normalized.includes(`^/${seg}`);
}

const missing = SERVER_ROUTE_PREFIXES.filter((p) => !covered(p));
if (missing.length > 0) {
  fail(
    `server route prefix(es) ${missing.join(", ")} are NOT in navigateFallbackDenylist ` +
      `(found: ${denylistBody.trim() || "<empty>"}). Add a RegExp like /^\\/${missing[0]
        .replace(/^\//, "")
        .split("/")[0]}\\// or those routes break only in the browser.`,
  );
}

// The publication data path must fall under a denylisted prefix.
if (!covered(PUBLICATION_DATA_PATH)) {
  fail(
    `publication data path ${PUBLICATION_DATA_PATH} is not covered by the denylist — ` +
      `it must stay under /api (the human /p/:slug URL is the SPA client route).`,
  );
}

console.log(
  `✓ check:sw — navigateFallbackDenylist covers ${SERVER_ROUTE_PREFIXES.join(", ")} ` +
    `(and ${PUBLICATION_DATA_PATH} is under /api).`,
);
