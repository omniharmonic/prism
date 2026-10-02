/**
 * Acting on the identity review queue (src/identity-store.ts): the owner picks
 * the person a queued identity belongs to, or dismisses it.
 *
 * RESOLVE = one links-only PATCH per source note (`source --relationship-->
 * person`, `if_updated_at`, skipped when the edge already exists) and —
 * optionally — ONE metadata PATCH that adds the key to the chosen person so the
 * same identity links by itself from now on. The key is NOT added when another
 * live person already claims it (that would only make it ambiguous again) — the
 * link is still written and the response says why the identity was skipped.
 * A source note that changed under us (409) or disappeared stays OPEN.
 */
import type { Note, NoteLinkInput } from "./parachute";
import { IdentityIndex, isNonHumanPerson, type IdentityKey, type NameKey } from "./identity";
import { addKeyPatch, PERSON_IDENTITY_KEYS } from "./people-metadata";
import { decideCandidates, openCandidatesForKey, type IdentityCandidate } from "./identity-store";

export interface ReviewVault {
  listNotes(opts: { tags?: string[]; includeMetadata?: string[] }): Promise<Note[]>;
  getNote(id: string, opts?: { includeLinks?: boolean }): Promise<Note>;
  updateNote(id: string, p: { metadata?: Record<string, unknown>; links?: { add?: NoteLinkInput[] }; ifUpdatedAt?: string }): Promise<Note>;
}

export class ReviewError extends Error {
  constructor(
    readonly code: "person_not_found" | "not_open" | "people_unavailable",
    readonly status: number,
  ) {
    super(code);
  }
}

export interface ResolveOutcome {
  personId: string;
  /** Candidates closed by this call. */
  resolved: number;
  linked: number;
  alreadyLinked: number;
  /** Sources that changed meanwhile (left open — retry). */
  conflicts: number;
  /** Sources that no longer exist (closed). */
  missing: number;
  errors: number;
  identityAdded: boolean;
  /** Why the key was not written to the person, when it wasn't. */
  identitySkipped: "not_requested" | "already_present" | "claimed_by_another_person" | "unsupported_kind" | "conflict" | null;
}

const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;
const hasEdge = (n: Note, target: string, rel: string): boolean =>
  Array.isArray(n.links) && n.links.some((l) => l.relationship === rel && l.sourceId === n.id && l.targetId === target);

/** How many notes one resolve may touch when it covers every candidate of a key. */
export const RESOLVE_KEY_LIMIT = 50;

export async function resolveCandidate(
  vault: ReviewVault,
  vaultId: string,
  cand: IdentityCandidate,
  personRef: string,
  opts: { by: string; addIdentity?: boolean; applyToKey?: boolean; paceMs?: number },
): Promise<ResolveOutcome> {
  if (cand.status !== "open") throw new ReviewError("not_open", 409);
  let people: Note[];
  try {
    people = await vault.listNotes({ tags: ["person"], includeMetadata: PERSON_IDENTITY_KEYS });
  } catch {
    throw new ReviewError("people_unavailable", 503);
  }
  const idx = new IdentityIndex(people.filter((n) => (n.tags ?? []).includes("person")));
  const picked = idx.get(personRef);
  const person = picked ? idx.canonicalOf(picked) : null;
  if (!person || isNonHumanPerson(person)) throw new ReviewError("person_not_found", 404);

  const out: ResolveOutcome = { personId: person.id, resolved: 0, linked: 0, alreadyLinked: 0, conflicts: 0, missing: 0, errors: 0, identityAdded: false, identitySkipped: null };
  const batch = opts.applyToKey ? openCandidatesForKey(vaultId, cand.key.kind, cand.key.hash, RESOLVE_KEY_LIMIT) : [cand];
  if (!batch.some((c) => c.id === cand.id)) batch.unshift(cand);
  const done: string[] = [];
  for (const c of batch) {
    try {
      const src = await vault.getNote(c.sourceNoteId, { includeLinks: true });
      if (src.id === person.id) {
        done.push(c.id);
        continue;
      }
      if (hasEdge(src, person.id, c.relationship)) out.alreadyLinked++;
      else {
        await vault.updateNote(src.id, { links: { add: [{ target: person.id, relationship: c.relationship }] }, ...(src.updatedAt ? { ifUpdatedAt: src.updatedAt } : {}) });
        out.linked++;
      }
      done.push(c.id);
    } catch (e) {
      const s = statusOf(e);
      if (s === 409 || s === 428) out.conflicts++;
      else if (s === 404) {
        out.missing++;
        done.push(c.id);
      } else out.errors++;
    }
    if (opts.paceMs) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  out.resolved = decideCandidates(done, "resolved", person.id, opts.by);

  // Teach the person this identity, so it never queues again.
  if (opts.addIdentity === false) out.identitySkipped = "not_requested";
  else {
    const key = { kind: cand.key.kind, value: cand.key.value } as IdentityKey | NameKey;
    const others = key.kind === "name" ? idx.named(cand.display ?? key.value).filter((p) => p.id !== person.id) : idx.claimants(key).filter((p) => p.id !== person.id);
    if (others.length) out.identitySkipped = "claimed_by_another_person";
    else if (key.kind === "handle") out.identitySkipped = "unsupported_kind";
    else {
      const patch = addKeyPatch(person, key, cand.display);
      if (!patch) out.identitySkipped = "already_present";
      else {
        try {
          await vault.updateNote(person.id, { metadata: patch, ...(person.updatedAt ? { ifUpdatedAt: person.updatedAt } : {}) });
          out.identityAdded = true;
        } catch (e) {
          if (statusOf(e) === 409 || statusOf(e) === 428) out.identitySkipped = "conflict";
          else out.errors++;
        }
      }
    }
  }
  return out;
}

export function dismissCandidate(vaultId: string, cand: IdentityCandidate, opts: { by: string; applyToKey?: boolean }): number {
  if (cand.status !== "open") throw new ReviewError("not_open", 409);
  const ids = opts.applyToKey ? openCandidatesForKey(vaultId, cand.key.kind, cand.key.hash, 1000).map((c) => c.id) : [];
  if (!ids.includes(cand.id)) ids.push(cand.id);
  return decideCandidates(ids, "dismissed", null, opts.by);
}
