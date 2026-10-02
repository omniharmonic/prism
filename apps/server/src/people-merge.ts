/**
 * Duplicate people: DETECT (read-only) and MERGE (an explicit owner call per
 * pair, dry run by default). Nothing here ever runs on its own, and no note is
 * ever deleted.
 *
 * DETECTION (`detectDuplicates`) — pairs of LIVE people, each with a strength
 * and the KIND of evidence (never the value):
 *   strong  shared `email` / `matrix` / `telegram` / `phone` / `handle`;
 *           `email-derived-name` — one note is named after an address the other
 *           claims (an auto-created `first-example-org` stub vs the named
 *           profile); `email-as-name` — its `name` IS that address.
 *   medium  `name` — the same name / alias / path leaf after slug folding.
 *   weak    `abbreviated-name` — "J Smith" vs "John Smith", "John S" vs "John
 *           Smith". A hint for the owner, never grounds to merge unreviewed.
 *
 * MERGE (`mergePeople`), in this order so a failure can only leave MORE links,
 * never fewer, and re-running the same call finishes the job:
 *   1. CANONICAL: one CAS write — identities / aliases / organizations /
 *      projects the secondary has and the canonical lacks (nothing existing is
 *      overwritten), the secondary's body under a marked section if it has any
 *      beyond a heading, and the secondary's OUTGOING links.
 *   2. Every note that links TO the secondary: one links-only CAS write each
 *      (add → canonical, remove → secondary). A conflict is counted and left.
 *   3. SECONDARY, last: tombstoned in the owner's existing convention (tag
 *      `merged-stub`, `merged_into`, `status: merged_into_canonical`,
 *      `merged_at`), its identity keys stripped (kept under
 *      `prism_merged_identities` for undo) and its outgoing links removed.
 * Vault-managed `wikilink` links can't move (the vault derives them from note
 * content): the canonical gets a `references` link beside them.
 * Undo = version history: restore the canonical, the secondary and (for links)
 * the affected notes — see BACKEND-STATUS-GRAPH.md.
 */
import type { Note, NoteLinkInput } from "./parachute";
import { IdentityIndex, cleanName, fineKind, isNonHumanPerson, isTombstone, looksLikeEmail, mergedIntoRef, nameTokens, personKeys, slugKey } from "./identity";
import { REL, VAULT_MANAGED } from "./relationships";
import { stripIdentityPatch, unionIdentities } from "./people-metadata";

// ── detection ────────────────────────────────────────────────────────────────

export type DuplicateStrength = "strong" | "medium" | "weak";
export interface DuplicatePerson {
  id: string;
  name: string;
  path: string | null;
  links: number;
}
export interface DuplicatePair {
  a: DuplicatePerson;
  b: DuplicatePerson;
  strength: DuplicateStrength;
  /** Evidence KINDS only (email, matrix, telegram, phone, handle, email-derived-name, email-as-name, name, abbreviated-name). */
  evidence: string[];
  suggestedCanonicalId: string;
}

const RANK: Record<DuplicateStrength, number> = { strong: 3, medium: 2, weak: 1 };
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const displayName = (n: Note): string => (typeof n.metadata?.name === "string" && n.metadata.name.trim()) || n.path?.split("/").pop() || n.id;
const linkCount = (n: Note): number => (Array.isArray(n.links) ? n.links.length : 0);

/**
 * Which of two duplicates should survive: a profile with a real, written name
 * ("Morgan Example") beats an address- or slug-shaped auto-created stub even
 * when the stub collected more links (they are re-pointed anyway); then more
 * links, more fields, older. The caller may always choose otherwise.
 */
