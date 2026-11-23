/**
 * Who an iMessage/SMS address is: the owner's person notes first (strong keys only — E.164
 * phone, email; decision D3), then the Mac's Contacts as BlueBubbles exposes them
 * (POST /api/v1/contact/query). Built once and cached; never logged.
 */
import type { Note } from "../parachute";
import type { PeopleIndex } from "../worker/people";
import { personName as sharedPersonName } from "../person-name";
import { normalizePhone } from "../identity";
import { bbContactRef } from "../comms/media";
import type { AvatarRef } from "../comms/types";
import type { BbContact, BlueBubblesClient } from "./client";

/**
 * The member id of an iMessage/SMS handle in comms_conversation_members (review I4): `tel:+<E.164>`
 * for a phone number with a country code (identity.ts normalizePhone — the people code's own rule;
 * a local number without one is no key and is kept as written), `mailto:<lowercased>` for an email.
 * comms/people.ts contactFor reads both back as contact data.
 */
export function bbMemberId(address: string): string {
  const a = address.trim();
  if (a.includes("@")) return `mailto:${a.toLowerCase()}`;
  const d = normalizePhone(a);
  return d ? `tel:+${d}` : `tel:${a.replace(/[^\d+]/g, "")}`;
}

/** A lookup key for an address: lowercased email, or the last 10 digits of a phone number. */
export function addressKey(address: string): string | null {
  const a = address.trim();
  if (!a) return null;
  if (a.includes("@")) return `e:${a.toLowerCase()}`;
  const d = a.replace(/\D/g, "");
  return d.length >= 7 ? `p:${d.slice(-10)}` : `s:${a.toLowerCase()}`;
}

// Contact-photo presence, learnt lazily by the media route (review I7: the book is loaded WITHOUT
// photos). A Contacts entry is offered as an avatar until a fetch found no photo for it; that
// "no photo" answer is remembered for a day.
const NO_PHOTO_TTL_MS = 24 * 60 * 60_000;
const noPhoto = new Map<string, number>();
export function notePhotoAbsent(address: string, now = Date.now()): void {
  const k = addressKey(address);
  if (!k) return;
  noPhoto.set(k, now);
  if (noPhoto.size > 20_000) noPhoto.delete(noPhoto.keys().next().value!);
}
function photoAbsent(k: string, now = Date.now()): boolean {
  const at = noPhoto.get(k);
  if (at === undefined) return false;
  if (now - at < NO_PHOTO_TTL_MS) return true;
  noPhoto.delete(k);
  return false;
}
export function resetPhotoCacheForTests(): void {
  noPhoto.clear();
}

export interface ContactBook {
  nameOf(address: string): string | null;
  avatarOf(address: string): AvatarRef | null;
  personOf(address: string): string | null;
  /** True when the Mac's Contacts know this address (Apple's "known sender"). */
  known(address: string): boolean;
  /** The first name for a group title ("Ann, Bob & 3 others"): Contacts' first name, else the
   *  first word of the person note's / contact's name; null when nobody knows the address. */
  firstNameOf(address: string): string | null;
  /** True when the address is one of the owner's own (their person note's strong keys). */
  isSelf(address: string): boolean;
}

const personName = (n: Note): string | null => sharedPersonName(n) || null;

function contactName(c: BbContact): string | null {
  const d = c.displayName?.trim();
  if (d) return d;
  const n = [c.firstName?.trim(), c.lastName?.trim()].filter(Boolean).join(" ");
  return n || null;
}

/** Build a book from contacts (+ which of them have a photo) and the people index. */
export function makeContactBook(contacts: BbContact[], people: PeopleIndex | null, ownerPersonId: string | null = null): ContactBook {
  const names = new Map<string, string>();
  const firsts = new Map<string, string>();
  const photo = new Set<string>();
  for (const c of contacts) {
    const name = contactName(c);
    const first = c.firstName?.trim() || name?.split(/\s+/)[0] || null;
    // A book loaded without photos (the default) offers every known contact; one loaded with
    // them (tests, single lookups) offers exactly the ones that have a photo.
    const hasPhoto = c.avatar === undefined ? true : typeof c.avatar === "string" && c.avatar.length > 0;
    for (const a of [...(c.phoneNumbers ?? []), ...(c.emails ?? [])]) {
      const k = typeof a?.address === "string" ? addressKey(a.address) : null;
      if (!k) continue;
      if (name && !names.has(k)) names.set(k, name);
      if (first && !firsts.has(k)) firsts.set(k, first);
      if (hasPhoto) photo.add(k);
    }
  }
  const anyPerson = (address: string): Note | null => {
    if (!people) return null;
    try {
      return address.includes("@") ? people.find({ email: address }) : people.find({ phone: address });
    } catch {
      return null;
    }
  };
  const person = (address: string): Note | null => {
    const p = anyPerson(address);
    return p && p.id !== ownerPersonId ? p : null;
  };
  return {
    nameOf(address) {
      const p = person(address);
      if (p) return personName(p);
      const k = addressKey(address);
      return k ? names.get(k) ?? null : null;
    },
    avatarOf(address) {
      const k = addressKey(address);
      const ref = k && photo.has(k) && !photoAbsent(k) ? bbContactRef(address) : null;
      return ref ? { mxc: ref } : null;
    },
    personOf(address) {
      return person(address)?.id ?? null;
    },
    known(address) {
      const k = addressKey(address);
      return !!k && names.has(k);
    },
    firstNameOf(address) {
      const p = person(address);
      if (p) {
        const m = (p.metadata ?? {}) as Record<string, unknown>;
        const given = typeof m.firstName === "string" ? m.firstName.trim() : typeof m.givenName === "string" ? m.givenName.trim() : "";
        return given || personName(p)?.split(/\s+/)[0] || null;
      }
      const k = addressKey(address);
      return k ? firsts.get(k) ?? null : null;
    },
    isSelf(address) {
      return !!ownerPersonId && anyPerson(address)?.id === ownerPersonId;
    },
  };
}

export const EMPTY_BOOK: ContactBook = makeContactBook([], null);

/** All contacts, WITHOUT photos (photo presence is learnt per address; see notePhotoAbsent). */
export async function loadContacts(client: Pick<BlueBubblesClient, "allContacts">): Promise<BbContact[]> {
  return (await client.allContacts()).map((c) => ({ ...c, avatar: undefined }));
}
