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
 *   POST /people/link         {dryRun?=true, phases?, maxWrites?, enqueue?, useMatrixMembers?=false} → 202 {job}
 *   GET  /people/link                                                                     → {job | null}
 *   POST /people/link/cancel                                                              → {ok}
 *   GET  /people/duplicates?strength=&limit=&offset=                                      → {pairs, total, counts, next}
 *   POST /people/merge        {personIds: [a, b], canonicalId?, dryRun?=true}             → {merge}
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
import { getSecret } from "../secrets";
import { MatrixClient, type MatrixCreds } from "../worker/matrix";
import { PHASES, cancelLinkJob, isPhase, linkJobRunning, linkJobStatus, LinkJobBusyError, startLinkJob, type LinkJob, type LinkJobVault } from "../people-link-job";
import { chooseCanonical, detectDuplicates, mergePeople, mergeRunning, MergeError, type MergeVault } from "../people-merge";
import { PERSON_IDENTITY_KEYS } from "../people-metadata";

/** OWNER_EMAIL + PEOPLE_OWNER_EMAILS / _PERSON / _ALIASES — who "me" is. */
export const ownerConfig = (matrixId?: string | null) => ({
  emails: [config.ownerEmail, ...config.peopleOwnerEmails].filter(Boolean),
  person: config.peopleOwnerPerson,
  aliases: config.peopleOwnerAliases,
  matrixId: matrixId ?? null,
});

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

export function mountPeopleLinkJob(admin: Hono): void {
  admin.get("/people/link", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ job: linkJobStatus(), phases: PHASES });
  });

  admin.post("/people/link", async (c) => {
    const vaultId = ownerVaultId(c);
    const body = await jsonBody(c);
    const dryRunIn = optBool(body?.dryRun);
    const enqueue = optBool(body?.enqueue);
    const useMembers = optBool(body?.useMatrixMembers);
    if (!body || dryRunIn === null || enqueue === null || useMembers === null) return c.json({ error: "bad_request", detail: "dryRun, enqueue and useMatrixMembers must be true or false" }, 400);
    const phases = body.phases;
    if (phases !== undefined && (!Array.isArray(phases) || !phases.length || !phases.every(isPhase))) return c.json({ error: "bad_request", detail: `phases must be a non-empty list of: ${PHASES.join(", ")}` }, 400);
    const dryRun = dryRunIn !== false; // a dry run unless explicitly false
    const ceiling = Math.max(0, config.peopleLinkMaxWritesCeiling);
    let maxWrites = dryRun ? 0 : Math.max(0, config.peopleLinkMaxWrites);
    if (body.maxWrites !== undefined) {
      const m = body.maxWrites;
      if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || (ceiling && m > ceiling)) return c.json({ error: "bad_request", detail: `maxWrites must be an integer from 1 to ${ceiling}` }, 400);
      maxWrites = m;
    }
    if (!dryRun && !maxWrites) maxWrites = ceiling; // a write run is never uncapped

    // The Matrix membership lookup is opt-in per run (it talks to the homeserver).
    let members: ((roomId: string) => Promise<Record<string, string> | null>) | undefined;
    let self: string | null = null;
    if (useMembers) {
      const raw = getSecret(vaultId, config.ownerEmail, "matrix");
      if (!raw) return c.json({ error: "matrix_not_configured" }, 409);
      const client = new MatrixClient(JSON.parse(raw) as MatrixCreds);
      self = await client.whoami().catch(() => null);
      members = (roomId) => client.joinedMembers(roomId).catch(() => null);
    }
    const via = requestVia(c);
    const onEnd = dryRun
      ? undefined
      : (j: LinkJob) =>
          recordAction({
            actorEmail: config.ownerEmail,
            via,
            origin: originOf(via),
            action: "admin.people-link",
            vaultId,
            // Counts only — no note ids, paths, names or addresses.
            target: {
              jobId: j.id,
              status: j.status,
              phases: j.phases,
              writes: j.writes,
              capped: j.capped,
              queuedNew: j.queuedNew,
              ...Object.fromEntries(
                j.phases.map((p) => [p, { linked: j.report[p].linked, unlinked: j.report[p].unlinked, conflicts: j.report[p].conflicts, errors: j.report[p].errors, oversize: j.report[p].oversize, deferred: j.report[p].deferred }]),
              ),
            },
            status: j.status === "done" ? "ok" : "failed",
            error: j.error,
          });
    if (mergeRunning()) return c.json({ error: "busy", detail: "a people merge is in progress" }, 409);
    try {
      const { job } = startLinkJob(vaultClient(vaultId) as unknown as LinkJobVault, vaultId, {
        dryRun,
        phases: phases as LinkJob["phases"] | undefined,
        maxWrites,
        enqueue: enqueue ?? !dryRun,
        paceMs: config.peopleLinkPaceMs,
        owner: ownerConfig(self),
        members,
        limits: {
          groupNameMax: config.peopleLinkGroupNameMax,
          groupMaxMembers: config.peopleLinkGroupMaxMembers,
          groupLinkCap: config.peopleLinkGroupLinkCap,
          maxRecipients: config.peopleLinkMaxRecipients,
          memberLookups: config.peopleLinkMemberLookups,
          memberPaceMs: config.peopleLinkMemberPaceMs,
        },
        onEnd,
      });
      console.log(`[admin] people link started (${dryRun ? "dry run" : `WRITE, max ${maxWrites} writes`}) on vault ${vaultId}: ${job.phases.join(",")}`);
      return c.json({ job }, 202);
    } catch (e) {
      if (e instanceof LinkJobBusyError) return c.json({ error: "busy", detail: e.message, job: linkJobStatus() }, 409);
      throw e;
    }
  });

  admin.post("/people/link/cancel", (c) => c.json({ ok: cancelLinkJob() }));
}

