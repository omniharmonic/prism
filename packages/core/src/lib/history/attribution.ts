/**
 * Version attribution (NP-PG-13): who produced each stored state of a page, as
 * the history timeline and the page-info footer name it.
 *
 * Sources, best first:
 *  - `version.writer` — the server's derivation for non-owners (name only, never
 *    an email; apps/server/src/sharing.ts `versionWriter`);
 *  - the writer stamp in the state's metadata: `prism_last_writer` (an account
 *    email, "link" for a link guest, or `agent:<email>`) and `prism_last_change`
 *    ("edit" | "suggestion" | "agent" | "accepted-suggestion"), written by the
 *    gateway and by collab stores — the owner passthrough sees these raw;
 *  - the vault's own channel (`via: "mcp"` = an agent tool), owner only.
 * Missing everything (older states, a vault without stamps) → "unknown", which
 * the UI words neutrally ("Saved"), never as somebody.
 *
 * A version row is the state BEFORE a change, so the writer of a row is read from
 * that row's own metadata (whoever produced the state it captured).
 */
import type { WriterInfo } from "../sharing/types";

export type { WriterInfo };

export interface AttributionInput {
  writer?: WriterInfo;
  metadata?: Record<string, unknown> | null;
  via?: string | null;
}

/** Derive the writer of a stored state (pure). `viewer` = the signed-in email, if known. */
export function writerOf(input: AttributionInput, viewer?: string | null, nameOf?: (email: string) => string | null): WriterInfo {
  if (input.writer && typeof input.writer === "object" && typeof input.writer.kind === "string") return input.writer;
  const meta = input.metadata ?? null;
  const stamp = typeof meta?.prism_last_writer === "string" ? meta.prism_last_writer : null;
  const change = typeof meta?.prism_last_change === "string" ? meta.prism_last_change : null;
  const email = stamp && stamp !== "link" ? stamp.replace(/^agent:/, "") : null;
  const self = !!email && !!viewer && email.toLowerCase() === viewer.toLowerCase();
  const name = stamp === "link" ? "Guest (link)" : email ? (nameOf?.(email) ?? email) : null;
  if (change === "agent" || stamp?.startsWith("agent:") || (!stamp && input.via === "mcp")) return { kind: "agent", name, self };
  if (change === "accepted-suggestion") return { kind: "accepted-suggestion", name, self };
  if (change === "suggestion") return { kind: "suggestion", name, self };
  if (stamp === "link") return { kind: "guest", name, self: false };
  if (email) return { kind: "person", name, self };
  return { kind: "unknown", name: null, self: false };
}

/** The timeline title for a state ("Agent revision", "Accepted suggestion", …). */
export function writerTitle(w: WriterInfo): string {
  switch (w.kind) {
    case "agent":
      return "Agent revision";
    case "accepted-suggestion":
      return "Accepted suggestion";
    case "suggestion":
      return "Suggested edit";
    case "guest":
      return "Edit by a link guest";
    case "person":
      return "Edit";
    default:
      return "Saved version";
  }
}

/** Who to name next to it: "You", the person, or null when unknown. */
export function writerName(w: WriterInfo): string | null {
  if (w.self) return "You";
  return w.name;
}

/** A short line for page info ("Last edited by You" / "by the agent"). */
export function lastEditedBy(w: WriterInfo): string | null {
  const who = writerName(w);
  if (w.kind === "agent") return who ? `${who} (agent)` : "the agent";
  if (w.kind === "accepted-suggestion") return who ? `${who} (accepted a suggestion)` : null;
  return who;
}

/** Initials for an avatar chip. */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").replace(/[^\p{L}\p{N}\s@.]/gu, " ").split(/[\s@.]+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
