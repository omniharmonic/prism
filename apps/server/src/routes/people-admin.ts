/**
 * Owner-only routes of the identity + linking layer, mounted on the admin
 * router (`/api/admin/people/*`, routes/admin.ts) so they inherit its gate:
 * SERVER OWNER by email (never a vault admin or a vault-role owner — these act
 * across the whole vault with the server's vault token) and the live-actions
 * CSRF guard on every mutation. All of them act on the owner's ACTIVE vault.
 *
 *   GET  /people/candidates?status=&reason=&relationship=&limit=&after=
 *   POST /people/candidates/:id/resolve  {personId, addIdentity?=false, applyToKey?=false}
 *   POST /people/candidates/:id/dismiss  {applyToKey?=false}
 *   GET|PUT|DELETE /people/owner         {person, emails?, aliases?}
 *   POST /people/link         {dryRun?=true, phases?, maxWrites?, enqueue?=false, allowNameLinks?=false, excludeBulkLinks?=false, useMatrixMembers?} → 202 {job}
 *   GET  /people/link                                                                     → {job | null}
 *   POST /people/link/cancel                                                              → {ok}
 *   GET  /people/duplicates?strength=&limit=&offset=                                      → {pairs, total, counts, next}
 *   POST /people/merge        {personIds: [a, b], canonicalId, expect, confirmUnrelated?, dryRun?=true} → {merge}
 *
 * The job, a merge and a resolve / dismiss are mutually exclusive (409 `busy`).
 *
 * Full reference: docs/roadmap/workspace-experience/BACKEND-STATUS-GRAPH.md.
 */
import type { Context, Hono } from "hono";
import { config } from "../config";
import { resolveActor, requestVia } from "../auth/actor";
import { vaultClient, type Note } from "../parachute";
import { recordAction } from "../actions/store";
import { actionOrigin } from "./actions";
import { getCandidate, isCandidateStatus, listCandidates, openCandidateCounts } from "../identity-store";
import { dismissCandidate, resolveCandidate, ReviewError, type ReviewVault } from "../identity-review";
import { getSecret } from "../secrets";
import { MatrixClient, type MatrixCreds } from "../worker/matrix";
import { PHASES, cancelLinkJob, isPhase, linkJobStatus, LinkJobBusyError, startLinkJob, type LinkJob, type LinkJobVault } from "../people-link-job";
import { detectDuplicates, mergePeople, mergedByThisModule, MergeError, type DuplicatePair, type MergeVault } from "../people-merge";
import { PERSON_IDENTITY_KEYS } from "../people-metadata";
import { cachedDerived, cachedPeople, invalidatePeople } from "../people-cache";
import { peopleLockHolder } from "../people-lock";
import { ownerConfigFor, ownerSettings, saveOwnerSettings } from "../people-owner";
import { IdentityIndex, isNonHumanPerson, isTombstone, looksLikeEmail, ownerProfile } from "../identity";
import { docNameFor, isDocLive, markReconciled } from "../collab";

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

/** A vault client whose every call is abandoned after PEOPLE_VAULT_TIMEOUT_MS. */
const vaultFor = (vaultId: string) => vaultClient(vaultId, { timeoutMs: config.peopleVaultTimeoutMs });

/** The lean person listing (identity keys + links, never content), shared + cached 60 s. */
const loadPeople = (vaultId: string) => (): Promise<Note[]> => vaultFor(vaultId).listNotes({ tags: ["person"], includeLinks: true, includeMetadata: PERSON_IDENTITY_KEYS });
const people = (vaultId: string, fresh = false): Promise<Note[]> => cachedPeople(vaultId, loadPeople(vaultId), { fresh });

/** collab.ts, read-only: is a note open in the editor, and "its content did not change". */
const liveHooks = (vaultId: string) => ({
  isLive: (noteId: string) => isDocLive(vaultId, noteId),
  markReconciled: (noteId: string, prevMs: number, nextMs: number) => void markReconciled(docNameFor(vaultId, noteId), prevMs, nextMs),
});

