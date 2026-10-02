/**
 * Metadata edits on person notes for the identity layer: add ONE identity key
 * (review-queue resolve, the `owner` job phase) and union one person's
 * identities into another (merge).
 *
 * RULES (security review H2):
 *   - APPEND-ONLY. An existing value is never re-serialized, re-ordered, split
 *     or replaced: a new entry goes after what is there. An `aliases` string
 *     stays that exact string with `, new` appended; an array keeps its entries
 *     verbatim ("Acme, Inc." stays one entry, "Dr. Morgan (she/her)" unchanged).
 *   - A field whose existing value has an UNEXPECTED TYPE (a number where a
 *     string or list is expected, an object, a mixed array) is skipped and
 *     reported in `skipped` — never overwritten.
 *   - Every nested write sends the COMPLETE object for its top-level key
 *     (`channels: {...all existing keys, changed key}`), built from the note
 *     that was just read and written under `if_updated_at`. It is therefore
 *     correct whether the vault deep-merges nested metadata (RFC 7386) or
 *     replaces the top-level key. A removed nested key is sent as `null`
 *     inside that complete object (deleted under deep merge; under a shallow
 *     merge it is stored as a literal null, which every reader ignores).
 *   - Stripping a tombstone removes only keys the canonical note VERIFIABLY
 *     holds now; anything it could not read (a non-string channel, a `contact`
 *     that is prose, `matrixRoomIds`) stays where it is.
 */
import type { Note } from "./parachute";
import { aliasList, looksLikeEmail, matrixKeys, normalizeEmailKey, normalizePhone, personKeys, slugKey, telegramKeys, type IdentityKey, type NameKey } from "./identity";

/** The metadata keys a lean `person` listing needs for identity work. */
export const PERSON_IDENTITY_KEYS = [
  "name", "aliases", "alias", "email", "emails", "contact", "contact_emails", "channels", "matrix", "matrixId", "matrixRoomIds",
  "telegram", "phone", "type", "status", "merged_into", "mergedInto", "superseded_by", "organizations", "organization", "projects",
  // this module's own merge marker (which stubs a canonical absorbed)
  "prism_merge_history",
];

const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

type Shape = "absent" | "string" | "strings" | "other";
function shapeOf(v: unknown): Shape {
  if (v === undefined || v === null || v === "") return "absent";
  if (typeof v === "string") return "string";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return "strings";
  return "other";
}

const ci = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * `existing` with `fresh` appended. `undefined` = nothing to add; `"skip"` = the
 * existing value has a type this code will not touch. Existing entries are
 * carried over untouched and in order.
 */
function appendValues(existing: unknown, fresh: string[], same: (a: string, b: string) => boolean, forceArray = false): unknown | "skip" | undefined {
  const shape = shapeOf(existing);
  if (shape === "other") return fresh.length ? "skip" : undefined;
  const cur = shape === "absent" ? [] : shape === "string" ? [existing as string] : (existing as string[]);
  const add: string[] = [];
  for (const f of fresh) if (f.trim() && !cur.some((c) => same(c, f)) && !add.some((a) => same(a, f))) add.push(f);
  if (!add.length) return undefined;
  if (shape === "absent" && add.length === 1 && !forceArray) return add[0];
  return [...cur, ...add];
}

const DELIMS = /[,;\n|]/;

/** Append names to a list field, keeping its type and every existing character. */
function appendNames(existing: unknown, fresh: string[]): unknown | "skip" | undefined {
  const shape = shapeOf(existing);
  if (shape === "other") return fresh.length ? "skip" : undefined;
  const have = new Set<string>();
  if (shape === "string") {
    have.add(slugKey(existing as string));
    for (const part of aliasList(existing)) have.add(slugKey(part));
  } else if (shape === "strings") for (const e of existing as string[]) have.add(slugKey(e));
  const add: string[] = [];
  for (const f of fresh.map((x) => x.trim())) {
    const k = slugKey(f);
    if (!k || have.has(k)) continue;
    // A value with a delimiter cannot be appended to a CSV string without changing what it means.
    if (shape === "string" && DELIMS.test(f)) return "skip";
    have.add(k);
    add.push(f);
  }
  if (!add.length) return undefined;
  if (shape === "string") return `${existing as string}, ${add.join(", ")}`;
  return [...(shape === "strings" ? (existing as string[]) : []), ...add];
}

