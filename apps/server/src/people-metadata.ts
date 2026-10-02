/**
 * Metadata edits on person notes for the identity layer: add ONE identity key
 * (review-queue resolve) and union one person's identities into another (merge).
 *
 * Every function returns a JSON-merge-patch DELTA (or null when nothing would
 * change) — never the whole metadata object — and never overwrites an existing
 * value: a second address goes NEXT to the first, a scalar the canonical person
 * already has is kept. Field shapes follow what the vault already holds:
 * `channels.email` is an array, `channels.<network>` a string that becomes an
 * array when a second id arrives, `aliases` / `organizations` keep their current
 * type (the person schema says array; ~750 hand-written notes hold a string).
 */
import type { Note } from "./parachute";
import { aliasList, cleanName, matrixKeys, normalizeEmailKey, normalizePhone, personKeys, slugKey, telegramKeys, type IdentityKey, type NameKey } from "./identity";

/** The metadata keys a lean `person` listing needs for identity work. */
export const PERSON_IDENTITY_KEYS = [
  "name", "title", "aliases", "alias", "email", "emails", "contact", "contact_emails", "channels", "matrix", "matrixId", "matrixRoomIds",
  "telegram", "phone", "type", "status", "merged_into", "superseded_by", "organizations", "organization", "projects",
];

const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const nonEmpty = (v: unknown): boolean => (typeof v === "string" ? v.trim() !== "" : Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null);

/** Union onto a channel value: absent → the value; string → [string, value]; array → appended. */
function unionValue(existing: unknown, add: string[], same: (a: string, b: string) => boolean): unknown | undefined {
  const cur = strings(existing).filter((s) => s.trim());
  const fresh = add.filter((a, i) => !cur.some((c) => same(c, a)) && add.findIndex((b) => same(a, b)) === i);
  if (!fresh.length) return undefined;
  if (!cur.length && fresh.length === 1 && !Array.isArray(existing)) return fresh[0];
  return [...cur, ...fresh];
}

const ci = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Union a name list, keeping the field's current type (CSV string or array). */
function unionNames(existing: unknown, add: string[]): unknown | undefined {
  const cur = aliasList(existing);
  const have = new Set(cur.map(slugKey));
  const fresh: string[] = [];
  for (const a of add.map(cleanName)) {
    const k = slugKey(a);
    if (!k || have.has(k)) continue;
    have.add(k);
    fresh.push(a);
  }
  if (!fresh.length) return undefined;
  return typeof existing === "string" ? [...cur, ...fresh].join(", ") : [...cur, ...fresh];
}

/**
 * The patch that makes `note` claim one key, or null when it already does (or
 * the kind can't be stored: a bridge `handle` only exists inside a Matrix id).
 * `display` is the name as seen, for a name key (stored as an alias).
 */
export function addKeyPatch(note: Note, key: IdentityKey | NameKey, display?: string | null): Record<string, unknown> | null {
  const md = note.metadata ?? {};
  const ch = obj(md.channels);
  const mine = personKeys(note);
  if (key.kind === "name") {
    if (mine.names.includes(key.value)) return null;
    const alias = cleanName(display ?? "") || key.value;
    if (slugKey(alias) !== key.value) return null;
    const next = unionNames(md.aliases, [alias]);
    return next === undefined ? null : { aliases: next };
  }
  if (mine.strong.some((k) => k.kind === key.kind && k.value === key.value)) return null;
  switch (key.kind) {
    case "email": {
      const next = unionValue(ch.email, [normalizeEmailKey(key.value)], ci);
      return next === undefined ? null : { channels: { email: Array.isArray(next) ? next : [next] } };
    }
    case "matrix": {
      const next = unionValue(ch.matrix, [key.value], ci);
      return next === undefined ? null : { channels: { matrix: next } };
    }
    case "telegram": {
      const stored = key.value.startsWith("@") ? key.value : `telegram_${key.value}`;
      const next = unionValue(ch.telegram, [stored], ci);
      return next === undefined ? null : { channels: { telegram: next } };
    }
    case "phone": {
      if (!nonEmpty(md.phone)) return { phone: `+${key.value}` };
      const next = unionValue(ch.phone, [`+${key.value}`], (a, b) => normalizePhone(a) === normalizePhone(b));
      return next === undefined ? null : { channels: { phone: next } };
    }
    default:
      return null;
  }
}

export interface MergeUnion {
  /** Merge-patch for the canonical note (null = nothing to add). */
  patch: Record<string, unknown> | null;
  /** What moved, by KIND only (for the report / audit — never values). */
  moved: Record<string, number>;
}

/**
 * Everything `secondary` knows that `canonical` does not: addresses, Matrix /
 * bridge ids, telegram, phone, the secondary's own names as aliases,
 * organizations and projects. Existing canonical values are never replaced.
 */
