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
 * that row's own metadata (whoever produced the state it captured) — but its
 * `actor`/`via`/`supersededAt` describe the change that REPLACED it. The change
 * that PRODUCED row i is therefore row i+1's (`producerOf`), and the current
 * note's is row 0's.
 *
 * STALE STAMPS. The vault MERGES metadata: a write that carries no stamp (the
 * vault MCP of a hosted agent, Hermes, a cloud routine, a sync) leaves the older
 * person's stamp in place. A stamp is believed only when it was made within
 * `STAMP_TOLERANCE_MS` of the moment the state was produced (`producedAt`);
 * otherwise the state reads as `external` ("Changed outside Prism"). Same rule as
 * the server (`apps/server/src/sharing.ts` `versionWriter`, writer-stamp.ts STALE_MS).
 */
import type { WriterInfo } from "../sharing/types";

export type { WriterInfo };

export interface AttributionInput {
  writer?: WriterInfo;
  metadata?: Record<string, unknown> | null;
  /** Channel of the change that PRODUCED this state (`mcp` = an agent tool). */
  via?: string | null;
  /** When this state was produced: the current note's `updatedAt`, or `savedAt(versions, i)`. */
  producedAt?: string | null;
}

/** A stamp made more than this before the state it sits on describes an earlier write. */
export const STAMP_TOLERANCE_MS = 10_000;

/** One version row's vault provenance (owner path only). */
export interface Provenance {
  actor?: string | null;
  via?: string | null;
  supersededAt?: string | null;
}

/**
 * The provenance of the change that PRODUCED state `i` of a newest-first version
 * list (`i = -1` = the current note): row i+1's actor/via/supersededAt.
 */
export function producerOf(versions: ReadonlyArray<Provenance>, i: number): Provenance | null {
  return versions[i + 1] ?? null;
}

/** "agent-session:3f2a9c0b-…" → "agent-session:3f2a9c0b…"; long opaque values are cut, never shown whole. */
export function shortProvenance(v: string): string {
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const i = s.indexOf(":");
  const [head, rest] = i > 0 ? [s.slice(0, i + 1), s.slice(i + 1)] : ["", s];
  const cut = rest.length > 14 ? `${rest.slice(0, 10)}…` : rest;
  return (head + cut).slice(0, 48);
}

/**
 * A short "which agent" label from the vault's own provenance — `actor` (the
 * token's subject) and `via` (the channel): "agent-session:3f2a… via mcp",
 * "via api". OWNER ONLY by construction: the gateway strips actor/via from every
 * non-owner version row. Null when the vault said nothing.
 */
export function sourceLabel(p: Provenance | null | undefined): string | null {
  const actor = typeof p?.actor === "string" && p.actor.trim() ? shortProvenance(p.actor) : null;
  const via = typeof p?.via === "string" && p.via.trim() ? shortProvenance(p.via) : null;
  if (actor && via) return actor === via ? actor : `${actor} via ${via}`;
  if (via) return `via ${via}`;
  return actor;
}

/** " · <actor> · via <via>" for the change that REPLACED a row (owner only; nothing when the vault said nothing). */
export function replacedByLine(p: Provenance | null | undefined): string {
  const actor = typeof p?.actor === "string" && p.actor.trim() ? ` · ${shortProvenance(p.actor)}` : "";
  const via = typeof p?.via === "string" && p.via.trim() ? ` · via ${shortProvenance(p.via)}` : "";
  return actor + via;
}

/**
 * `w` with the owner-visible `source` of the change that produced it, for the
 * kinds where WHICH agent/sync matters (agent, external, unknown). A person's own
 * Prism edit is already named; their token's subject would add nothing.
 */
export function withSource(w: WriterInfo, producer: Provenance | null | undefined): WriterInfo {
  if (w.kind !== "agent" && w.kind !== "external" && w.kind !== "unknown") return w;
  const source = sourceLabel(producer);
  return source ? { ...w, source } : w;
}

/** Who the opaque stamps of a page belong to (GET /api/notes/:id/activity: `writers`, `me`). */
export interface WriterDirectory {
  /** stamp id → display name, for the stamps of THIS page only. */
  names?: Record<string, string> | null;
  /** The viewer's own stamp id. */
  me?: string | null;
}

/** Was the stamp made more than the tolerance before `producedAt`? Unknown times → no claim. */
function stampIsStale(meta: Record<string, unknown> | null, producedAt: string | null | undefined): boolean {
  const at = Date.parse(String(meta?.prism_last_write_at ?? ""));
  const up = Date.parse(producedAt ?? "");
  return Number.isFinite(at) && Number.isFinite(up) && up - at > STAMP_TOLERANCE_MS;
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
  const change = changeKind(meta);
  if (change === "external") return { kind: "external", name: null, self: false };
  const stamp = typeof meta?.prism_last_writer === "string" ? meta.prism_last_writer : null;
  if (!stamp) return input.via === "mcp" ? { kind: "agent", name: null, self: false } : { kind: "unknown", name: null, self: false };
  // The stamp predates this state: whatever produced it wrote without one.
  if (stampIsStale(meta, input.producedAt)) return input.via === "mcp" ? { kind: "agent", name: null, self: false } : { kind: "external", name: null, self: false };
  const self = stamp !== "link" && !!directory?.me && stamp === directory.me;
  const name = stamp === "link" ? "Guest (link)" : (directory?.names?.[stamp] ?? null);
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
    case "external":
      return "Changed outside Prism";
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
  if (w.kind === "agent") return who ? `${who} (agent)` : w.source ? `an agent (${w.source})` : "the agent";
  if (w.kind === "external") return w.source ? `an agent or sync (${w.source})` : "an agent or sync";
  if (w.kind === "accepted-suggestion") return who ? `${who} (accepted a suggestion)` : null;
  return who;
}

/** Initials for an avatar chip. */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").replace(/[^\p{L}\p{N}\s@.]/gu, " ").split(/[\s@.]+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0]!.slice(0, 2) : parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