export interface KeyPatch {
  /** Merge-patch for the note, or null when nothing would change. */
  patch: Record<string, unknown> | null;
  /** The field that was left alone because its current value has an unexpected type. */
  skipped: string | null;
}

/**
 * The patch that makes `note` claim one key. `patch: null` when it already does,
 * the kind can't be stored (a bridge `handle` only exists inside a Matrix id), or
 * the target field was skipped. `display` is the name as seen, for a name key.
 */
export function addKeyPatch(note: Note, key: IdentityKey | NameKey, display?: string | null): KeyPatch {
  const md = note.metadata ?? {};
  const ch = obj(md.channels);
  const mine = personKeys(note);
  const none: KeyPatch = { patch: null, skipped: null };
  const channel = (k: string, next: unknown | "skip" | undefined): KeyPatch => {
    if (next === undefined) return none;
    if (next === "skip") return { patch: null, skipped: `channels.${k}` };
    if (md.channels !== undefined && shapeOf(md.channels) !== "absent" && (typeof md.channels !== "object" || Array.isArray(md.channels))) return { patch: null, skipped: "channels" };
    return { patch: { channels: { ...ch, [k]: next } }, skipped: null };
  };
  if (key.kind === "name") {
    if (mine.names.includes(key.value) || mine.aliases.includes(key.value)) return none;
    const alias = (display ?? "").trim();
    if (!alias || slugKey(alias) !== key.value) return none;
    const next = appendNames(md.aliases, [alias]);
    return next === undefined ? none : next === "skip" ? { patch: null, skipped: "aliases" } : { patch: { aliases: next }, skipped: null };
  }
  if (mine.strong.some((k) => k.kind === key.kind && k.value === key.value)) return none;
  switch (key.kind) {
    case "email":
      return channel("email", appendValues(ch.email, [normalizeEmailKey(key.value)], ci, true));
    case "matrix":
      return channel("matrix", appendValues(ch.matrix, [key.value], ci));
    case "telegram":
      return channel("telegram", appendValues(ch.telegram, [key.value.startsWith("@") ? key.value : `telegram_${key.value}`], ci));
    case "phone": {
      if (shapeOf(md.phone) === "absent") return { patch: { phone: `+${key.value}` }, skipped: null };
      return channel("phone", appendValues(ch.phone, [`+${key.value}`], (a, b) => normalizePhone(a) === normalizePhone(b)));
    }
    default:
      return none;
  }
}

export interface MergeUnion {
  /** Merge-patch for the canonical note (null = nothing to add). */
  patch: Record<string, unknown> | null;
  /** What moved, by kind (counts only — for the report / audit). */
  moved: Record<string, number>;
  /** Fields left alone because a value had an unexpected type or shape. */
  skipped: string[];
}

