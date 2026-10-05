/**
 * "Assigned to me" for `/api/query` (wave 3, Home → My tasks).
 *
 * Who the caller IS, as tasks name people:
 *  - the SERVER OWNER: the person note in the identity layer's owner setting
 *    (`people-owner.ts`: stored per vault, else `PEOPLE_OWNER_*`), its configured
 *    extra addresses and first-name aliases — the same identity the linking job
 *    uses for `assigned-to`;
 *  - everyone else: the live human person note(s) whose EMAIL identity is the
 *    caller's own account email.
 * A task is assigned to the caller when one of its `assigned` / `assignee` /
 * `assigneeEmail` / `assignee_email` values is one of the caller's addresses, a
 * `[[wikilink]]`/path to their person note, or their person note's name (or, for
 * the owner, a configured alias). An account's self-chosen display name is NOT
 * used. This only ever NARROWS rows the caller may already view.
 */
import { config } from "./config";
import type { VaultEntry } from "./config";
import type { Actor } from "./auth/actor";
import { vaultClient, type Note } from "./parachute";
import { isNonHumanPerson, isTombstone } from "./identity";
import { ownerSettings } from "./people-owner";

export interface MyIdentity {
  emails: Set<string>;
  /** Lower-cased full names / aliases. */
  names: Set<string>;
  /** Lower-cased person note ids, paths and path leaves. */
  refs: Set<string>;
  /** Whether a person note was found for the caller. */
  person: boolean;
  /** The SERVER OWNER with no owner identity configured (no person note found, no
   *  alias): tasks cannot be told apart, so the caller keeps the unfiltered list. */
  ownerUnset: boolean;
}

const PERSON_KEYS = ["name", "email", "emails", "contact", "channels", "status", "type"];
/** Live human person notes carrying `email` (lean, cached 60 s) — ids only. */
export async function personNotesForEmail(entry: VaultEntry, email: string): Promise<string[]> {
  const want = email.trim().toLowerCase();
  return (await people(entry)).filter((n) => !isTombstone(n) && !isNonHumanPerson(n) && personEmails(n).includes(want)).map((n) => n.id);
}
const TTL_MS = 60_000;
const cache = new Map<string, { expires: number; value: Promise<Note[]> }>();
export function resetMyTasksForTests(): void {
  cache.clear();
}

function people(entry: VaultEntry): Promise<Note[]> {
  const hit = cache.get(entry.id);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = vaultClient(entry.id, { timeoutMs: 15_000 }).listNotes({ tags: ["person"], includeContent: false, includeMetadata: PERSON_KEYS });
  cache.set(entry.id, { expires: Date.now() + TTL_MS, value });
  value.catch(() => { if (cache.get(entry.id)?.value === value) cache.delete(entry.id); });
  return value;
}

const lower = (s: string) => s.trim().toLowerCase();
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const EMAIL = /^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,255}$/;
/** Addresses on a person note (single values, lists, comma/space separated strings). Linear. */
function personEmails(n: Note): string[] {
  const md = n.metadata ?? {};
  const channels = md.channels && typeof md.channels === "object" && !Array.isArray(md.channels) ? (md.channels as Record<string, unknown>).email : undefined;
  const out: string[] = [];
  for (const raw of [...strings(md.email), ...strings(md.emails), ...strings(md.contact), ...strings(channels)]) {
    for (const part of raw.split(/[\s,;<>]+/)) if (part.length <= 320 && EMAIL.test(part)) out.push(lower(part));
  }
  return out;
}
const leafOf = (path: string | null | undefined) => (path ?? "").split("/").pop()!.replace(/\.md$/i, "");

export async function myIdentity(actor: Actor, entry: VaultEntry): Promise<MyIdentity> {
  const me: MyIdentity = { emails: new Set(), names: new Set(), refs: new Set(), person: false, ownerUnset: false };
  if (actor.kind !== "user") return me;
  me.emails.add(lower(actor.email));
  const isServerOwner = !!config.ownerEmail && lower(actor.email) === lower(config.ownerEmail);
  const owner = isServerOwner ? ownerSettings(entry.id) : null;
  if (owner) {
    for (const e of owner.emails) me.emails.add(lower(e));
    for (const a of owner.aliases) if (a.trim()) me.names.add(lower(a));
  }
  let list: Note[];
  try {
    list = await people(entry);
  } catch {
    me.ownerUnset = !!owner && me.names.size === 0;
    return me; // the vault is busy: addresses still match
  }
  const ownerRef = owner?.person ? lower(owner.person.replace(/\.md$/i, "")) : "";
  for (const n of list) {
    if (isTombstone(n) || isNonHumanPerson(n)) continue;
    const path = lower((n.path ?? "").replace(/\.md$/i, ""));
    const mine = ownerRef ? n.id.toLowerCase() === ownerRef || path === ownerRef : personEmails(n).some((e) => me.emails.has(e));
    if (!mine) continue;
    me.person = true;
    me.refs.add(n.id.toLowerCase());
    if (path) me.refs.add(path);
    const leaf = lower(leafOf(n.path));
    if (leaf) { me.refs.add(leaf); me.names.add(leaf); }
    const name = typeof n.metadata?.name === "string" ? lower(n.metadata.name) : "";
    if (name) me.names.add(name);
    if (owner) for (const e of personEmails(n)) me.emails.add(e);
  }
  me.ownerUnset = !!owner && !me.person && me.names.size === 0;
  return me;
}

