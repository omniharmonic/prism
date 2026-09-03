/**
 * The propose-for-review seam for the document editor (P4).
 *
 * Two tiny pieces, deliberately kept out of the VaultClient: a pure reader of
 * the gateway's `_caps` annotation, and a `fetch` client for the two governance
 * endpoints the editor needs. Governance is a SERVER-side surface
 * (/api/governance) that exists only on the web path; teaching `VaultClient`
 * about it would force the desktop's Tauri client to grow methods it can never
 * implement. So this module talks to the gateway directly, with the same
 * conventions as the governance panel's `govApi`: same-origin, plain fetch,
 * `credentials: "include"` (the session cookie), never a token.
 *
 * ── The gate ──────────────────────────────────────────────────────────────────
 * `_caps` is added by the Prism Server ONLY for a non-owner actor. The desktop
 * shell reads the vault directly (TauriVaultClient) and a web owner is served by
 * the transparent passthrough, so neither ever sees the field. `reviewMode`
 * therefore returns "none" for every desktop and every owner session, which is
 * what makes every affordance built on it provably inert outside the governed
 * web path.
 */

/** What editing this note should offer the current actor. */
export type ReviewMode =
  /** No `_caps` annotation (desktop, owner, virtual tab) OR full edit access —
   *  behave exactly as before P4. */
  | "none"
  /** May not edit, but may propose: edit locally, submit the result for review. */
  | "propose"
  /** May read (and perhaps comment) only: no local editing, no proposing. */
  | "read-only";

/** The gateway's capability annotation, or null when the note carries none. */
export function noteCaps(note: { _caps?: unknown } | null | undefined): Set<string> | null {
  const raw = note?._caps;
  if (!Array.isArray(raw)) return null;
  return new Set(raw.filter((c): c is string => typeof c === "string"));
}

/**
 * The one decision every P4 affordance is gated on.
 *
 * Absent annotation → "none": the component must behave byte-for-byte as it did
 * before. Present and carrying `edit` → also "none": a full editor needs no
 * review banner. Present without `edit` → "propose" when the actor holds
 * `suggest` or `create` (the two caps that give them standing to open a content
 * proposal), else "read-only".
 */
export function reviewMode(note: { _caps?: unknown } | null | undefined): ReviewMode {
  const caps = noteCaps(note);
  if (caps === null) return "none";
  if (caps.has("edit")) return "none";
  return caps.has("suggest") || caps.has("create") ? "propose" : "read-only";
}

// ── the gateway client ───────────────────────────────────────────────────────

/** One revision of a note, as GET /api/governance/notes/:id/revisions returns it. */
export interface NoteRevision {
  id: string;
  note: string;
  parent: string;
  proposal: string;
  author: string;
  origin: "proposal" | "rollback" | "publish";
  published: boolean;
  at: string;
}

export type ReviewResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<ReviewResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/governance${path}`, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = data as { detail?: string; error?: string } | null;
    return { ok: false, error: readableError(res.status, d?.error, d?.detail) };
  }
  return { ok: true, data: data as T };
}

/** Turn a governance refusal into a sentence a writer can act on. */
function readableError(status: number, code?: string, detail?: string): string {
  if (code === "no_standing") {
    return "You don't have standing to propose changes in this workspace yet — ask a steward for access.";
  }
  if (status === 401) return "Your session expired. Sign in again to submit this.";
  if (detail) return detail;
  if (code) return code.replace(/_/g, " ");
  return `Couldn't submit (HTTP ${status}).`;
}

/** Open an `edit_note` content proposal carrying the editor's current text. */
export function submitForReview(noteId: string, content: string): Promise<ReviewResult<{ id: string }>> {
  return call<{ id: string }>("/content/propose", "POST", { action: "edit_note", target: noteId, content });
}

/** This note's revision history, newest first. */
export async function fetchRevisions(noteId: string): Promise<ReviewResult<NoteRevision[]>> {
  const r = await call<{ revisions: NoteRevision[] }>(`/notes/${encodeURIComponent(noteId)}/revisions`, "GET");
  return r.ok ? { ok: true, data: r.data?.revisions ?? [] } : r;
}