export function unionIdentities(canonical: Note, secondary: Note): MergeUnion {
  const cm = canonical.metadata ?? {};
  const sm = secondary.metadata ?? {};
  const cch = obj(cm.channels);
  const sch = obj(sm.channels);
  const have = personKeys(canonical);
  const hasKey = (k: IdentityKey) => have.strong.some((x) => x.kind === k.kind && x.value === k.value);
  const patch: Record<string, unknown> = {};
  const channels: Record<string, unknown> = {};
  const moved: Record<string, number> = {};
  const count = (kind: string, n: number) => {
    if (n > 0) moved[kind] = (moved[kind] ?? 0) + n;
  };

  // Emails (every field shape on the secondary) → channels.email on the canonical.
  const emails = personKeys(secondary).strong.filter((k) => k.kind === "email" && !hasKey(k)).map((k) => k.value);
  if (emails.length) {
    const next = unionValue(cch.email, emails, ci);
    if (next !== undefined) {
      channels.email = Array.isArray(next) ? next : [next];
      count("email", emails.length);
    }
  }
  // Matrix + bridge ids, channel by channel (the same puppet id often sits under
  // both `matrix` and its network key).
  const sourceChannels: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sch)) if (k !== "email" && k !== "phone") sourceChannels[k] = strings(v);
  sourceChannels.matrix = [...(sourceChannels.matrix ?? []), ...strings(sm.matrix), ...strings(sm.matrixId)];
  for (const [k, vals] of Object.entries(sourceChannels)) {
    // A Matrix-shaped id is new when the canonical claims none of its keys
    // (wherever it stores them); anything else is compared as plain text.
    const fresh = vals.filter((v) => {
      if (!v.trim()) return false;
      const keys = matrixKeys(v);
      return keys.length ? !keys.some(hasKey) : true;
    });
    if (!fresh.length) continue;
    const next = unionValue(cch[k], fresh, ci);
    if (next === undefined) continue;
    channels[k] = next;
    count(k === "matrix" ? "matrix" : `channel:${k}`, strings(next).length - strings(cch[k]).filter((x) => x.trim()).length);
  }
  // Telegram / phone scalars: fill an empty field, else keep both in channels.
  const tg = strings(sm.telegram).filter((t) => t.trim() && telegramKeys(t).some((k) => !hasKey(k)));
  if (tg.length) {
    if (!nonEmpty(cm.telegram) && channels.telegram === undefined && !nonEmpty(cch.telegram)) patch.telegram = tg[0];
    else {
      const next = unionValue(channels.telegram ?? cch.telegram, tg, ci);
      if (next !== undefined) channels.telegram = next;
    }
    count("telegram", tg.length);
  }
  const phones = [...strings(sm.phone), ...strings(sch.phone)].filter((p) => {
    const d = normalizePhone(p);
    return d !== null && !hasKey({ kind: "phone", value: d });
  });
  if (phones.length) {
    if (!nonEmpty(cm.phone)) patch.phone = phones[0];
    const rest = nonEmpty(cm.phone) ? phones : phones.slice(1);
    const next = rest.length ? unionValue(cch.phone, rest, (a, b) => normalizePhone(a) === normalizePhone(b)) : undefined;
    if (next !== undefined) channels.phone = next;
    count("phone", phones.length);
  }
  if (Object.keys(channels).length) patch.channels = channels;

  // The secondary's names become aliases of the canonical (addresses excluded).
  const names = [...strings(sm.name), ...strings(sm.title), ...aliasList(sm.aliases), ...aliasList(sm.alias)].filter((n) => !(n.includes("@") && !n.includes(" ")));
  const known = new Set(have.names);
  const freshNames = names.filter((n) => slugKey(cleanName(n)) && !known.has(slugKey(cleanName(n))));
  const aliases = unionNames(cm.aliases, freshNames);
  if (aliases !== undefined) {
    patch.aliases = aliases;
    count("alias", strings(aliases).length ? freshNames.length : 0);
  }
  for (const field of ["organizations", "projects"] as const) {
    const add = [...aliasListKeepLinks(sm[field]), ...(field === "organizations" ? [...aliasListKeepLinks(sm.organization), ...aliasListKeepLinks(sm.org)] : [])];
    if (!add.length) continue;
    const cur = aliasListKeepLinks(cm[field]);
    const seen = new Set(cur.map((s) => slugKey(s)));
    const fresh = add.filter((a) => slugKey(a) && !seen.has(slugKey(a)) && seen.add(slugKey(a)));
    if (!fresh.length) continue;
    patch[field] = typeof cm[field] === "string" ? [...cur, ...fresh].join(", ") : [...cur, ...fresh];
    count(field, fresh.length);
  }
  return { patch: Object.keys(patch).length ? patch : null, moved };
}

/** Split a CSV/array list field but keep `[[wikilinks]]` intact. */
function aliasListKeepLinks(v: unknown): string[] {
  return strings(v)
    .flatMap((s) => (s.includes("[[") ? (s.match(/\[\[[^\]]*\]\]|[^,;\n]+/g) ?? []) : s.split(/[,;\n]/)))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The merge-patch that removes every identity key from a tombstoned note. */
export function stripIdentityPatch(note: Note): { patch: Record<string, unknown>; kept: Record<string, unknown> } {
  const md = note.metadata ?? {};
  const patch: Record<string, unknown> = {};
  const kept: Record<string, unknown> = {};
  for (const k of ["email", "emails", "contact_emails", "matrix", "matrixId", "matrixRoomIds", "telegram", "phone"]) {
    if (nonEmpty(md[k])) {
      kept[k] = md[k];
      patch[k] = null;
    }
  }
  if (typeof md.contact === "string" && (md.contact.includes("@") || normalizePhone(md.contact))) {
    kept.contact = md.contact;
    patch.contact = null;
  }
  const ch = obj(md.channels);
  const cp: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ch)) if (nonEmpty(v)) cp[k] = null;
  if (Object.keys(cp).length) {
    kept.channels = ch;
    patch.channels = cp;
  }
  return { patch, kept };
}
