/**
 * Acting on the identity review queue (src/identity-store.ts): the owner picks
 * the person a queued identity belongs to, or dismisses it.
 *
 * RESOLVE = one links-only PATCH per source note (`source --relationship-->
 * person`, `if_updated_at`, skipped when that directed edge already exists) and
 * — only when `addIdentity: true` is passed — ONE metadata PATCH that adds the
 * key to the chosen person so the same identity links by itself from now on.
 * The key is NOT added when anyone else already claims it, or when the target
 * field holds a value of an unexpected type. A source note that changed under
 * us (409), or for which the vault gave no version, stays OPEN — nothing is ever
 * force-written. A `tombstone-unresolved` candidate resolves by writing
 * `merged_into` on the stub. Mutually exclusive with the job and merges.
 */
import type { Note, NoteLinkInput } from "./parachute";
import { IdentityIndex, isNonHumanPerson, type IdentityKey, type NameKey } from "./identity";
import { addKeyPatch, PERSON_IDENTITY_KEYS } from "./people-metadata";
import { decideCandidates, openCandidatesForKey, type IdentityCandidate } from "./identity-store";
import { acquirePeopleLock } from "./people-lock";

export interface ReviewVault {
  listNotes(opts: { tags?: string[]; includeMetadata?: string[]; includeLinks?: boolean }): Promise<Note[]>;
  getNote(id: string, opts?: { includeLinks?: boolean }): Promise<Note>;
  updateNote(id: string, p: { metadata?: Record<string, unknown>; links?: { add?: NoteLinkInput[] }; ifUpdatedAt?: string }): Promise<Note>;
}

