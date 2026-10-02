/**
 * The canonical relationship vocabulary for typed links between notes.
 *
 * The UI shows a record under a person ONLY when a typed link exists, and it
 * matches on exact names: `VaultMessagesDashboard` filters the graph on
 * `messages-with` and `email-from`; `EventTranscripts` reads `has-transcript`;
 * the People workspace (`GET /api/people/:id`) lists every relationship in both
 * directions. The live vault had 143 distinct names (agents free-typing
 * `attendee`, `attended`, `from`, `owner`, …), so the same fact was invisible
 * depending on who wrote it. This module is the ONE list the server writes, and
 * the synonym map the backfill job's normalization phase uses.
 *
 * Direction is part of the vocabulary: the SOURCE is the record, the TARGET is
 * what it points at (`thread --messages-with--> person`). A synonym is only
 * rewritten when the two notes' kinds fit the canonical relationship — in the
 * stated direction, or reversed (then the canonical link is written on the
 * other note). Anything else is left alone: an unknown name is not an error.
 */

export type NoteKind = "person" | "thread" | "email" | "meeting" | "task" | "project" | "organization" | "other";

export const REL = {
  MESSAGES_WITH: "messages-with",
  EMAIL_FROM: "email-from",
  EMAIL_TO: "email-to",
  ATTENDED_BY: "attended-by",
  HAS_TRANSCRIPT: "has-transcript",
  ASSIGNED_TO: "assigned-to",
  BELONGS_TO: "belongs-to",
  MEMBER_OF: "member-of",
  WORKS_AT: "works-at",
  REFERENCES: "references",
  RELATED_TO: "related-to",
} as const;
export type CanonicalRelationship = (typeof REL)[keyof typeof REL];

interface Shape {
  from: NoteKind[] | "any";
  to: NoteKind[] | "any";
  about: string;
}

export const CANONICAL: Record<CanonicalRelationship, Shape> = {
  "messages-with": { from: ["thread"], to: ["person"], about: "a chat thread and a person in it" },
  "email-from": { from: ["email"], to: ["person"], about: "an email and its sender" },
  "email-to": { from: ["email"], to: ["person"], about: "an email and a direct recipient" },
  "attended-by": { from: ["meeting"], to: ["person"], about: "a meeting or transcript and an attendee" },
  "has-transcript": { from: ["meeting"], to: ["meeting"], about: "a calendar meeting and its transcript" },
  "assigned-to": { from: ["task"], to: ["person"], about: "a task and who it is assigned to" },
  "belongs-to": { from: ["task"], to: ["project"], about: "a task and its project" },
  "member-of": { from: ["person"], to: ["organization", "project"], about: "a person and a group they belong to" },
  "works-at": { from: ["person"], to: ["organization"], about: "a person and their employer" },
  references: { from: "any", to: "any", about: "a note that mentions another ([[wikilink]] resolved by the server job)" },
  "related-to": { from: "any", to: "any", about: "an untyped association" },
};

export const CANONICAL_RELATIONSHIPS = Object.keys(CANONICAL) as CanonicalRelationship[];
export const isCanonicalRelationship = (r: string): r is CanonicalRelationship => Object.prototype.hasOwnProperty.call(CANONICAL, r);

/**
 * Links the vault derives from note CONTENT (`[[target]]` → `wikilink`). They are
 * re-created on every save, so they are never rewritten or moved; consumers
 * should read `wikilink` and `references` as the same thing.
 */
export const VAULT_MANAGED = new Set(["wikilink"]);

/** Observed long-tail name → canonical. Applied only when the endpoint kinds fit. */
export const SYNONYMS: Record<string, CanonicalRelationship> = {
  attendee: "attended-by",
  attendees: "attended-by",
  attended: "attended-by",
  "has-attendee": "attended-by",
  from: "email-from",
  sender: "email-from",
  "sent-by": "email-from",
  recipient: "email-to",
  to: "email-to",
  "sent-to": "email-to",
  owner: "assigned-to",
  assignee: "assigned-to",
  assigned: "assigned-to",
  "owned-by": "assigned-to",
  project: "belongs-to",
  "in-project": "belongs-to",
  "part-of": "belongs-to",
  member: "member-of",
  "has-member": "member-of",
  participant: "messages-with",
  participants: "messages-with",
  "chat-with": "messages-with",
  related: "related-to",
  "relates-to": "related-to",
  reference: "references",
  "refers-to": "references",
};

/** What a note is, for relationship shapes (a note can be several, e.g. meeting + transcript). */
export function noteKinds(n: { tags?: string[] | null; metadata?: Record<string, unknown> | null }): NoteKind[] {
  const tags = new Set<unknown>([...(n.tags ?? []), n.metadata?.type]);
  const out: NoteKind[] = [];
  if (tags.has("person")) out.push("person");
  if (tags.has("message-thread")) out.push("thread");
  if (tags.has("email")) out.push("email");
  if (tags.has("meeting") || tags.has("transcript") || tags.has("event")) out.push("meeting");
  if (tags.has("task")) out.push("task");
  if (tags.has("project")) out.push("project");
  if (tags.has("organization")) out.push("organization");
  return out.length ? out : ["other"];
}

const fits = (allowed: NoteKind[] | "any", kinds: NoteKind[]): boolean => allowed === "any" || kinds.some((k) => allowed.includes(k));

export interface Normalized {
  canonical: CanonicalRelationship;
  /** The canonical link runs target → source (write it on the other note). */
  reversed: boolean;
}

/**
 * The canonical form of one link, or null when it must be left alone: already
 * canonical, vault-managed, not a known synonym, or the endpoint kinds fit
 * neither direction (an `owner` link between two projects is not `assigned-to`).
 */
export function normalizeRelationship(relationship: string, source: NoteKind[], target: NoteKind[]): Normalized | null {
  const key = relationship.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (VAULT_MANAGED.has(key)) return null;
  const canonical = isCanonicalRelationship(key) ? key : SYNONYMS[key];
  if (!canonical) return null;
  const shape = CANONICAL[canonical];
  const same = fits(shape.from, source) && fits(shape.to, target);
  const flipped = fits(shape.from, target) && fits(shape.to, source);
  if (same) return canonical === relationship ? null : { canonical, reversed: false };
  // A canonical name pointing the other way is left alone (both directions are
  // read by every consumer); only a SYNONYM is rewritten onto the other note.
  if (flipped && shape.from !== "any" && !isCanonicalRelationship(key)) return { canonical, reversed: true };
  return null;
}