export function chooseCanonical(a: Note, b: Note): Note {
  const score = (n: Note): number[] => {
    const name = typeof n.metadata?.name === "string" ? n.metadata.name : "";
    const realName = name && !name.includes("@") && nameTokens(name).length >= 2 && /[A-Z]/.test(name) ? 1 : 0;
    return [realName, linkCount(n), Object.keys(n.metadata ?? {}).length];
  };
  const sa = score(a), sb = score(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! > sb[i]! ? a : b;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a : b;
  return a.id < b.id ? a : b;
}

/** "j smith" ~ "john smith", "john s" ~ "john smith" (same token count, one initial). */
function abbreviates(x: string[], y: string[]): boolean {
  if (x.length !== y.length || x.length < 2) return false;
  let initials = 0;
  for (let i = 0; i < x.length; i++) {
    const p = x[i]!, q = y[i]!;
    if (p === q) continue;
    const [short, long] = p.length <= q.length ? [p, q] : [q, p];
    if (short.length === 1 && long.startsWith(short) && long.length > 1) initials++;
    else return false;
  }
  return initials === 1;
}

export function detectDuplicates(people: Note[]): DuplicatePair[] {
  const idx = new IdentityIndex(people.filter((n) => (n.tags ?? []).includes("person")));
  const live = idx.live();
  const pairs = new Map<string, { a: Note; b: Note; strength: DuplicateStrength; evidence: Set<string> }>();
  const pair = (x: Note, y: Note, strength: DuplicateStrength, evidence: string) => {
    if (x.id === y.id) return;
    const [a, b] = x.id < y.id ? [x, y] : [y, x];
    const k = `${a.id}\u0000${b.id}`;
    const p = pairs.get(k) ?? { a, b, strength, evidence: new Set<string>() };
    if (RANK[strength] > RANK[p.strength]) p.strength = strength;
    p.evidence.add(evidence);
    pairs.set(k, p);
  };
  const group = (buckets: Map<string, Note[]>, strength: DuplicateStrength, evidence: (key: string) => string) => {
    for (const [key, members] of buckets) {
      if (members.length < 2 || members.length > 12) continue; // a key 12+ people share is not an identity
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pair(members[i]!, members[j]!, strength, evidence(key));
    }
  };
  const bucket = (m: Map<string, Note[]>, k: string, n: Note) => {
    const b = m.get(k) ?? [];
    if (!b.includes(n)) b.push(n);
    m.set(k, b);
  };

  const byKey = new Map<string, Note[]>();
  const byName = new Map<string, Note[]>();
  const byEmailSlug = new Map<string, Note[]>();
  const byEmail = new Map<string, Note[]>();
  for (const p of live) {
    const keys = idx.keysFor(p.id);
    for (const k of keys.strong) {
      if (k.kind === "matrix" && k.value.startsWith("!")) continue; // a room id is not a person
      bucket(byKey, `${fineKind(k).split(":")[0]}\u0000${k.value}`, p);
      if (k.kind === "email") {
        bucket(byEmail, k.value, p);
        bucket(byEmailSlug, slugKey(k.value), p);
      }
    }
    for (const n of keys.names) bucket(byName, n, p);
  }
  group(byKey, "strong", (k) => k.split("\u0000")[0]!);
  group(byName, "medium", () => "name");
  // A note named after someone else's address.
  for (const p of live) {
    const own = personKeys(p);
    for (const n of own.names) {
      for (const holder of byEmailSlug.get(n) ?? []) if (holder.id !== p.id) pair(p, holder, "strong", "email-derived-name");
    }
    for (const raw of strings(p.metadata?.name)) {
      if (!looksLikeEmail(raw)) continue;
      for (const holder of byEmail.get(raw.trim().toLowerCase()) ?? []) if (holder.id !== p.id) pair(p, holder, "strong", "email-as-name");
    }
  }
  // Abbreviated names, bucketed by last token so this stays far from n².
  const byLast = new Map<string, Array<{ p: Note; tokens: string[] }>>();
  const byFirst = new Map<string, Array<{ p: Note; tokens: string[] }>>();
  for (const p of live) {
    const tokens = nameTokens(cleanName(displayName(p)));
    if (tokens.length < 2 || tokens.length > 4) continue;
    for (const [m, k] of [[byLast, tokens.at(-1)!], [byFirst, tokens[0]!]] as const) {
      if (k.length < 2) continue;
      m.set(k, [...(m.get(k) ?? []), { p, tokens }]);
    }
  }
  for (const m of [byLast, byFirst])
    for (const members of m.values()) {
      if (members.length < 2 || members.length > 40) continue;
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) if (abbreviates(members[i]!.tokens, members[j]!.tokens)) pair(members[i]!.p, members[j]!.p, "weak", "abbreviated-name");
    }

  const ref = (n: Note): DuplicatePerson => ({ id: n.id, name: displayName(n), path: n.path, links: linkCount(n) });
  return [...pairs.values()]
    .map((p) => ({ a: ref(p.a), b: ref(p.b), strength: p.strength, evidence: [...p.evidence].sort(), suggestedCanonicalId: chooseCanonical(p.a, p.b).id }))
    .sort((x, y) => RANK[y.strength] - RANK[x.strength] || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id));
}

// ── merge ────────────────────────────────────────────────────────────────────

export interface MergeVault {
  listNotes(opts: { includeMetadata?: string[]; limit?: number }): Promise<Note[]>;
  getNote(id: string, opts?: { includeLinks?: boolean }): Promise<Note>;
  updateNote(
    id: string,
    p: { content?: string; metadata?: Record<string, unknown>; links?: { add?: NoteLinkInput[]; remove?: NoteLinkInput[] }; tags?: { add?: string[] }; ifUpdatedAt?: string },
  ): Promise<Note>;
}

