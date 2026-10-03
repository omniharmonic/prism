/**
 * Version attribution (NP-PG-13): who produced each stored state of a page, as
 * the history timeline and the page-info footer name it.
 *
 * Sources, best first:
 *  - `version.writer` — the server's derivation for non-owners (name only, never
 *    an email; apps/server/src/sharing.ts `versionWriter`);
 *  - the writer stamp in the state's metadata: `prism_last_writer` (an OPAQUE
 *    subject id, or "link"), `prism_last_write_at`, and `prism_last_change`
 *    (`<kind>@<write time>`, kind = edit | suggestion | agent | accepted-suggestion),
 *    written by the gateway and by collab stores — only the owner passthrough
 *    sees these raw, and resolves ids with the page's activity directory;
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

/** Who the opaque stamps of a page belong to (GET /api/notes/:id/activity: `writers`, `me`). */
export interface WriterDirectory {
  /** stamp id → display name, for the stamps of THIS page only. */
  names?: Record<string, string> | null;
  /** The viewer's own stamp id. */
  me?: string | null;
}

/** The kind recorded with a stamp: `<kind>@<prism_last_write_at>` (ignored when it belongs to an older stamp). */
function changeKind(meta: Record<string, unknown> | null): string | null {
  const v = meta?.prism_last_change;
  const at = meta?.prism_last_write_at;
  if (typeof v !== "string" || typeof at !== "string") return null;
  const i = v.indexOf("@");
  return i > 0 && v.slice(i + 1) === at ? v.slice(0, i) : null;
}

/**
 * Derive the writer of a stored state (pure). The stamp is an OPAQUE subject id
 * (never an email); `directory` — from the page's activity read — says which id
 * is the viewer and what the others are called. Without it a person is unnamed.
 */
export function writerOf(input: AttributionInput, directory?: WriterDirectory | null): WriterInfo {
  if (input.writer && typeof input.writer === "object" && typeof input.writer.kind === "string") return input.writer;
  const meta = input.metadata ?? null;
  const stamp = typeof meta?.prism_last_writer === "string" ? meta.prism_last_writer : null;
  if (!stamp) return input.via === "mcp" ? { kind: "agent", name: null, self: false } : { kind: "unknown", name: null, self: false };
  const self = stamp !== "link" && !!directory?.me && stamp === directory.me;
  const name = stamp === "link" ? "Guest (link)" : (directory?.names?.[stamp] ?? null);
  const change = changeKind(meta);
  if (change === "agent") return { kind: "agent", name, self };
  if (change === "accepted-suggestion") return { kind: "accepted-suggestion", name, self };
  if (change === "suggestion") return { kind: "suggestion", name, self };
  if (stamp === "link") return { kind: "guest", name, self: false };
  return { kind: "person", name, self };
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