export class ReviewError extends Error {
  constructor(
    readonly code: "person_not_found" | "not_open" | "people_unavailable" | "busy",
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
  /** Sources the vault gave no version for (left open; never force-written). */
  noStamp: number;
  errors: number;
  identityAdded: boolean;
  /** Why the key was not written to the person, when it wasn't. */
  identitySkipped: "not_requested" | "already_present" | "claimed_by_another_person" | "unsupported_kind" | "unexpected_type" | "conflict" | null;
}

export interface ResolveOptions {
  by: string;
  /** Also write the key onto the person (default FALSE — linking one note is not a claim about every note). */
  addIdentity?: boolean;
  applyToKey?: boolean;
  /**
   * The version of the source note the decider reviewed (single candidate only).
   * When set, the link is written with THIS stamp as `if_updated_at`; a source
   * that is no longer at that version counts as a conflict and stays open.
   */
  expectSourceUpdatedAt?: string;
  paceMs?: number;
  /** The lean person listing (the route passes the shared cache). */
  people?: () => Promise<Note[]>;
  live?: { isLive(noteId: string): boolean; markReconciled(noteId: string, prevMs: number, nextMs: number): void };
  onWrite?: () => void;
}

const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;
/** DIRECTED: source → target. */
const hasEdge = (n: Note, target: string, rel: string): boolean =>
  Array.isArray(n.links) && n.links.some((l) => l.relationship === rel && l.sourceId === n.id && l.targetId === target);

/** How many notes one resolve may touch when it covers every candidate of a key. */
export const RESOLVE_KEY_LIMIT = 50;
/** The pseudo-relationship of a `tombstone-unresolved` candidate: resolving writes `merged_into`, not a link. */
export const MERGED_INTO = "merged-into";

export async function resolveCandidate(vault: ReviewVault, vaultId: string, cand: IdentityCandidate, personRef: string, opts: ResolveOptions): Promise<ResolveOutcome> {
  if (cand.status !== "open") throw new ReviewError("not_open", 409);
  const release = acquirePeopleLock("people-resolve");
  if (!release) throw new ReviewError("busy", 409);
  try {
    return await doResolve(vault, vaultId, cand, personRef, opts);
  } finally {
    release();
  }
}

async function doResolve(vault: ReviewVault, vaultId: string, cand: IdentityCandidate, personRef: string, opts: ResolveOptions): Promise<ResolveOutcome> {
  let people: Note[];
  try {
    people = opts.people ? await opts.people() : await vault.listNotes({ tags: ["person"], includeMetadata: PERSON_IDENTITY_KEYS });
  } catch {
    throw new ReviewError("people_unavailable", 503);
  }
  const idx = new IdentityIndex(people.filter((n) => (n.tags ?? []).includes("person")));
  const picked = idx.get(personRef);
  const person = picked ? idx.canonicalOf(picked) : null;
  if (!person || isNonHumanPerson(person)) throw new ReviewError("person_not_found", 404);

  const out: ResolveOutcome = { personId: person.id, resolved: 0, linked: 0, alreadyLinked: 0, conflicts: 0, missing: 0, noStamp: 0, errors: 0, identityAdded: false, identitySkipped: null };
  const write = async (id: string, p: Parameters<ReviewVault["updateNote"]>[1], updatedAt: string | null | undefined): Promise<boolean> => {
    if (!updatedAt) {
      out.noStamp++; // no version to compare against → never a blind write
      return false;
    }
    const live = opts.live?.isLive(id) ?? false;
    const updated = await vault.updateNote(id, { ...p, ifUpdatedAt: updatedAt });
    // Checked again AFTER the write: an editor may have opened the note meanwhile.
    if (live || (opts.live?.isLive(id) ?? false)) {
      const prev = Date.parse(updatedAt), next = Date.parse(updated?.updatedAt ?? "");
      if (Number.isFinite(prev) && Number.isFinite(next)) opts.live!.markReconciled(id, prev, next);
    }
    opts.onWrite?.();
    return true;
  };
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
      if (c.relationship === MERGED_INTO) {
        // A broken tombstone: point it at the person it was merged into.
        const prev = typeof src.metadata?.merged_into === "string" && src.metadata.merged_into.trim() ? src.metadata.merged_into : null;
        if (await write(src.id, { metadata: { merged_into: person.id, ...(prev ? { prism_merged_into_prev: prev } : {}) } }, src.updatedAt)) {
          out.linked++;
          done.push(c.id);
        }
      } else if (hasEdge(src, person.id, c.relationship)) {
        out.alreadyLinked++;
        done.push(c.id);
      } else if (c.id === cand.id && opts.expectSourceUpdatedAt && src.updatedAt !== opts.expectSourceUpdatedAt) {
        out.conflicts++; // changed since it was reviewed — never written
      } else if (await write(src.id, { links: { add: [{ target: person.id, relationship: c.relationship }] } }, c.id === cand.id && opts.expectSourceUpdatedAt ? opts.expectSourceUpdatedAt : src.updatedAt)) {
        out.linked++;
        done.push(c.id);
      }
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

  // Teach the person this identity — only when asked.
  if (opts.addIdentity !== true || cand.relationship === MERGED_INTO) out.identitySkipped = "not_requested";
  else {
    const key = { kind: cand.key.kind, value: cand.key.value } as IdentityKey | NameKey;
    const others =
      key.kind === "name"
        ? idx.named(cand.display ?? key.value).filter((p) => p.id !== person.id)
        : [...idx.claimants(key).filter((p) => p.id !== person.id), ...idx.claimedBy(key)];
    if (others.length) out.identitySkipped = "claimed_by_another_person";
    else if (key.kind === "handle") out.identitySkipped = "unsupported_kind";
    else {
      // Read-modify-write on the CURRENT note (nested objects are sent whole).
      try {
        const fresh = await vault.getNote(person.id);
        const r = addKeyPatch(fresh, key, cand.display);
        if (r.skipped) out.identitySkipped = "unexpected_type";
        else if (!r.patch) out.identitySkipped = "already_present";
        else if (await write(fresh.id, { metadata: r.patch }, fresh.updatedAt)) out.identityAdded = true;
      } catch (e) {
        if (statusOf(e) === 409 || statusOf(e) === 428) out.identitySkipped = "conflict";
        else out.errors++;
      }
    }
  }
  return out;
}

export function dismissCandidate(vaultId: string, cand: IdentityCandidate, opts: { by: string; applyToKey?: boolean }): number {
  if (cand.status !== "open") throw new ReviewError("not_open", 409);
  const release = acquirePeopleLock("people-dismiss");
  if (!release) throw new ReviewError("busy", 409);
  try {
    const ids = opts.applyToKey ? openCandidatesForKey(vaultId, cand.key.kind, cand.key.hash, 1000).map((c) => c.id) : [];
    if (!ids.includes(cand.id)) ids.push(cand.id);
    return decideCandidates(ids, "dismissed", null, opts.by);
  } finally {
    release();
  }
}