export class MergeError extends Error {
  constructor(
    readonly code: "not_found" | "not_a_person" | "same_person" | "canonical_is_merged" | "secondary_merged_elsewhere" | "non_human" | "conflict" | "inventory_limit",
    readonly status: number,
  ) {
    super(code);
  }
}

export interface MergeReport {
  dryRun: boolean;
  canonicalId: string;
  secondaryId: string;
  /** The secondary was already tombstoned into this canonical: finishing an earlier merge. */
  resumed: boolean;
  /** What the canonical gains, by kind (counts only). */
  identities: Record<string, number>;
  bodyAppended: boolean;
  /** Planned. */
  outbound: number;
  inbound: number;
  alreadyPresent: number;
  notesToWrite: number;
  /** Written (write run). */
  notesWritten: number;
  conflicts: number;
  errors: number;
  tombstoned: boolean;
  /** Everything planned was applied (always false for a dry run that had work). */
  complete: boolean;
}

let merging = false;
export const mergeRunning = (): boolean => merging;

const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;
const hasOut = (n: Note, target: string, rel: string): boolean => (n.links ?? []).some((l) => l.sourceId === n.id && l.targetId === target && l.relationship === rel);
const mergeMarker = (id: string): string => `<!-- prism-merge:${id} -->`;

/** A note body minus its title line and the auto-create boilerplate. */
export function bodyBeyondHeading(content: string): string {
  const lines = (content ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "").split("\n");
  if (lines[0]?.startsWith("# ")) lines.shift();
  return lines
    .join("\n")
    .replace(/^\s*Auto-created by Prism sync\.\s*$/gm, "")
    .trim();
}

export async function mergePeople(vault: MergeVault, o: { canonicalId: string; secondaryId: string; dryRun: boolean; by: string; now?: number }): Promise<MergeReport> {
  if (o.canonicalId === o.secondaryId) throw new MergeError("same_person", 400);
  if (merging) throw new MergeError("conflict", 409);
  merging = true;
  try {
    return await doMerge(vault, o);
  } finally {
    merging = false;
  }
}

