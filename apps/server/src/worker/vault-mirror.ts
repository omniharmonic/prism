/**
 * Single-server vault-to-vault folder mirror. Mirrors every note under a source
 * path prefix in one registry vault into a destination prefix in another vault
 * on the SAME server — folder structure included, because a "folder" in Prism
 * is exactly the note's `path` string (there is no folder object anywhere), so
 * preserving relative paths IS propagating the folder tree.
 *
 * One-way, source-wins: creates, edits, moves/renames, and (verified) deletes
 * under the source prefix converge onto the destination. Dedup/identity is by
 * `metadata.mirror_source` ("<srcVaultId>:<srcNoteId>") — the same idiom as the
 * Fathom/Matrix ingesters' source_id. Destination notes WITHOUT our marker are
 * never touched, so native notes can live inside the mirrored folder.
 *
 * Deletes are irreversible-until-proven: a source note missing from the listing
 * is only acted on after a direct getNote re-fetch confirms 404 (a listing
 * hiccup must never cascade into destination deletes — the Fireflies lesson),
 * and the default `delete_mode` is 'archive' (move under <dest>/_archive/),
 * which destroys nothing.
 */
// The sync ENGINE (syncMirror + helpers) is deliberately pure: type-only imports
// plus the pure paths helpers, so the verify harness (scripts/verify-folder-sync.ts)
// can drive it against scratch vaults without loading the server's SQLite or
// config. Only the scheduler glue at the bottom touches db/parachute — lazily.
import type { Note } from "../parachute";
import { pathInPrefix } from "../paths";
import type { VaultMirror } from "../db";

/** The minimal vault surface the mirror needs (satisfied by vaultClient();
 *  injectable so the sync logic is unit-tested without a live vault). */
