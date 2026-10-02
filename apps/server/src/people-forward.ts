/**
 * FORWARD linking: an ingester asks, while it builds a new note, which EXISTING
 * notes that note should link to — so the link rides in the note's own write
 * (no extra PATCH) and the graph stays connected without the backfill job.
 *
 * Same rules as the backfill job (src/people-link-job.ts), same matcher
 * (src/identity.ts): never creates a person, never links the owner to their own
 * mail, links ONLY on a strong key (an exact address, a Matrix / bridge id) —
 * a display name is sender-controlled and never links on ingest — and an
 * identity it will not decide is handed back as `pending` — the caller queues
 * it for review
 * (`queue()`, a no-op unless PEOPLE_QUEUE_ON_INGEST) once the note has an id.
 *
 * One `ForwardLinker` per ingest pass: the people listing (lean: identity keys
 * only, no content) is loaded lazily on first use and reused for the pass.
 * Every flag that constructs one defaults to OFF (config.ts).
 */
import type { Note, NoteLinkInput } from "./parachute";
import { IdentityIndex, cleanName, isOwnerQuery, looksLikeEmail, nameTokens, ownerProfile, slugKey, type IdentityKey, type IdentityQuery, type NameKey, type OwnerConfig, type OwnerProfile, type ReviewReason } from "./identity";
import { REL } from "./relationships";
import { PERSON_IDENTITY_KEYS } from "./people-metadata";
import { enqueueCandidate } from "./identity-store";
import { creationRefusal, isNonhumanEmail, type PersonReview } from "./worker/people";
import { addressList } from "./people-link-job";

export interface ForwardVault {
  listNotes(opts: { tags?: string[]; includeMetadata?: string[] }): Promise<Note[]>;
}

export interface PendingReview {
  relationship: string;
  key: IdentityKey | NameKey;
  display: string | null;
  candidateIds: string[];
  reason: ReviewReason;
}

export interface ForwardPlan {
  links: NoteLinkInput[];
  pending: PendingReview[];
}

const BULK_LABELS = new Set(["BULK", "AUTOMATED", "PROMOTIONS", "CATEGORY_PROMOTIONS"]);
const NON_PERSON_DOMAINS = /\.calendar\.google\.com$/i;
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Collects what an ingester's `PeopleIndex.findOrCreate(..., {review})` could
 * not link, per record, and queues it once the record's note id is known.
 * Used by calendar ingest (attendees) and Matrix ingest (DM counterparts).
 */
export class IngestReviewSink {
  private pending = new Map<string, PendingReview[]>();
  queued = 0;
  constructor(private o: { vaultId: string; origin: string; relationship: string }) {}

  /** The `review` callback for one record (an event id, a room id). */
  collect(recordKey: string): (r: PersonReview) => void {
    return (r) => {
      const list = this.pending.get(recordKey) ?? [];
      if (list.length < 20) list.push({ relationship: this.o.relationship, key: r.key, display: r.display, candidateIds: r.candidates.map((c) => c.id), reason: r.reason });
      this.pending.set(recordKey, list);
    };
  }

  /** Queue everything collected for a record against its note (deduped by the store). */
  flush(recordKey: string, noteId: string | null | undefined): void {
    const list = this.pending.get(recordKey);
    this.pending.delete(recordKey);
    if (!list || !noteId) return;
    for (const p of list) {
      try {
        if (enqueueCandidate({ vaultId: this.o.vaultId, sourceNoteId: noteId, relationship: p.relationship, key: p.key, display: p.display, candidateIds: p.candidateIds, reason: p.reason, origin: this.o.origin }) === "created") this.queued++;
      } catch {
        /* the queue is best-effort; ingest never fails on it */
      }
    }
  }
}

export class ForwardLinker {
  private idx: IdentityIndex | null = null;
  private owner: OwnerProfile | null = null;
  private projects: Map<string, Note[]> | null = null;
  /** Rows this pass put in the review queue. */
  queued = 0;

  constructor(
    private vault: ForwardVault,
    private opts: { vaultId: string; origin: string; owner: OwnerConfig; queue: boolean; maxRecipients?: number },
  ) {}

  private async people(): Promise<{ idx: IdentityIndex; owner: OwnerProfile }> {
    if (!this.idx || !this.owner) {
      const notes = (await this.vault.listNotes({ tags: ["person"], includeMetadata: PERSON_IDENTITY_KEYS })).filter((n) => (n.tags ?? []).includes("person"));
      this.idx = new IdentityIndex(notes);
      this.owner = ownerProfile(this.idx, this.opts.owner);
    }
    return { idx: this.idx, owner: this.owner };
  }

  /**
   * One identity → a link or a pending review. A NAME never links on ingest
   * (a display name is sender-controlled): a name-only match is a review item.
   */
  private one(idx: IdentityIndex, plan: ForwardPlan, relationship: string, q: IdentityQuery, seen: Set<string>, o: { excludePerson?: string | null; review?: boolean } = {}): void {
    const m = idx.match(q);
    if (m.status === "linked") {
      if (m.person.id === o.excludePerson || seen.has(m.person.id)) return;
      seen.add(m.person.id);
      plan.links.push({ target: m.person.id, relationship });
    } else if (m.status === "review" && o.review !== false) {
      // The same person already linked from this record (their address AND their name are both listed).
      if (m.reason === "name-only" && m.candidates.length === 1 && seen.has(m.candidates[0]!.id)) return;
      plan.pending.push({ relationship, key: m.key, display: q.name ? cleanName(q.name) : null, candidateIds: m.candidates.map((c) => c.id), reason: m.reason });
    }
  }