async function doMerge(vault: MergeVault, o: { canonicalId: string; secondaryId: string; dryRun: boolean; by: string; now?: number }): Promise<MergeReport> {
  const load = async (id: string): Promise<Note> => {
    try {
      return await vault.getNote(id, { includeLinks: true });
    } catch (e) {
      if (statusOf(e) === 404) throw new MergeError("not_found", 404);
      throw e;
    }
  };
  const c = await load(o.canonicalId);
  const s = await load(o.secondaryId);
  if (c.id === s.id) throw new MergeError("same_person", 400);
  for (const n of [c, s]) {
    if (!(n.tags ?? []).includes("person")) throw new MergeError("not_a_person", 400);
    if (isNonHumanPerson(n)) throw new MergeError("non_human", 400);
  }
  if (isTombstone(c)) throw new MergeError("canonical_is_merged", 409);
  let resumed = false;
  if (isTombstone(s)) {
    const ref = mergedIntoRef(s);
    if (!ref || (ref !== c.id && ref.toLowerCase() !== (c.path ?? "").toLowerCase())) throw new MergeError("secondary_merged_elsewhere", 409);
    resumed = true;
  }

  const rep: MergeReport = {
    dryRun: o.dryRun,
    canonicalId: c.id,
    secondaryId: s.id,
    resumed,
    identities: {},
    bodyAppended: false,
    outbound: 0,
    inbound: 0,
    alreadyPresent: 0,
    notesToWrite: 0,
    notesWritten: 0,
    conflicts: 0,
    errors: 0,
    tombstoned: false,
    complete: false,
  };

  // ── plan ──
  const union = unionIdentities(c, s);
  rep.identities = union.moved;
  const body = bodyBeyondHeading(s.content ?? "");
  const marker = mergeMarker(s.id);
  const appendBody = body.length > 0 && !(c.content ?? "").includes(marker);
  rep.bodyAppended = appendBody;

  const cAdd: NoteLinkInput[] = [];
  const cRemove: NoteLinkInput[] = [];
  const sRemove: NoteLinkInput[] = [];
  const inbound = new Map<string, { add: NoteLinkInput[]; remove: NoteLinkInput[] }>();
  const seen = new Set<string>();
  for (const l of s.links ?? []) {
    const k = `${l.sourceId}\u0000${l.targetId}\u0000${l.relationship}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const managed = VAULT_MANAGED.has(l.relationship);
    const rel = managed ? REL.REFERENCES : l.relationship;
    if (l.sourceId === s.id) {
      if (l.targetId === c.id) {
        if (!managed) sRemove.push({ target: c.id, relationship: l.relationship });
        continue;
      }
      rep.outbound++;
      if (hasOut(c, l.targetId, rel)) rep.alreadyPresent++;
      else if (!cAdd.some((x) => x.target === l.targetId && x.relationship === rel)) cAdd.push({ target: l.targetId, relationship: rel });
      if (!managed) sRemove.push({ target: l.targetId, relationship: l.relationship });
    } else if (l.targetId === s.id) {
      if (l.sourceId === c.id) {
        if (!managed) cRemove.push({ target: s.id, relationship: l.relationship });
        continue;
      }
      rep.inbound++;
      const op = inbound.get(l.sourceId) ?? { add: [], remove: [] };
      const exists = (c.links ?? []).some((x) => x.sourceId === l.sourceId && x.targetId === c.id && x.relationship === rel);
      if (exists) rep.alreadyPresent++;
      else if (!op.add.some((x) => x.relationship === rel)) op.add.push({ target: c.id, relationship: rel });
      if (!managed) op.remove.push({ target: s.id, relationship: l.relationship });
      if (op.add.length || op.remove.length) inbound.set(l.sourceId, op);
    }
  }

  const at = new Date(o.now ?? Date.now()).toISOString();
  const cPatch: Parameters<MergeVault["updateNote"]>[1] = {};
  if (union.patch || appendBody) {
    const history = Array.isArray(c.metadata?.prism_merge_history) ? (c.metadata!.prism_merge_history as unknown[]) : [];
    const already = history.some((h) => (h as { secondaryId?: string })?.secondaryId === s.id);
    cPatch.metadata = { ...(union.patch ?? {}), ...(already ? {} : { prism_merge_history: [...history.slice(-49), { secondaryId: s.id, at, by: o.by }] }) };
  }
  if (appendBody) cPatch.content = `${(c.content ?? "").trimEnd()}\n\n## Merged from ${s.path ?? s.id} (${at.slice(0, 10)})\n\n${marker}\n\n${body}\n`;
  if (cAdd.length || cRemove.length) cPatch.links = { ...(cAdd.length ? { add: cAdd } : {}), ...(cRemove.length ? { remove: cRemove } : {}) };
  const canonicalWrite = Object.keys(cPatch).length > 0;

  const strip = stripIdentityPatch(s);
  const sMeta: Record<string, unknown> = { ...strip.patch };
  if (!resumed) Object.assign(sMeta, { merged_into: c.path ?? c.id, status: "merged_into_canonical", merged_at: at, merged_by: o.by });
  if (Object.keys(strip.kept).length) sMeta.prism_merged_identities = strip.kept;
  const needsTag = !(s.tags ?? []).includes("merged-stub");
  const secondaryWrite = Object.keys(sMeta).length > 0 || sRemove.length > 0 || needsTag;

  rep.notesToWrite = (canonicalWrite ? 1 : 0) + inbound.size + (secondaryWrite ? 1 : 0);
  if (o.dryRun) {
    rep.complete = rep.notesToWrite === 0;
    return rep;
  }

  // ── apply: canonical → inbound sources → secondary ──
  const write = async (id: string, p: Parameters<MergeVault["updateNote"]>[1], updatedAt: string | null): Promise<boolean> => {
    try {
      await vault.updateNote(id, { ...p, ...(updatedAt ? { ifUpdatedAt: updatedAt } : {}) });
      rep.notesWritten++;
      return true;
    } catch (e) {
      const st = statusOf(e);
      if (st === 409 || st === 428) rep.conflicts++;
      else rep.errors++;
      return false;
    }
  };
  if (canonicalWrite && !(await write(c.id, cPatch, c.updatedAt))) return rep; // nothing else moved: retry is clean

  if (inbound.size) {
    // One lean listing for the linking notes' versions (never their content).
    const all = await vault.listNotes({ includeMetadata: ["type"], limit: 50_000 });
    if (all.length >= 50_000) throw new MergeError("inventory_limit", 503);
    const stamp = new Map(all.map((n) => [n.id, n.updatedAt]));
    for (const [id, op] of inbound) {
      if (!stamp.has(id)) {
        rep.errors++;
        continue;
      }
      await write(id, { links: { ...(op.add.length ? { add: op.add } : {}), ...(op.remove.length ? { remove: op.remove } : {}) } }, stamp.get(id) ?? null);
    }
  }
  if (secondaryWrite) {
    rep.tombstoned = await write(
      s.id,
      { ...(Object.keys(sMeta).length ? { metadata: sMeta } : {}), ...(sRemove.length ? { links: { remove: sRemove } } : {}), ...(needsTag ? { tags: { add: ["merged-stub"] } } : {}) },
      s.updatedAt,
    );
  } else rep.tombstoned = true;
  rep.complete = rep.conflicts === 0 && rep.errors === 0;
  return rep;
}