/** One stored people value → the people it names: CSV, " & ", " and ", wikilinks kept whole (as the linking job reads them). */
export function peopleValues(value: unknown): string[] {
  const out: string[] = [];
  for (const s of strings(value)) {
    if (s.length > 2000) continue;
    for (const part of s.split(/[,;&]/)) for (const v of part.includes("[[") ? [part] : part.split(/\s+and\s+/i)) if (v.trim()) out.push(v.trim());
  }
  return out.slice(0, 20);
}
/** `assigned` values of a task (the four assignee keys). */
function assigneeValues(md: Record<string, unknown>): string[] {
  return [md.assigned, md.assignee, md.assigneeEmail, md.assignee_email].flatMap(peopleValues).slice(0, 20);
}

/**
 * The INVERSE of `assignedToMe` (assignment notifications): the addresses the
 * people named by `values` could sign in with — the same identity rules, read the
 * other way round. A value is
 *  - an address → that address (one of the owner's configured addresses → the
 *    server owner's account address);
 *  - a `[[wikilink]]` / path / id of a live human person note → that note's email
 *    identities (the owner's configured person note → the server owner);
 *  - a name → the email identities of the ONE live human person note with that
 *    name or file name (two people with one name → nobody: a notification is not
 *    a guess), or the server owner for a configured alias.
 * An account's self-chosen display name is NOT used. The caller keeps only the
 * addresses that are accounts. Linear in the people listing (cached 60 s).
 */
export async function assigneeAddresses(entry: VaultEntry, values: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!values.length) return out;
  const ownerEmail = config.ownerEmail ? lower(config.ownerEmail) : "";
  const owner = ownerSettings(entry.id);
  const ownerAddresses = new Set(owner.emails.map(lower));
  const ownerAliases = new Set(owner.aliases.map(lower).filter(Boolean));
  const ownerRef = owner.person ? lower(owner.person.replace(/\.md$/i, "")) : "";
  let list: Note[] = [];
  try {
    list = await people(entry);
  } catch {
    /* the vault is busy: addresses still resolve */
  }
  const byRef = new Map<string, Note>();
  const byName = new Map<string, Note[]>();
  for (const n of list) {
    if (isTombstone(n) || isNonHumanPerson(n)) continue;
    const path = lower((n.path ?? "").replace(/\.md$/i, ""));
    byRef.set(n.id.toLowerCase(), n);
    if (path) byRef.set(path, n);
    const names = new Set([lower(leafOf(n.path)), typeof n.metadata?.name === "string" ? lower(n.metadata.name) : ""]);
    for (const name of names) if (name) byName.set(name, [...(byName.get(name) ?? []), n]);
  }
  const take = (n: Note) => {
    for (const e of personEmails(n)) out.add(e);
    const path = lower((n.path ?? "").replace(/\.md$/i, ""));
    if (ownerEmail && ownerRef && (n.id.toLowerCase() === ownerRef || path === ownerRef)) out.add(ownerEmail);
  };
  const byNameOne = (name: string) => {
    const hits = byName.get(name) ?? [];
    return hits.length === 1 ? hits[0]! : null;
  };
  for (const v of values.slice(0, 40)) {
    const open = v.indexOf("[[");
    if (open >= 0) {
      const close = v.indexOf("]]", open + 2);
      if (close < 0) continue;
      const target = lower(v.slice(open + 2, close).split("|")[0]!.replace(/\.md$/i, ""));
      const n = byRef.get(target) ?? byNameOne(target);
      if (n) take(n);
      continue;
    }
    const value = lower(v);
    if (value.includes("@")) {
      if (value.length <= 320 && EMAIL.test(value)) out.add(ownerEmail && ownerAddresses.has(value) ? ownerEmail : value);
      continue;
    }
    const n = byRef.get(value.replace(/\.md$/i, "")) ?? byNameOne(value);
    if (n) take(n);
    if (ownerEmail && ownerAliases.has(value)) out.add(ownerEmail);
  }
  return out;
}

export function assignedToMe(metadata: Record<string, unknown> | null | undefined, me: MyIdentity): boolean {
  for (const v of assigneeValues(metadata ?? {})) {
    const open = v.indexOf("[[");
    if (open >= 0) {
      const close = v.indexOf("]]", open + 2);
      if (close < 0) continue;
      const target = lower(v.slice(open + 2, close).split("|")[0]!.replace(/\.md$/i, ""));
      if (me.refs.has(target)) return true;
      continue;
    }
    const value = lower(v);
    if (value.includes("@") ? me.emails.has(value) : me.names.has(value) || me.refs.has(value.replace(/\.md$/i, ""))) return true;
  }
  return false;
}
