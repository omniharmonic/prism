/**
 * Owner-only routes of the identity + linking layer, mounted on the admin
 * router (`/api/admin/people/*`, routes/admin.ts) so they inherit its gate:
 * SERVER OWNER by email (never a vault admin or a vault-role owner — these act
 * across the whole vault with the server's vault token) and the live-actions
 * CSRF guard on every mutation. All of them act on the owner's ACTIVE vault.
 *
 *   GET  /people/candidates?status=&reason=&relationship=&limit=&after=
 *   POST /people/candidates/:id/resolve  {personId, addIdentity?=true, applyToKey?=false}
 *   POST /people/candidates/:id/dismiss  {applyToKey?=false}
 *
 * Full reference: docs/roadmap/workspace-experience/BACKEND-STATUS-GRAPH.md.
 */
import type { Context, Hono } from "hono";
import { config } from "../config";
import { resolveActor, requestVia } from "../auth/actor";
import { vaultClient } from "../parachute";
import { recordAction } from "../actions/store";
import { getCandidate, isCandidateStatus, listCandidates, openCandidateCounts } from "../identity-store";
import { dismissCandidate, resolveCandidate, ReviewError, type ReviewVault } from "../identity-review";

type Via = ReturnType<typeof requestVia>;
export const originOf = (via: Via): "human" | "agent" => (via === "session" || via === "device" ? "human" : "agent");

/** The owner's active vault (the admin middleware already refused everyone else). */
export const ownerVaultId = (c: Context): string => {
  const a = resolveActor(c);
  return a.kind === "user" ? a.vaultId : "primary";
};

export async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const raw = await c.req.text().catch(() => "");
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const optBool = (v: unknown): boolean | undefined | null => (v === undefined ? undefined : typeof v === "boolean" ? v : null);

export function mountPeopleCandidates(admin: Hono): void {
  admin.get("/people/candidates", (c) => {
    const vaultId = ownerVaultId(c);
    const status = c.req.query("status") ?? "open";
    const limit = Number(c.req.query("limit") ?? 50);
    const after = c.req.query("after") ?? null;
    const reason = c.req.query("reason");
    const relationship = c.req.query("relationship");
    if (!isCandidateStatus(status) || !Number.isInteger(limit) || limit < 1 || limit > 200 || (after !== null && after.length > 96) || (reason ?? "").length > 64 || (relationship ?? "").length > 64)
      return c.json({ error: "bad_request" }, 400);
    c.header("Cache-Control", "private, no-store");
    return c.json({ ...listCandidates(vaultId, { status, limit, after, reason, relationship }), open: openCandidateCounts(vaultId) });
  });

  admin.post("/people/candidates/:id/resolve", async (c) => {
    const vaultId = ownerVaultId(c);
    const body = await jsonBody(c);
    const addIdentity = optBool(body?.addIdentity);
    const applyToKey = optBool(body?.applyToKey);
    if (!body || typeof body.personId !== "string" || !body.personId || body.personId.length > 2048 || addIdentity === null || applyToKey === null) return c.json({ error: "bad_request" }, 400);
    const cand = getCandidate(vaultId, c.req.param("id"));
    if (!cand) return c.json({ error: "not_found" }, 404);
    const via = requestVia(c);
    try {
      const outcome = await resolveCandidate(vaultClient(vaultId) as unknown as ReviewVault, vaultId, cand, body.personId, {
        by: config.ownerEmail,
        addIdentity: addIdentity ?? true,
        applyToKey: applyToKey ?? false,
        paceMs: 25,
      });
      recordAction({
        actorEmail: config.ownerEmail,
        via,
        origin: originOf(via),
        action: "admin.people-candidate-resolve",
        vaultId,
        // ids + hashes + counts only — never the key value or a name.
        target: { candidateId: cand.id, keyKind: cand.key.kind, keyHash: cand.key.hash.slice(0, 16), relationship: cand.relationship, ...outcome },
        status: outcome.errors || outcome.conflicts ? "failed" : "ok",
      });
      return c.json({ ok: true, ...outcome });
    } catch (e) {
      if (e instanceof ReviewError) return c.json({ error: e.code }, e.status as 404 | 409 | 503);
      return c.json({ error: "resolve_failed" }, 503);
    }
  });

  admin.post("/people/candidates/:id/dismiss", async (c) => {
    const vaultId = ownerVaultId(c);
    const body = await jsonBody(c);
    const applyToKey = optBool(body?.applyToKey);
    if (!body || applyToKey === null) return c.json({ error: "bad_request" }, 400);
    const cand = getCandidate(vaultId, c.req.param("id"));
    if (!cand) return c.json({ error: "not_found" }, 404);
    try {
      const dismissed = dismissCandidate(vaultId, cand, { by: config.ownerEmail, applyToKey: applyToKey ?? false });
      return c.json({ ok: true, dismissed });
    } catch (e) {
      if (e instanceof ReviewError) return c.json({ error: e.code }, e.status as 409);
      throw e;
    }
  });
}
