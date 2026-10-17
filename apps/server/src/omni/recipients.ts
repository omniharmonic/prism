/**
 * Who is on the item a draft answers (final review Important 5). An email-reply executed by
 * proton_send.py goes to the draft's `expectTo`/`cc` exactly as written (proton-send.ts passes
 * them as --to/--cc), so `decide` checks them against the source note's own addresses first and
 * answers 409 `target_changed` otherwise — the rule the live email/reply route already applies
 * (actions.ts, CLAUDE.md "Live actions"). The app labels anyone not on the original item
 * "New recipient", from `originalRecipients` on the approval view.
 */
import { resolveVaultEntry } from "../db";
import { vaultClient } from "../parachute";
import { addresses } from "../worker/proton-parse";
import { setApprovalRecipientsLookup, type Approval } from "./approvals";
import { cardForApproval } from "./cards";
import { omniConfig } from "./config";

/** The addresses on a note (from, to, cc, reply-to, attendees), lowercased; null when it cannot be read or names none. */
export type ParticipantsReader = (noteId: string) => Promise<string[] | null>;

const ADDRESS_FIELDS = ["from", "to", "cc", "replyTo", "reply_to", "attendees", "participants"];

/** Addresses in stored header values and attendee lists, via the ingest's RFC 5322 parser. */
export function addressesIn(metadata: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string") for (const a of addresses(v)) if (a.includes("@")) out.add(a.trim().toLowerCase());
    if (Array.isArray(v)) v.forEach(add);
    if (v && typeof v === "object" && !Array.isArray(v)) add((v as Record<string, unknown>).email ?? (v as Record<string, unknown>).address);
  };
  for (const f of ADDRESS_FIELDS) add(metadata[f]);
  return [...out].sort();
}

const defaultReader: ParticipantsReader = async (noteId) => {
  try {
    const n = await vaultClient(resolveVaultEntry(undefined).id, { timeoutMs: 5_000 }).getNote(noteId, { includeContent: false, includeMetadata: ADDRESS_FIELDS });
    const list = addressesIn((n.metadata ?? {}) as Record<string, unknown>);
    return list.length ? list : null;
  } catch {
    return null;
  }
};
let reader: ParticipantsReader = defaultReader;
export function setParticipantsReaderForTests(r: ParticipantsReader | null): void {
  reader = r ?? defaultReader;
  cache.clear();
}

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; list: string[] | null }>();

/** The note whose people a draft is "for": the email a reply answers, else the item of the card it came from. */
function sourceNoteOf(owner: string, a: Approval): string | null {
  if (a.kind === "email-reply") return typeof a.payload.noteId === "string" ? a.payload.noteId : null;
  if (a.kind === "email" || a.kind === "calendar-invite") return cardForApproval(owner, a.id)?.sourceKey ?? null;
  return null;
}

/** Read (and cache) the people on the notes these approvals answer, so their views can label new recipients. */
export async function warmOriginalRecipients(owner: string, approvals: Approval[], now: number = Date.now()): Promise<void> {
  const notes = new Set<string>();
  for (const a of approvals) {
    const id = sourceNoteOf(owner, a);
    const hit = id ? cache.get(id) : undefined;
    if (id && (!hit || now - hit.at > CACHE_MS)) notes.add(id);
  }
  await Promise.all([...notes].slice(0, 50).map(async (id) => {
    const list = await reader(id);
    if (cache.size > 2000) cache.clear();
    cache.set(id, { at: now, list });
  }));
}

/** Sync, for approvalView: the cached addresses of the item, or null when unknown. */
export function originalRecipientsOf(owner: string, a: Approval): string[] | null {
  const id = sourceNoteOf(owner, a);
  return id ? cache.get(id)?.list ?? null : null;
}

/** The draft's own recipients (To, Cc, attendees), lowercased. */
export function draftRecipients(a: Pick<Approval, "kind" | "payload">): string[] {
  const p = a.payload;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const raw = a.kind === "email-reply" ? [...list(p.expectTo), ...list(p.cc)] : a.kind === "email" ? [...list(p.to), ...list(p.cc)] : a.kind === "calendar-invite" ? list(p.attendees) : [];
  return [...new Set(raw.map((x) => x.trim().toLowerCase()))];
}

/**
 * Before an email-reply is sent: every To/Cc must already be on the email it answers (or be the owner).
 * Read fresh, never from the cache. Unreadable note → refused too (nothing is sent on a guess).
 */
export async function replyRecipientsCheck(a: Approval, self: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (a.kind !== "email-reply" || typeof a.payload.noteId !== "string") return { ok: true };
  const on = await reader(a.payload.noteId);
  if (!on) return { ok: false, detail: "couldn't read who is on the original email — reload and check" };
  cache.set(a.payload.noteId, { at: Date.now(), list: on });
  const allowed = new Set([...on, self.trim().toLowerCase()]);
  const extra = draftRecipients(a).filter((r) => !allowed.has(r));
  return extra.length ? { ok: false, detail: `the reply would go to ${extra.length} address${extra.length === 1 ? "" : "es"} not on the original email — edit the draft or cancel it` } : { ok: true };
}

setApprovalRecipientsLookup((a) => originalRecipientsOf(omniConfig.ownerEmail(), a));
