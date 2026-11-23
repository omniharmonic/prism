// People for Comms: a contact card (phones, emails, network handles) built from a vault person note
// plus the bridge ghost ids of the person's DMs, and the person page (contact + every shared chat).
//
// Wire shapes (the Swift mirrors live in swift/PrismKit CommsModels.swift):
//   Contact       = { phones: [{label?, value: "+E164"}], emails: [{label?, value}],
//                     handles: [{network, value, kind: "phone"|"username"|"userId"}] }
//   PersonProfile = { id, name, avatar?, noteId, ...Contact, threads: Thread[] }
// Everything here is derived, nothing is stored: the person note is read once per request (one
// lean note read, no listing) and the ghost ids come from comms_conversation_members.
import { vaultClient, VaultError, type Note } from "../parachute";
import { config } from "../config";
import { personKeys, looksLikeEmail } from "../identity";
import type { AvatarRef, Network } from "./types";

export interface ContactPhone { label?: string; value: string }
export interface ContactEmail { label?: string; value: string }
export interface ContactHandle { network: Network; value: string; kind: "phone" | "username" | "userId" }
export interface Contact { phones: ContactPhone[]; emails: ContactEmail[]; handles: ContactHandle[] }

const MAX_EACH = 20;
const NETWORK_LABEL: Partial<Record<Network, string>> = { whatsapp: "WhatsApp", signal: "Signal" };

/** The network of a bridge-ghost / Matrix-id prefix, in Comms' vocabulary (null = no app deep link / unknown). */
const GHOST_NETWORK: Record<string, Network> = {
  whatsapp: "whatsapp", telegram: "telegram", signal: "signal", discord: "discord",
  messenger: "messenger", facebook: "messenger", twitter: "x", slack: "slack", instagram: "instagram",
};
const GHOST = /^@([a-z]+)_([^:]+):/;
const DIGITS_PHONE = /^\d{7,15}$/;
const TG_USERNAME = /^[a-z][a-z0-9_]{3,31}$/;
const SLACK_ID = /^t[a-z0-9]+-[uwb][a-z0-9]+$/;

/** Contact facts one bridge ghost id carries (a WhatsApp ghost localpart IS the phone number). */
export function ghostContact(mxid: string): { phone?: { value: string; label?: string }; handle?: ContactHandle } {
  const m = GHOST.exec(mxid.trim().toLowerCase());
  const network = m ? GHOST_NETWORK[m[1]!] : undefined;
  if (!m || !network) return {};
  const id = m[2]!;
  if (network === "whatsapp" || network === "signal") {
    if (!DIGITS_PHONE.test(id)) return {}; // a WhatsApp LID or a Signal ACI is no phone number
    const value = `+${id}`;
    return { phone: { value, label: NETWORK_LABEL[network]! }, handle: { network, value, kind: "phone" } };
  }
  if (network === "telegram") {
    if (/^\d{4,}$/.test(id)) return { handle: { network, value: id, kind: "userId" } };
    return TG_USERNAME.test(id) ? { handle: { network, value: `@${id}`, kind: "username" } } : {};
  }
  if (network === "slack") return SLACK_ID.test(id) ? { handle: { network, value: id.toUpperCase(), kind: "userId" } } : {};
  return /^\d{4,}$/.test(id) ? { handle: { network, value: id, kind: "userId" } } : {};
}

/** A person note's own contact facts + the ghosts of the person's chats, deduplicated and bounded. */
export function contactFor(note: Pick<Note, "metadata" | "tags" | "path" | "content" | "id"> | null, memberIds: readonly string[]): Contact {
  const phones = new Map<string, ContactPhone>();
  const emails = new Map<string, ContactEmail>();
  const handles = new Map<string, ContactHandle>();
  const addPhone = (value: string, label?: string) => {
    const cur = phones.get(value);
    if (!cur) phones.set(value, { ...(label ? { label } : {}), value });
    else if (!cur.label && label) cur.label = label;
  };
  const addHandle = (h: ContactHandle) => handles.set(`${h.network}\u0000${h.kind}\u0000${h.value}`, h);
  if (note) {
    for (const k of personKeys(note as Note).strong) {
      if (k.kind === "phone") addPhone(`+${k.value}`);
      else if (k.kind === "email" && looksLikeEmail(k.value)) emails.set(k.value, { value: k.value });
      else if (k.kind === "telegram") addHandle({ network: "telegram", value: k.value, kind: k.value.startsWith("@") ? "username" : "userId" });
      else if (k.kind === "handle") {
        const [net, ...rest] = k.value.split(":");
        const network = GHOST_NETWORK[net ?? ""];
        const id = rest.join(":");
        if (network && /^\d{4,}$/.test(id)) addHandle({ network, value: id, kind: "userId" });
      }
    }
  }
  for (const id of memberIds) {
    // iMessage/SMS handles (bluebubbles/contacts.ts bbMemberId): the number / address itself.
    if (id.startsWith("tel:+")) { addPhone(id.slice(4)); continue; }
    if (id.startsWith("mailto:")) { const e = id.slice(7); if (looksLikeEmail(e)) emails.set(e, { value: e }); continue; }
    const g = ghostContact(id);
    if (g.phone) addPhone(g.phone.value, g.phone.label);
    if (g.handle) addHandle(g.handle);
  }
  return {
    phones: [...phones.values()].slice(0, MAX_EACH),
    emails: [...emails.values()].slice(0, MAX_EACH),
    handles: [...handles.values()].slice(0, MAX_EACH),
  };
}

// ── the person note ──────────────────────────────────────────────────────────

const PERSON_KEYS = [
  "name", "title", "photo", "avatar", "email", "emails", "contact", "contact_emails", "channels", "matrix", "matrixId",
  "matrixRoomIds", "telegram", "phone", "type", "status", "merged_into", "mergedInto", "superseded_by",
];

let source: ((vaultId: string, id: string) => Promise<Note | null>) | null = null;
/** Tests: replace the person-note read. */
export function setPersonSourceForTests(f: typeof source): void { source = f; }

/** The person note (lean), null when it does not exist or is not a person; throws on a source failure. */
export async function loadPerson(vaultId: string, id: string): Promise<Note | null> {
  if (source) return source(vaultId, id);
  const vault = vaultClient(vaultId, { timeoutMs: config.matrixVaultTimeoutMs > 0 ? Math.min(config.matrixVaultTimeoutMs, 10_000) : 10_000 });
  try {
    const n = await vault.getNote(id, { includeContent: false, includeMetadata: PERSON_KEYS });
    return (n.tags ?? []).includes("person") ? n : null;
  } catch (e) {
    if (e instanceof VaultError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

/** THE display name of a person note (person-name.ts): title → name → heading → path; never raw HTML. */
export { personName } from "../person-name";

export function personAvatar(n: Pick<Note, "metadata">): AvatarRef | null {
  const m = (n.metadata ?? {}) as Record<string, unknown>;
  const photo = [m.photo, m.avatar].find((v): v is string => typeof v === "string" && v.startsWith("mxc://"));
  return photo ? { mxc: photo } : null;
}