/** A list field's entries, verbatim: array items as they are, a string as ONE entry. */
const entries = (v: unknown): string[] => (typeof v === "string" ? (v.trim() ? [v.trim()] : []) : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/**
 * Everything `secondary` knows that `canonical` does not: addresses, Matrix /
 * bridge ids, telegram, phone, the secondary's own names as aliases,
 * organizations and projects. Append-only (see the file header).
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
  const skipped: string[] = [];
  const count = (kind: string, n: number) => {
    if (n > 0) moved[kind] = (moved[kind] ?? 0) + n;
  };
  const lenOf = (v: unknown) => strings(v).filter((x) => x.trim()).length;
  const setChannel = (k: string, fresh: string[], same: (a: string, b: string) => boolean, kind: string, forceArray = false) => {
    if (!fresh.length) return;
    const next = appendValues(k in channels ? channels[k] : cch[k], fresh, same, forceArray);
    if (next === undefined) return;
    if (next === "skip") {
      skipped.push(`channels.${k}`);
      return;
    }
    count(kind, lenOf(next) - lenOf(k in channels ? channels[k] : cch[k]));
    channels[k] = next;
  };

  // Addresses, from every field shape on the secondary → channels.email.
  setChannel("email", personKeys(secondary).strong.filter((k) => k.kind === "email" && !hasKey(k)).map((k) => k.value), ci, "email", true);

  // Matrix + bridge ids, channel by channel. A Matrix-shaped id is new when the
  // canonical claims none of its keys (wherever it stores them).
  const fromChannels: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sch)) {
    if (k === "email" || k === "phone" || k === "telegram") continue;
    if (shapeOf(v) === "other") skipped.push(`secondary channels.${k}`);
    else fromChannels[k] = strings(v);
  }
  fromChannels.matrix = [...(fromChannels.matrix ?? []), ...strings(sm.matrix), ...strings(sm.matrixId)];
  for (const [k, vals] of Object.entries(fromChannels)) {
    const fresh = vals.filter((v) => {
      if (!v.trim()) return false;
      const keys = matrixKeys(v);
      return keys.length ? !keys.some(hasKey) : true;
    });
    setChannel(k, fresh, ci, k === "matrix" ? "matrix" : `channel:${k}`);
  }

  // Telegram: fill an empty top-level field, else keep it beside the existing one.
  const tgRaw = [...(typeof sm.telegram === "number" ? [String(sm.telegram)] : strings(sm.telegram)), ...(typeof sch.telegram === "number" ? [String(sch.telegram)] : strings(sch.telegram))];
  const tg = tgRaw.filter((t) => telegramKeys(t).length > 0 && telegramKeys(t).some((k) => !hasKey(k)));
  if (tg.length) {
    if (shapeOf(cm.telegram) === "absent" && shapeOf(cch.telegram) === "absent") {
      patch.telegram = tg[0];
      count("telegram", 1);
      setChannel("telegram", tg.slice(1), ci, "telegram");
    } else setChannel("telegram", tg, ci, "telegram");
  }
  const samePhone = (a: string, b: string) => normalizePhone(a) !== null && normalizePhone(a) === normalizePhone(b);
  const phones = [...strings(sm.phone), ...strings(sch.phone)].filter((p) => {
    const d = normalizePhone(p);
    return d !== null && !hasKey({ kind: "phone", value: d });
  });
  if (phones.length) {
    if (shapeOf(cm.phone) === "absent") {
      patch.phone = phones[0];
      count("phone", 1);
      setChannel("phone", phones.slice(1), samePhone, "phone");
    } else setChannel("phone", phones, samePhone, "phone");
  }
  if (Object.keys(channels).length) {
    if (cm.channels !== undefined && cm.channels !== null && (typeof cm.channels !== "object" || Array.isArray(cm.channels))) skipped.push("channels");
    else patch.channels = { ...cch, ...channels }; // the COMPLETE object — right under deep or shallow merge
  }

  // The secondary's names become aliases of the canonical (addresses excluded).
  const known = new Set([...have.names, ...have.aliases]);
  const names = [...strings(sm.name), ...strings(sm.aliases).flatMap((s) => (Array.isArray(sm.aliases) ? [s] : s.split(/[,;\n]/))), ...strings(sm.alias)]
    .map((n) => n.trim())
    .filter((n) => n && !looksLikeEmail(n) && !known.has(slugKey(n)));
  const aliases = appendNames(cm.aliases, names);
  if (aliases === "skip") skipped.push("aliases");
  else if (aliases !== undefined) {
    patch.aliases = aliases;
    count("alias", typeof aliases === "string" ? aliasList(aliases).length - aliasList(cm.aliases).length : (aliases as string[]).length - strings(cm.aliases).length);
  }
  for (const field of ["organizations", "projects"] as const) {
    const add = [...entries(sm[field]), ...(field === "organizations" ? [...entries(sm.organization), ...entries(sm.org)] : [])];
    if (!add.length) continue;
    const next = appendNames(cm[field], add);
    if (next === "skip") skipped.push(field);
    else if (next !== undefined) {
      patch[field] = next;
      count(field, 1);
    }
  }
  return { patch: Object.keys(patch).length ? patch : null, moved, skipped };
}

/** The identity keys one stored value states, or null when it can't be read as keys. */
function keysOfValue(field: string, v: unknown): IdentityKey[] | null {
  const vals = typeof v === "number" && field.endsWith("telegram") ? [String(v)] : shapeOf(v) === "string" || shapeOf(v) === "strings" ? strings(v) : null;
  if (!vals || !vals.length) return null;
  const out: IdentityKey[] = [];
  for (const raw of vals) {
    let keys: IdentityKey[];
    if (field === "email" || field === "emails" || field === "contact_emails" || field === "channels.email") {
      const parts = raw.split(/[,;\s]+/).filter(Boolean);
      if (!parts.length || !parts.every(looksLikeEmail)) return null;
      keys = parts.map((e) => ({ kind: "email" as const, value: normalizeEmailKey(e) }));
    } else if (field === "contact") {
      const d = normalizePhone(raw);
      keys = looksLikeEmail(raw) ? [{ kind: "email", value: normalizeEmailKey(raw) }] : d ? [{ kind: "phone", value: d }] : [];
    } else if (field === "phone" || field === "channels.phone") {
      const d = normalizePhone(raw);
      keys = d ? [{ kind: "phone", value: d }] : [];
    } else if (field === "telegram" || field === "channels.telegram") keys = telegramKeys(raw);
    else keys = matrixKeys(raw);
    if (!keys.length) return null;
    out.push(...keys);
  }
  return out;
}

/**
 * The merge-patch that removes identity fields from a tombstoned note — only
 * the fields whose every key `holder` (the canonical note AS IT IS NOW) claims.
 * `kept` is what was removed, for undo; `left` names the fields not touched.
 */
export function stripIdentityPatch(note: Note, holder: Note): { patch: Record<string, unknown>; kept: Record<string, unknown>; left: string[] } {
  const md = note.metadata ?? {};
  const held = new Set(personKeys(holder).strong.map((k) => `${k.kind}\u0000${k.value}`));
  const safe = (field: string, v: unknown): boolean => {
    const keys = keysOfValue(field, v);
    return !!keys && keys.every((k) => held.has(`${k.kind}\u0000${k.value}`));
  };
  const patch: Record<string, unknown> = {};
  const kept: Record<string, unknown> = {};
  const left: string[] = [];
  const present = (v: unknown) => !(v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0));
  for (const k of ["email", "emails", "contact_emails", "matrix", "matrixId", "telegram", "phone", "contact"]) {
    if (!present(md[k])) continue;
    if (safe(k, md[k])) {
      kept[k] = md[k];
      patch[k] = null;
    } else if (k !== "contact" || keysOfValue("contact", md[k])) left.push(k);
  }
  if (present(md.matrixRoomIds)) left.push("matrixRoomIds");
  const ch = obj(md.channels);
  const removed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ch)) {
    if (!present(v)) continue;
    if (safe(`channels.${k === "email" || k === "phone" || k === "telegram" ? k : "matrix"}`, v)) removed[k] = v;
    else left.push(`channels.${k}`);
  }
  if (Object.keys(removed).length) {
    kept.channels = removed;
    // The complete object: untouched keys as they are, removed keys as null.
    patch.channels = { ...ch, ...Object.fromEntries(Object.keys(removed).map((k) => [k, null])) };
  }
  return { patch, kept, left };
}
