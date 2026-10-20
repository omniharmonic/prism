/**
 * Server-side vault client error mapping — the optimistic-concurrency envelope
 * (Phase 0.3). The vault enforces `if_updated_at`/`force` on mutating writes and
 * answers 428 (no precondition) or 409 (stale precondition); we surface those as
 * a typed VaultConflictError carrying the current state, so the gateway can hand
 * the client a real conflict to rebase rather than a generic 502. Offline —
 * `fetch` is stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { vault, VaultConflictError, VaultError } from "../src/parachute";

/** Run `fn` with `globalThis.fetch` stubbed, always restoring the real one. */
function withFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

test("updateNote: a 409 surfaces as VaultConflictError carrying the current state", async () => {
  await withFetch(
    (async () =>
      new Response(JSON.stringify({ error: "conflict", updatedAt: "2026-06-30T00:00:00Z" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    async () => {
      await assert.rejects(
        vault.updateNote("n1", { content: "x", ifUpdatedAt: "2026-06-29T00:00:00Z" }),
        (e: unknown) => {
          assert.ok(e instanceof VaultConflictError, "is a VaultConflictError");
          assert.equal((e as VaultConflictError).status, 409);
          assert.deepEqual((e as VaultConflictError).body, {
            error: "conflict",
            updatedAt: "2026-06-30T00:00:00Z",
          });
          return true;
        },
      );
    },
  );
});

test("a 428 (missing precondition) is also a VaultConflictError, body kept as text", async () => {
  await withFetch(
    (async () => new Response("precondition required", { status: 428 })) as typeof fetch,
    async () => {
      await assert.rejects(
        vault.updateNote("n1", { content: "x" }),
        (e: unknown) =>
          e instanceof VaultConflictError &&
          (e as VaultConflictError).status === 428 &&
          (e as VaultConflictError).body === "precondition required",
      );
    },
  );
});

test("a non-conflict error stays a plain VaultError (not collapsed to a conflict)", async () => {
  await withFetch(
    (async () => new Response("boom", { status: 500 })) as typeof fetch,
    async () => {
      await assert.rejects(
        vault.getNote("n1"),
        (e: unknown) =>
          e instanceof VaultError && !(e instanceof VaultConflictError) && (e as VaultError).status === 500,
      );
    },
  );
});