export interface MirrorVault {
  listNotes(opts: { pathPrefix?: string; includeContent?: boolean }): Promise<Note[]>;
  getNote(id: string): Promise<Note>;
  createNote(params: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note>;
  updateNote(id: string, params: { content?: string; path?: string; metadata?: Record<string, unknown> }): Promise<Note>;
  addTags(id: string, tags: string[]): Promise<void>;
  removeTags(id: string, tags: string[]): Promise<void>;
  deleteNote(id: string): Promise<void>;
}

export interface MirrorRunResult {
  scanned: number;
  created: number;
  updated: number;
  deleted: number;
  archived: number;
  skipped: number;
  errors: string[];
}

/** The identity marker a mirrored copy carries. */
export const mirrorSourceKey = (srcVaultId: string, srcNoteId: string): string => `${srcVaultId}:${srcNoteId}`;

/** Rebase a source path from the source prefix onto the destination prefix,
 *  preserving the relative folder structure. `a/b/c` under `a` → `x/b/c` under `x`. */
export function rebasePath(notePath: string, srcPrefix: string, destPrefix: string): string {
  if (notePath === srcPrefix) return destPrefix;
  return `${destPrefix}/${notePath.slice(srcPrefix.length + 1)}`;
}

const archivePrefix = (destPrefix: string): string => `${destPrefix}/_archive`;

/** 404-shaped error from the vault client (VaultError carries .status). */
const isNotFound = (e: unknown): boolean => (e as { status?: number } | null)?.status === 404;

/**
 * One convergence pass: diff the source prefix against the destination prefix
 * and write the difference. Idempotent — a second run with no source changes
 * makes zero vault writes. Per-note errors are collected, never thrown, so one
 * bad note can't wedge the mirror.
 */
export async function syncMirror(src: MirrorVault, dst: MirrorVault, cfg: VaultMirror): Promise<MirrorRunResult> {
  const res: MirrorRunResult = { scanned: 0, created: 0, updated: 0, deleted: 0, archived: 0, skipped: 0, errors: [] };

  // Re-filter both listings with the authoritative membership predicate —
  // defense-in-depth over the vault's own path_prefix query (same posture as
  // path publications).
  const srcNotes = (await src.listNotes({ pathPrefix: cfg.src_prefix })).filter(
    (n) =>
      pathInPrefix(n.path, cfg.src_prefix) &&
      // Never re-mirror a note that is itself a mirrored copy: chaining markers
      // is how an A→B + B→A pair would echo notes back and forth forever.
      !(n.metadata && typeof n.metadata.mirror_source === "string"),
  );
  const dstNotes = (await dst.listNotes({ pathPrefix: cfg.dest_prefix })).filter((n) => pathInPrefix(n.path, cfg.dest_prefix));

  // Destination index by source identity, scoped to THIS mirror's own copies
  // (mirror_id match). Unmarked notes are invisible by construction; another
  // mirror's copies must be too — indexing on the marker alone would let two
  // mirrors sharing a source hijack (re-path, re-stamp) each other's copies and
  // churn or duplicate them every cycle.
  const byMarker = new Map<string, Note>();
  for (const n of dstNotes) {
    const marker = n.metadata?.mirror_source;
    if (typeof marker === "string" && marker && n.metadata?.mirror_id === cfg.id) byMarker.set(marker, n);
  }

  const liveMarkers = new Set<string>();
  for (const srcNote of srcNotes) {
    res.scanned++;
    const marker = mirrorSourceKey(cfg.src_vault, srcNote.id);
    liveMarkers.add(marker);
    const destPath = rebasePath(srcNote.path!, cfg.src_prefix, cfg.dest_prefix);
    const existing = byMarker.get(marker);
    try {
      if (!existing) {
        // New under the prefix → full fetch (listings omit content) and create.
        const full = await src.getNote(srcNote.id);
        await dst.createNote({
          content: full.content ?? "",
          path: destPath,
          tags: full.tags ?? [],
          metadata: mirrorMetadata(full, marker, cfg.id),
        });
        res.created++;
        continue;
      }
      const sourceChanged = existing.metadata?.mirror_source_updated_at !== (srcNote.updatedAt ?? null);
      const movedOrArchived = existing.path !== destPath; // covers renames/moves AND un-archiving a resurrected source
      // Compare tags directly too: listings carry them, and whether a tag-only
      // PATCH bumps the vault's updatedAt is not a contract we can lean on.
      const tagsChanged = !sameTags(srcNote.tags, existing.tags);
      if (!sourceChanged && !movedOrArchived && !tagsChanged) {
        res.skipped++;
        continue;
      }
      const full = await src.getNote(srcNote.id);
      // Tags FIRST: updateNote below advances mirror_source_updated_at, and once
      // that marker matches the source a failed tag write would never be retried
      // (the note reads as unchanged forever after).
      await diffTags(dst, existing, full.tags ?? []);
      await dst.updateNote(existing.id, {
        content: full.content ?? "",
        path: destPath,
        // The vault PATCH MERGES metadata, so a key deleted on the source would
        // survive on the copy without an explicit null tombstone.
        metadata: withTombstones(mirrorMetadata(full, marker, cfg.id), existing.metadata),
      });
      res.updated++;
    } catch (e) {
      res.errors.push(`${marker}: ${(e as Error).message}`);
    }
  }

  // Deletions — only our own copies (mirror_id match), only after the source's
  // absence is CONFIRMED by a direct re-fetch, and archive (not destroy) by default.
  for (const [marker, copy] of byMarker) {
    if (liveMarkers.has(marker)) continue;
    if (cfg.delete_mode === "keep") continue;
    // Archived copies are settled history in EVERY mode: flipping delete_mode
    // from 'archive' to 'delete' later must not retroactively destroy the
    // archive ("archive destroys nothing" is a promise, not a mode).
    if (pathInPrefix(copy.path, archivePrefix(cfg.dest_prefix))) continue;
    const srcId = marker.slice(cfg.src_vault.length + 1);
    try {
      const live = await src.getNote(srcId);
      // Alive AND still under the prefix → the listing was incomplete; touch
      // nothing. Alive but MOVED OUT of the prefix → deliberately un-shared;
      // fall through and treat exactly like a deletion (otherwise the copy is
      // stranded: never updated, never removed, still readable by collaborators).
      if (pathInPrefix(live.path, cfg.src_prefix)) continue;
    } catch (e) {
      if (!isNotFound(e)) {
        res.errors.push(`${marker}: delete-verify failed (${(e as Error).message}) — keeping`);
        continue; // fail closed: an outage must never look like a deletion
      }
    }
    try {
      if (cfg.delete_mode === "delete") {
        await dst.deleteNote(copy.id);
        res.deleted++;
      } else {
        const rel = copy.path === cfg.dest_prefix ? "" : copy.path!.slice(cfg.dest_prefix.length + 1);
        await dst.updateNote(copy.id, { path: rel ? `${archivePrefix(cfg.dest_prefix)}/${rel}` : archivePrefix(cfg.dest_prefix) });
        res.archived++;
      }
    } catch (e) {
      res.errors.push(`${marker}: ${(e as Error).message}`);
    }
  }

  return res;
}

/** The mirrored copy's metadata: the source's own metadata plus our identity
 *  markers (which also make the copy self-describing in the destination vault). */
function mirrorMetadata(source: Note, marker: string, mirrorId: string): Record<string, unknown> {
  return {
    ...(source.metadata ?? {}),
    mirror_source: marker,
    mirror_source_updated_at: source.updatedAt ?? null,
    mirror_id: mirrorId,
  };
}

const sameTags = (a: string[] | null, b: string[] | null): boolean => {
  const sa = new Set(a ?? []);
  const sb = new Set(b ?? []);
  return sa.size === sb.size && [...sa].every((t) => sb.has(t));
};

/** The vault PATCH merges metadata; keys the source dropped need an explicit
 *  null tombstone or they'd live on the copy forever (stale dashboard filters). */
function withTombstones(next: Record<string, unknown>, previous: Record<string, unknown> | null): Record<string, unknown> {
  const out = { ...next };
  for (const key of Object.keys(previous ?? {})) {
    if (!(key in out)) out[key] = null;
  }
  return out;
}

/** Converge the copy's tags onto the source's via add/remove diffs. */
async function diffTags(dst: MirrorVault, copy: Note, wanted: string[]): Promise<void> {
  const have = new Set(copy.tags ?? []);
  const want = new Set(wanted);
  const add = wanted.filter((t) => !have.has(t));
  const remove = [...have].filter((t) => !want.has(t));
  if (add.length) await dst.addTags(copy.id, add);
  if (remove.length) await dst.removeTags(copy.id, remove);
}

// ── scheduler integration ─────────────────────────────────────────────────────

/** Mirrors converge on their own cadence (they diff two full prefix listings, so
 *  every worker tick would be wasteful). Forced runs (the on-demand route) bypass it. */
const MIRROR_INTERVAL_MS = 5 * 60_000;

/** Mirrors currently mid-run. A forced run (POST /:id/sync) can otherwise
 *  interleave with the scheduler's run of the same mirror — two concurrent
 *  passes each see !existing for the same source note and both create, leaving
 *  a permanent doppelgänger copy the marker index can never manage. */
const running = new Set<string>();

/** Run one mirror if it is enabled and due; records the run summary on the row.
 *  Returns the result, or null when skipped (disabled / not due / already
 *  running / a vault no longer in the registry). */
export async function runVaultMirrorOnce(cfg: VaultMirror, opts: { force?: boolean } = {}): Promise<MirrorRunResult | null> {
  if (!cfg.enabled && !opts.force) return null;
  if (!opts.force && cfg.last_run_at && Date.now() - cfg.last_run_at < MIRROR_INTERVAL_MS) return null;
  // Claim the in-flight slot BEFORE the first await — two concurrent callers
  // must not both pass the check.
  if (running.has(cfg.id)) return null;
  running.add(cfg.id);
  try {
    const { vaultClient } = await import("../parachute");
    const { recordMirrorRun, getVaultRegistry } = await import("../db");
    // HARD registry check on both ends. resolveVaultEntry (inside vaultClient)
    // silently falls back to the PRIMARY vault for an unknown id — an orphaned
    // mirror would then delete-verify every copy against the wrong vault, 404,
    // and mass-archive/delete the destination. Refuse to run instead.
    const ids = new Set(getVaultRegistry().map((v) => v.id));
    if (!ids.has(cfg.src_vault) || !ids.has(cfg.dest_vault)) {
      console.error(`[worker] vault-mirror ${cfg.id}: vault "${!ids.has(cfg.src_vault) ? cfg.src_vault : cfg.dest_vault}" is not in the registry — refusing to run`);
      return null;
    }
    const res = await syncMirror(
      vaultClient(cfg.src_vault) as unknown as MirrorVault,
      vaultClient(cfg.dest_vault) as unknown as MirrorVault,
      cfg,
    );
    recordMirrorRun(cfg.id, res);
    if (res.created || res.updated || res.deleted || res.archived || res.errors.length) {
      console.log(
        `[worker] vault-mirror ${cfg.id} (${cfg.src_vault}/${cfg.src_prefix} → ${cfg.dest_vault}/${cfg.dest_prefix}): ` +
          `+${res.created} created, ~${res.updated} updated, -${res.deleted} deleted, ${res.archived} archived ` +
          `(${res.skipped} unchanged)` +
          (res.errors.length ? ` — ${res.errors.length} ERRORS: ${res.errors.slice(0, 3).join("; ")}` : ""),
      );
    }
    return res;
  } finally {
    running.delete(cfg.id);
  }
}

/** All configured mirrors, per-mirror error isolation (the scheduler tick calls this). */
export async function runVaultMirrorsOnce(): Promise<void> {
  const { listVaultMirrors } = await import("../db");
  for (const m of listVaultMirrors()) {
    try {
      await runVaultMirrorOnce(m);
    } catch (e) {
      console.warn(`[worker] vault-mirror ${m.id} failed:`, (e as Error).message);
    }
  }
}
