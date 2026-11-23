/**
 * hono ≥ 4.12.34: earlier versions split a preflight's
 * Access-Control-Request-Headers with a backtracking regex (a reachable ReDoS
 * on the public `/api/p/*` CORS route, which echoes the requested headers).
 * Pins the installed version and that a hostile header list is still answered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../src/app";

function installedHonoVersion(): string {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve("hono"));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string };
      if (json.name === "hono" && json.version) return json.version;
    }
    const up = dirname(dir);
    if (up === dir) throw new Error("hono package.json not found");
    dir = up;
  }
}

function atLeast(version: string, min: [number, number, number]): boolean {
  const parts = version.split(/[.-]/).slice(0, 3).map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    if (have !== min[i]) return have > min[i]!;
  }
  return true;
}

test("the installed hono is at least 4.12.34 (CORS ReDoS fix)", () => {
  const v = installedHonoVersion();
  assert.ok(atLeast(v, [4, 12, 34]), `hono ${v} < 4.12.34`);
});

test("a preflight with a pathological Access-Control-Request-Headers is answered", async () => {
  const app = createApp();
  const hostile = "a" + " ".repeat(20_000) + "\t,".repeat(2_000) + "b";
  const r = await app.request("/api/p/some-site/manifest", {
    method: "OPTIONS",
    headers: {
      Origin: "https://elsewhere.example",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": hostile,
    },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});