  /**
   * `email-from` for the sender (when `sender`) and `email-to` for each direct
   * recipient (when `recipients`) — by EXACT address only. Bulk-labelled mail
   * and role mailboxes link only an exact address and queue nothing; a mailing's
   * recipient list is never linked. Never the owner.
   */
  async email(m: { from?: string | null; to?: string | null; labels?: unknown }, want: { sender: boolean; recipients: boolean }): Promise<ForwardPlan> {
    const plan: ForwardPlan = { links: [], pending: [] };
    const { idx, owner } = await this.people();
    const bulk = strings(m.labels).some((l) => BULK_LABELS.has(l.toUpperCase()));
    const me = owner.person?.id ?? null;
    const seen = new Set<string>();
    const from = addressList(m.from ?? "")[0];
    if (want.sender && from && !owner.emails.has(from.email)) {
      const quiet = bulk || isNonhumanEmail(from.email);
      this.one(idx, plan, REL.EMAIL_FROM, quiet ? { email: from.email } : { email: from.email, name: from.name || null }, seen, { excludePerson: me, review: !quiet });
    }
    if (want.recipients && !bulk) {
      const to = addressList(m.to ?? "");
      if (to.length <= (this.opts.maxRecipients ?? 10))
        for (const r of to) {
          if (owner.emails.has(r.email)) continue;
          const role = isNonhumanEmail(r.email);
          this.one(idx, plan, REL.EMAIL_TO, role ? { email: r.email } : { email: r.email, name: r.name || null }, seen, { excludePerson: me, review: !role });
        }
    }
    return plan;
  }

  /** `attended-by` from a transcript's attendee names + addresses (owner included, as calendar ingest does). */
  async attendees(names: string[], emails: string[]): Promise<ForwardPlan> {
    const plan: ForwardPlan = { links: [], pending: [] };
    const { idx, owner } = await this.people();
    const seen = new Set<string>();
    const addrs = new Set(emails.map((e) => e.trim().toLowerCase()).filter(looksLikeEmail));
    const plain: string[] = [];
    for (const n of names) (looksLikeEmail(n) ? addrs.add(n.trim().toLowerCase()) : plain.push(n));
    const queries: IdentityQuery[] = [...[...addrs].map((email) => ({ email })), ...plain.map((name) => ({ name }))];
    for (const q of queries) {
      if (q.email && NON_PERSON_DOMAINS.test(q.email)) continue;
      // The owner: by address, or by a configured multi-word name.
      if (isOwnerQuery(owner, q) && (q.email || nameTokens(q.name ?? "").length >= 2)) {
        if (owner.person) this.one(idx, plan, REL.ATTENDED_BY, { ref: owner.person.id }, seen);
        continue;
      }
      if (q.name && creationRefusal(q.name)) continue;
      this.one(idx, plan, REL.ATTENDED_BY, q, seen, { review: !(q.email && isNonhumanEmail(q.email)) });
    }
    return plan;
  }

  /** `assigned-to` (existing person; the owner by configured name) and `belongs-to` (the ONE project of that name). */
  async task(t: { assignees?: Array<{ name?: string | null; email?: string | null }>; project?: string | null }): Promise<ForwardPlan> {
    const plan: ForwardPlan = { links: [], pending: [] };
    const { idx, owner } = await this.people();
    const seen = new Set<string>();
    for (const a of t.assignees ?? []) {
      const q: IdentityQuery = { name: a.name ?? null, email: a.email ?? null };
      if (!q.name && !q.email) continue;
      if (isOwnerQuery(owner, q)) {
        if (owner.person) this.one(idx, plan, REL.ASSIGNED_TO, { ref: owner.person.id }, seen);
        continue;
      }
      this.one(idx, plan, REL.ASSIGNED_TO, q, seen);
    }
    const project = t.project?.trim();
    if (project) {
      if (!this.projects) {
        this.projects = new Map();
        for (const p of await this.vault.listNotes({ tags: ["project"], includeMetadata: ["name", "slug", "aliases"] })) {
          const md = p.metadata ?? {};
          const keys = new Set([slugKey(p.path?.split("/").pop() ?? ""), ...[...strings(md.name), ...strings(md.slug)].map(slugKey)]);
          for (const k of keys) if (k) this.projects.set(k, [...(this.projects.get(k) ?? []), p]);
        }
      }
      const hits = this.projects.get(slugKey(project)) ?? [];
      if (hits.length === 1) plan.links.push({ target: hits[0]!.id, relationship: REL.BELONGS_TO });
    }
    return plan;
  }

  /** Queue what a plan could not decide, now that the note exists. No-op unless enabled. */
  queue(noteId: string, pending: PendingReview[]): void {
    if (!this.opts.queue) return;
    for (const p of pending) {
      try {
        const r = enqueueCandidate({ vaultId: this.opts.vaultId, sourceNoteId: noteId, relationship: p.relationship, key: p.key, display: p.display, candidateIds: p.candidateIds, reason: p.reason, origin: this.opts.origin });
        if (r === "created") this.queued++;
      } catch {
        /* the queue is best-effort; ingest never fails on it */
      }
    }
  }
}