/** Give up on a homeserver call after `ms` (the Matrix client has no read timeout of its own). */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms) return p;
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("matrix call timed out")), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const busy = (c: Context) => c.json({ error: "busy", detail: `another people operation is in progress (${peopleLockHolder() ?? "unknown"})` }, 409);

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
    if (peopleLockHolder()) return busy(c);
    const via = requestVia(c);
    try {
      const outcome = await resolveCandidate(vaultFor(vaultId) as unknown as ReviewVault, vaultId, cand, body.personId, {
        by: config.ownerEmail,
        addIdentity: addIdentity === true, // off unless explicitly asked
        applyToKey: applyToKey ?? false,
        paceMs: 25,
        people: () => people(vaultId),
        live: liveHooks(vaultId),
        onWrite: () => invalidatePeople(vaultId),
      });
      recordAction({
        actorEmail: config.ownerEmail,
        via,
        origin: originOf(via),
        action: "admin.people-candidate-resolve",
        vaultId,
        // ids + hashes + counts only — never the key value or a name.
        target: { candidateId: cand.id, keyKind: cand.key.kind, keyHash: cand.key.hash.slice(0, 16), relationship: cand.relationship, ...outcome },
        status: outcome.errors || outcome.conflicts || outcome.noStamp ? "failed" : "ok",
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

/** The owner's identity for the matcher: stored settings, else PEOPLE_OWNER_*. */
export const ownerConfig = (vaultId: string, matrixId?: string | null) => ownerConfigFor(vaultId, { matrixId });

const strList = (v: unknown, max: number): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= 320) ? (v as string[]).map((x) => x.trim()) : null;

export function mountPeopleOwner(admin: Hono): void {
  const describe = async (vaultId: string) => {
    const s = ownerSettings(vaultId);
    const idx = new IdentityIndex(await people(vaultId));
    const configured = s.person ? idx.get(s.person) : null;
    const profile = ownerProfile(idx, ownerConfigFor(vaultId));
    return {
      configured: { person: s.person || null, emails: s.emails, aliases: s.aliases, source: s.source },
      ownerPersonKnown: !!profile.person,
      // The note the matcher will treat as "me" (ids only + whether the configured note is itself usable).
      resolved: profile.person ? { personId: profile.person.id, path: profile.person.path } : null,
      configuredNote: s.person ? (configured ? { found: true, merged: isTombstone(configured), nonHuman: isNonHumanPerson(configured) } : { found: false, merged: false, nonHuman: false }) : null,
    };
  };

  admin.get("/people/owner", async (c) => {
    try {
      c.header("Cache-Control", "private, no-store");
      return c.json(await describe(ownerVaultId(c)));
    } catch {
      return c.json({ error: "people_unavailable" }, 503);
    }
  });

  admin.put("/people/owner", async (c) => {
    const vaultId = ownerVaultId(c);
    const body = await jsonBody(c);
    const emails = strList(body?.emails, 20);
    const aliases = strList(body?.aliases, 20);
    if (!body || typeof body.person !== "string" || !body.person.trim() || body.person.length > 2048 || !emails || !aliases || !emails.every(looksLikeEmail) || aliases.some(looksLikeEmail))
      return c.json({ error: "bad_request", detail: "person (note id or path) is required; emails must be addresses, aliases names" }, 400);
    try {
      const idx = new IdentityIndex(await people(vaultId, true));
      const note = idx.get(body.person.trim());
      if (!note) return c.json({ error: "person_not_found" }, 404);
      if (isTombstone(note) || isNonHumanPerson(note)) return c.json({ error: "not_a_live_person", detail: "the owner must be a live person note, not a merged or non-human one" }, 409);
      // Stored by id: a rename of the note does not lose the owner.
      saveOwnerSettings(vaultId, { person: note.id, emails: emails.map((e) => e.toLowerCase()), aliases });
      return c.json(await describe(vaultId));
    } catch {
      return c.json({ error: "people_unavailable" }, 503);
    }
  });

  admin.delete("/people/owner", async (c) => {
    const vaultId = ownerVaultId(c);
    saveOwnerSettings(vaultId, null);
    try {
      return c.json(await describe(vaultId));
    } catch {
      return c.json({ error: "people_unavailable" }, 503);
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
    const allowNames = optBool(body?.allowNameLinks);
    const excludeBulk = optBool(body?.excludeBulkLinks);
    if (!body || dryRunIn === null || enqueue === null || useMembers === null || allowNames === null || excludeBulk === null)
      return c.json({ error: "bad_request", detail: "dryRun, enqueue, useMatrixMembers, allowNameLinks and excludeBulkLinks must be true or false" }, 400);
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
    if (peopleLockHolder()) return c.json({ error: "busy", detail: `another people operation is in progress (${peopleLockHolder()})`, job: linkJobStatus() }, 409);

    // Matrix membership lookup: ON whenever a Matrix credential is stored (it is how
    // threads link by id), unless the request says `useMatrixMembers: false`.
    let members: ((roomId: string) => Promise<Record<string, string> | null>) | undefined;
    let self: string | null = null;
    const wantsThreads = !Array.isArray(phases) || phases.includes("threads");
    if (useMembers !== false && wantsThreads) {
      const raw = getSecret(vaultId, config.ownerEmail, "matrix");
      if (!raw && useMembers === true) return c.json({ error: "matrix_not_configured" }, 409);
      if (raw) {
        // Every homeserver read is bounded; a failure THROWS so the job's lookup
        // breaker can count it (it never falls back to display names).
        const client = new MatrixClient(JSON.parse(raw) as MatrixCreds);
        self = await bounded(client.whoami(), config.peopleVaultTimeoutMs).catch(() => null);
        members = (roomId) => bounded(client.joinedMembers(roomId), config.peopleVaultTimeoutMs);
      }
    }
    const via = requestVia(c);
    const onEnd = (j: LinkJob) => {
      invalidatePeople(vaultId);
      if (dryRun) return;
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
          allowNameLinks: j.allowNameLinks,
          ...Object.fromEntries(
            j.phases.map((p) => [p, { linked: j.report[p].linked, unlinked: j.report[p].unlinked, conflicts: j.report[p].conflicts, errors: j.report[p].errors, oversize: j.report[p].oversize, deferred: j.report[p].deferred }]),
          ),
        },
        status: j.status === "done" ? "ok" : "failed",
        error: j.error,
      });
    };
    try {
      const { job } = startLinkJob(vaultFor(vaultId) as unknown as LinkJobVault, vaultId, {
        dryRun,
        phases: phases as LinkJob["phases"] | undefined,
        maxWrites,
        enqueue: enqueue === true, // the review queue is filled only when asked
        allowNameLinks: allowNames === true,
        excludeBulkLinks: excludeBulk === true,
        memberFailures: config.peopleLinkMemberFailures,
        paceMs: config.peopleLinkPaceMs,
        owner: ownerConfig(vaultId, self),
        members,
        people: () => people(vaultId, true),
        live: liveHooks(vaultId),
        maxConsecutiveErrors: config.peopleLinkMaxConsecutiveErrors,
        callTimeoutMs: config.peopleVaultTimeoutMs,
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
  const duplicates = (vaultId: string): Promise<DuplicatePair[]> => cachedDerived(vaultId, loadPeople(vaultId), "duplicates", detectDuplicates);

  admin.get("/people/duplicates", async (c) => {
    const vaultId = ownerVaultId(c);
    const strength = c.req.query("strength");
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    if ((strength !== undefined && !["strong", "medium", "weak"].includes(strength)) || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0)
      return c.json({ error: "bad_request" }, 400);
    try {
      // One lean people listing + one detection per cache lifetime; every page reads the cached result.
      const all = await duplicates(vaultId);
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
    const confirmUnrelated = optBool(body?.confirmUnrelated);
    const ids = body?.personIds;
    if (!body || dryRunIn === null || confirmUnrelated === null || !Array.isArray(ids) || ids.length !== 2 || !ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 2048) || ids[0] === ids[1])
      return c.json({ error: "bad_request", detail: "personIds must be two different person note ids" }, 400);
    const [a, b] = ids as [string, string];
    if (body.canonicalId !== undefined && body.canonicalId !== a && body.canonicalId !== b) return c.json({ error: "bad_request", detail: "canonicalId must be one of personIds" }, 400);
    const dryRun = dryRunIn !== false; // a dry run unless explicitly false
    const expectIn = body.expect as { canonicalUpdatedAt?: unknown; secondaryUpdatedAt?: unknown } | undefined;
    const expect =
      expectIn && typeof expectIn === "object" && typeof expectIn.canonicalUpdatedAt === "string" && typeof expectIn.secondaryUpdatedAt === "string"
        ? { canonicalUpdatedAt: expectIn.canonicalUpdatedAt, secondaryUpdatedAt: expectIn.secondaryUpdatedAt }
        : undefined;
    const { via, origin } = actionOrigin(c);
    if (!dryRun) {
      // A write merge is irreversible in practice: it must name the survivor, quote
      // the versions the owner reviewed, and come from a person (session / device).
      if (origin !== "human") return c.json({ error: "agent_origin_refused", detail: "a merge must be confirmed from a signed-in session or device" }, 403);
      if (typeof body.canonicalId !== "string") return c.json({ error: "canonical_required", detail: "a write merge must name canonicalId" }, 400);
      if (!expect) return c.json({ error: "expect_required", detail: "a write merge must send expect {canonicalUpdatedAt, secondaryUpdatedAt} from its dry run" }, 400);
    }
    if (peopleLockHolder()) return busy(c);
    const vault = vaultFor(vaultId) as unknown as MergeVault;
    try {
      // Which pair is this, by the detector's own judgement?
      const list = await people(vaultId, !dryRun);
      const idx = new IdentityIndex(list);
      const na = idx.get(a), nb = idx.get(b);
      if (!na || !nb) return c.json({ error: "not_found" }, 404);
      // A WRITE is judged on a detection run now, on the listing just read — never the 60 s cache.
      const pairs = dryRun ? await duplicates(vaultId) : detectDuplicates(list);
      const pair = pairs.find((p) => (p.a.id === na.id && p.b.id === nb.id) || (p.a.id === nb.id && p.b.id === na.id)) ?? null;
      const canonicalId = (body.canonicalId as string | undefined) === a ? na.id : (body.canonicalId as string | undefined) === b ? nb.id : (pair?.suggestedCanonicalId ?? na.id);
      const [canonical, secondary] = canonicalId === na.id ? [na, nb] : [nb, na];
      // "Resuming" = finishing a merge THIS module started (its marker is on the
      // canonical). A stub that merely points here — written by an agent, or
      // repaired by the job — gets the full checks like any other pair.
      const resuming = isTombstone(secondary) && idx.canonicalOf(secondary)?.id === canonicalId && mergedByThisModule(canonical, secondary.id);
      const owner = ownerProfile(idx, ownerConfigFor(vaultId)).person;
      const refusal = owner && secondary.id === owner.id ? "owner_is_secondary" : resuming ? null : !pair ? "not_a_duplicate" : pair.strength === "weak" ? "weak_match" : null;
      const unrelated = refusal === "not_a_duplicate" || refusal === "weak_match";
      const warnings = [
        ...(unrelated ? ["NOT A DETECTED DUPLICATE: these two notes share no identity the server can see; merging them is your call alone"] : []),
        ...(unrelated && owner && canonical.id === owner.id ? ["THIS MERGES A STRANGER INTO THE OWNER'S OWN PERSON NOTE: every link of the other note will point at the owner"] : []),
      ];
      const info = { pair: pair ? { strength: pair.strength, evidence: pair.evidence } : null, requiresConfirmUnrelated: unrelated, ...(warnings.length ? { warnings } : {}) };
      if (!dryRun) {
        if (refusal === "owner_is_secondary") return c.json({ error: refusal, detail: "the owner's own person note can only be the surviving note" }, 409);
        if (refusal && confirmUnrelated !== true) return c.json({ error: refusal, detail: "these two notes are not a detected duplicate pair; pass confirmUnrelated: true to merge them anyway", ...info }, 409);
      }
      const merge = await mergePeople(vault, {
        canonicalId,
        secondaryId: secondary.id,
        dryRun,
        by: config.ownerEmail,
        expect: dryRun ? undefined : expect,
        live: liveHooks(vaultId),
        maxConsecutiveErrors: config.peopleLinkMaxConsecutiveErrors,
        callTimeoutMs: config.peopleVaultTimeoutMs,
        onWrite: () => invalidatePeople(vaultId),
      });
      if (!dryRun)
        recordAction({
          actorEmail: config.ownerEmail,
          via,
          origin,
          action: "admin.people-merge",
          vaultId,
          // note ids + counts + evidence kinds — no names, addresses, versions or bodies
          target: { ...merge, expect: undefined, pair: info.pair, confirmUnrelated: confirmUnrelated === true },
          status: merge.complete ? "ok" : "failed",
        });
      return c.json({ merge, ...info, ...(refusal === "owner_is_secondary" ? { blocked: refusal } : {}) });
    } catch (e) {
      if (e instanceof MergeError) return c.json({ error: e.code }, e.status as 400 | 404 | 409 | 503);
      if ((e as { status?: number })?.status === 404) return c.json({ error: "not_found" }, 404);
      return c.json({ error: "merge_failed" }, 503);
    }
  });
}