export function mountPeopleMerge(admin: Hono): void {
  admin.get("/people/duplicates", async (c) => {
    const vaultId = ownerVaultId(c);
    const strength = c.req.query("strength");
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    if ((strength !== undefined && !["strong", "medium", "weak"].includes(strength)) || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0)
      return c.json({ error: "bad_request" }, 400);
    try {
      // Lean: identity keys + links only — never a note body.
      const people = await vaultClient(vaultId).listNotes({ tags: ["person"], includeLinks: true, includeMetadata: PERSON_IDENTITY_KEYS });
      if (people.length >= 50_000) return c.json({ error: "people_inventory_limit" }, 503);
      const all = detectDuplicates(people);
      const counts = { strong: 0, medium: 0, weak: 0 };
      for (const p of all) counts[p.strength]++;
      const filtered = strength ? all.filter((p) => p.strength === strength) : all;
      const pairs = filtered.slice(offset, offset + limit);
      c.header("Cache-Control", "private, no-store");
      return c.json({ pairs, total: filtered.length, counts, next: offset + limit < filtered.length ? offset + limit : null });
    } catch {
      return c.json({ error: "people_unavailable" }, 503);
    }
  });

  admin.post("/people/merge", async (c) => {
    const vaultId = ownerVaultId(c);
    const body = await jsonBody(c);
    const dryRunIn = optBool(body?.dryRun);
    const ids = body?.personIds;
    if (!body || dryRunIn === null || !Array.isArray(ids) || ids.length !== 2 || !ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 2048) || ids[0] === ids[1])
      return c.json({ error: "bad_request", detail: "personIds must be two different person note ids" }, 400);
    const [a, b] = ids as [string, string];
    if (body.canonicalId !== undefined && body.canonicalId !== a && body.canonicalId !== b) return c.json({ error: "bad_request", detail: "canonicalId must be one of personIds" }, 400);
    if (linkJobRunning()) return c.json({ error: "busy", detail: "a people-link job is running" }, 409);
    const dryRun = dryRunIn !== false; // a dry run unless explicitly false
    const vault = vaultClient(vaultId) as unknown as MergeVault;
    const via = requestVia(c);
    try {
      let canonicalId = body.canonicalId as string | undefined;
      if (!canonicalId) {
        const [na, nb] = await Promise.all([vault.getNote(a, { includeLinks: true }), vault.getNote(b, { includeLinks: true })]);
        canonicalId = chooseCanonical(na, nb).id;
      }
      const secondaryId = canonicalId === a ? b : a;
      const merge = await mergePeople(vault, { canonicalId, secondaryId, dryRun, by: config.ownerEmail });
      if (!dryRun)
        recordAction({
          actorEmail: config.ownerEmail,
          via,
          origin: originOf(via),
          action: "admin.people-merge",
          vaultId,
          target: { ...merge }, // note ids + counts + evidence kinds — no names, addresses or bodies
          status: merge.complete ? "ok" : "failed",
        });
      return c.json({ merge });
    } catch (e) {
      if (e instanceof MergeError) return c.json({ error: e.code }, e.status as 400 | 404 | 409 | 503);
      if ((e as { status?: number })?.status === 404) return c.json({ error: "not_found" }, 404);
      return c.json({ error: "merge_failed" }, 503);
    }
  });
}
