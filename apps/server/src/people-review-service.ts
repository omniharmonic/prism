/**
 * The ONE code path that acts on the identity review queue, shared by its two
 * callers: the owner routes (`routes/people-admin.ts`, session / device) and the
 * Prism MCP tools (`mcp/tool-people.ts`, an agent holding the owner's
 * credential). Both go through `resolveReview` / `dismissReview`, so the vault
 * wiring (timeouts, the shared people listing, the live-document hooks), the
 * people lock, the CAS rules of `identity-review.ts` and the `action_audit` row
 * are the same whoever asks — the MCP layer adds restrictions, never a second
 * implementation.
 */
import { config } from "./config";
import { vaultClient, type Note } from "./parachute";
import { recordAction, type ActionOrigin } from "./actions/store";
import type { IdentityCandidate } from "./identity-store";
import { dismissCandidate, resolveCandidate, type ResolveOutcome, type ReviewVault } from "./identity-review";
import { detectDuplicates, type DuplicatePair } from "./people-merge";
import { PERSON_IDENTITY_KEYS } from "./people-metadata";
import { cachedDerived, cachedPeople, invalidatePeople } from "./people-cache";
import { docNameFor, isDocLive, markReconciled } from "./collab";

/** A vault client whose every call is abandoned after PEOPLE_VAULT_TIMEOUT_MS. */
export const peopleVault = (vaultId: string) => vaultClient(vaultId, { timeoutMs: config.peopleVaultTimeoutMs });

/** The lean person listing (identity keys + links, never content), shared + cached 60 s. */
export const loadPeopleListing = (vaultId: string) => (): Promise<Note[]> => peopleVault(vaultId).listNotes({ tags: ["person"], includeLinks: true, includeMetadata: PERSON_IDENTITY_KEYS });
export const peopleListing = (vaultId: string, fresh = false): Promise<Note[]> => cachedPeople(vaultId, loadPeopleListing(vaultId), { fresh });

/** Detected duplicate pairs: one detection per cached listing. */
export const duplicatePairs = (vaultId: string): Promise<DuplicatePair[]> => cachedDerived(vaultId, loadPeopleListing(vaultId), "duplicates", detectDuplicates);

/** The job's pacing, time-outs and limits from config — the same for a run the owner starts and a scheduled one. */
export const linkJobTuning = () => ({
  memberFailures: config.peopleLinkMemberFailures,
  paceMs: config.peopleLinkPaceMs,
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
});

/** collab.ts, read-only: is a note open in the editor, and "its content did not change". */
export const peopleLiveHooks = (vaultId: string) => ({
  isLive: (noteId: string) => isDocLive(vaultId, noteId),
  markReconciled: (noteId: string, prevMs: number, nextMs: number) => void markReconciled(docNameFor(vaultId, noteId), prevMs, nextMs),
});

export interface ReviewCaller {
  /** How the request authenticated (session, device, mcp:pat, …) — recorded, never trusted for access. */
  via: string;
  origin: ActionOrigin;
  /** Extra ids / hashes / counts for the audit target (never a key value, a name or free text). */
  auditExtra?: Record<string, unknown>;
}

/**
 * Resolve one review row to a person: `identity-review.ts` does the work (lock,
 * CAS, directed-edge check); this adds the standard wiring and ONE audit row.
 * Throws `ReviewError` exactly as `resolveCandidate` does.
 */
export async function resolveReview(
  vaultId: string,
  cand: IdentityCandidate,
  personId: string,
  o: { addIdentity?: boolean; applyToKey?: boolean; expectSourceUpdatedAt?: string } & ReviewCaller,
): Promise<ResolveOutcome> {
  const outcome = await resolveCandidate(peopleVault(vaultId) as unknown as ReviewVault, vaultId, cand, personId, {
    by: config.ownerEmail,
    addIdentity: o.addIdentity === true, // off unless explicitly asked
    applyToKey: o.applyToKey === true,
    expectSourceUpdatedAt: o.expectSourceUpdatedAt,
    paceMs: 25,
    people: () => peopleListing(vaultId),
    live: peopleLiveHooks(vaultId),
    onWrite: () => invalidatePeople(vaultId),
  });
  recordAction({
    actorEmail: config.ownerEmail,
    via: o.via,
    origin: o.origin,
    action: "admin.people-candidate-resolve",
    vaultId,
    // ids + hashes + counts only — never the key value or a name.
    target: { candidateId: cand.id, keyKind: cand.key.kind, keyHash: cand.key.hash.slice(0, 16), relationship: cand.relationship, ...outcome, ...(o.auditExtra ?? {}) },
    status: outcome.errors || outcome.conflicts || outcome.noStamp ? "failed" : "ok",
  });
  return outcome;
}

/**
 * Dismiss one review row (never touches the vault). The owner route passes no
 * `audit` (unchanged behaviour); an agent's dismissal always records one.
 */
export function dismissReview(vaultId: string, cand: IdentityCandidate, o: { applyToKey?: boolean; audit?: ReviewCaller }): number {
  const dismissed = dismissCandidate(vaultId, cand, { by: config.ownerEmail, applyToKey: o.applyToKey === true });
  if (o.audit)
    recordAction({
      actorEmail: config.ownerEmail,
      via: o.audit.via,
      origin: o.audit.origin,
      action: "admin.people-candidate-dismiss",
      vaultId,
      target: { candidateId: cand.id, keyKind: cand.key.kind, keyHash: cand.key.hash.slice(0, 16), relationship: cand.relationship, dismissed, ...(o.audit.auditExtra ?? {}) },
      status: "ok",
    });
  return dismissed;
}
