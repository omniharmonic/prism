/**
 * Nightly history compaction (worker/history-compact.ts): per-vault admin mint,
 * short slices looped until remaining_candidates hits 0, 0.6.x vaults (404/405)
 * skipped quietly, dedupe of registry entries sharing one vault, and failures
 * isolated per vault. fetch + minter + registry are injected.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runHistoryCompactOnce, resetCompactState } from "../src/worker/history-compact";
import type { VaultEntry } from "../src/config";

const entry = (id: string, vault: string, url = "http://vault.test"): VaultEntry => ({ id, label: id, url, vault, token: "w" });

beforeEach(() => resetCompactState());

interface Call {
  url: string;
  auth: string | null;
  body: any;
}

function fakeFetch(handler: (url: string, n: number) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    return handler(url, calls.filter((c) => c.url === url).length);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

test("slices until remaining_candidates is 0, with an admin token and small bounds", async () => {
  const minted: string[] = [];
  const { fetchImpl, calls } = fakeFetch((_u, n) =>
    json({ notes_compacted: 2, bytes_before: 100, bytes_after: 10, remaining_candidates: n < 3 ? 5 : 0, stopped_by: n < 3 ? "budget" : "complete" }),
  );
  const s = (await runHistoryCompactOnce({
    fetchImpl,
    mintAdmin: async (v) => {
      minted.push(v);
      return `admin-${v}`;
    },
    registry: () => [entry("primary", "default")],
    pauseMs: 0,
  }))[0]!;
  assert.deepEqual(minted, ["default"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url, "http://vault.test/vault/default/api/history/compact");
  assert.equal(calls[0]!.auth, "Bearer admin-default");
  assert.ok(calls[0]!.body.budget_ms <= 1000 && calls[0]!.body.max_notes <= 50, "slices stay short");
  assert.equal(s.status, "compacted");
  assert.equal(s.result!.notes_compacted, 6);
  assert.equal(s.result!.remaining_candidates, 0);
  assert.equal(s.result!.slices, 3);
});

test("a 0.6.x vault (404) is reported unsupported, not failed", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("not found", { status: 404 }));
  const s = (await runHistoryCompactOnce({ fetchImpl, mintAdmin: async () => "a", registry: () => [entry("p", "default")], pauseMs: 0 }))[0]!;
  assert.equal(s.status, "unsupported");
});

test("dedupes registry ids that point at the same vault; isolates per-vault failures", async () => {
  const { fetchImpl, calls } = fakeFetch((url) =>
    url.includes("/vault/broken/") ? json({ error_type: "compaction_failed" }, 500) : json({ remaining_candidates: 0 }),
  );
  const out = await runHistoryCompactOnce({
    fetchImpl,
    mintAdmin: async () => "a",
    registry: () => [entry("primary", "default"), entry("alias", "default"), entry("b", "broken"), entry("c", "commons")],
    pauseMs: 0,
  });
  assert.deepEqual(
    out.map((s) => [s.vault, s.status]),
    [
      ["default", "compacted"],
      ["broken", "failed"],
      ["commons", "compacted"],
    ],
  );
  assert.equal(calls.filter((c) => c.url.includes("/vault/default/")).length, 1);
});

test("a mint failure skips that vault without calling it", async () => {
  const { fetchImpl, calls } = fakeFetch(() => json({ remaining_candidates: 0 }));
  const s = (await runHistoryCompactOnce({
    fetchImpl,
    mintAdmin: async () => {
      throw new Error("parachute CLI not found");
    },
    registry: () => [entry("p", "default")],
    pauseMs: 0,
  }))[0]!;
  assert.equal(s.status, "skipped");
  assert.equal(calls.length, 0);
});

test("slice cap bounds a run that never finishes", async () => {
  const { fetchImpl, calls } = fakeFetch(() => json({ remaining_candidates: 99 }));
  const s = (await runHistoryCompactOnce({ fetchImpl, mintAdmin: async () => "a", registry: () => [entry("p", "default")], pauseMs: 0, maxSlices: 4 }))[0]!;
  assert.equal(calls.length, 4);
  assert.equal(s.status, "compacted");
  assert.equal(s.result!.remaining_candidates, 99);
});
