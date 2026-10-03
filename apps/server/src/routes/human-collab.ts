/**
 * POST /api/collab/:id/commands — bounded collaboration commands for people and
 * capability-link guests (suggest-only enforcement, R07/R12; engine + receipt
 * design in ../human-collab.ts, client contract in
 * docs/roadmap/workspace-experience/BACKEND-STATUS.md).
 *
 * Mounted BEFORE the gateway's owner/admin passthrough. Order of checks:
 *   rate limit → credential (401) → CSRF / JSON content type → strict schema
 *   → workspace binding → note read + collab level (403) → prose only (400)
 *   → durable-receipt fast path → open the live document → FRESH credential,
 *   grants, note and access-revision check → synchronous mutation → store →
 *   200 only once the receipt is durable.
 *
 * Authorization is the collab socket's own projection (`collabLevelFor`), over
 * the same grants the socket would combine (the signed-in account's + a `?t=`
 * capability's in the same vault), so the endpoint and the socket cannot
 * disagree about who may suggest. Identity is ALWAYS server-derived: the body's
 * schema is strict and has no author/name/color/actor fields at all.
 */
import { Hono, type Context } from "hono";
import * as z from "zod/v4";
import * as Y from "yjs";
import { HUMAN_COLLAB_LIMITS, type HumanCollabCommand, type HumanCollabErrorBody, type HumanCollabErrorCode } from "@prism/core/collab-commands";
import { accessRevision } from "../access-events";
import { resolveActor, requestVia } from "../auth/actor";
import { verifyCapability } from "../auth/capability";
import { CollabBusyError, DocumentTooComplexError, collabLevelFor, docNameFor, ensureRenderedSize, hocuspocus, isDocBlocked, isNoteId, noteCollabWriter, noteKind } from "../collab";
import { ConversionError } from "../convert/service";
import { colorFor } from "../collab-ops";
import { getCollabReceipt, getFederatedByLocal, getFederationEnabled, getUser, getVaultRegistry, grantsForCapability, type Grant } from "../db";
import { documentActorId, executeHumanCommand, findReceipt, HumanCommandError, pruneReceiptsIfDue, safeAuthorName, textProblem, type HumanCommandOutcome } from "../human-collab";
import { consumeRateLimit, rateLimit } from "../middleware/ratelimit";
import { config } from "../config";
import { vaultClient, VaultError, type Note } from "../parachute";
import { atLeast, type Level } from "../permissions";
import { creatorNameFor } from "../sharing";
import type { Role } from "../roles";
import { csrfRefusal, readCapped } from "./actions";

const base = {
  requestId: z.uuid(),
  createdAt: z.number().int().nonnegative(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
};
// Text hygiene (human-collab.ts `textProblem`): well-formed Unicode and no
// control characters everywhere; suggested text additionally nothing the stored
// HTML could not reproduce. A violation is a plain 400 like any schema error.
const clean = (kind: "suggest" | "comment" | "quote") => (v: string) => textProblem(v, kind) === null;
const range = {
  from: z.number().int().min(0).max(50_000_000),
  to: z.number().int().min(0).max(50_000_000),
  quote: z.string().max(HUMAN_COLLAB_LIMITS.quote).refine(clean("quote")),
};
const threadId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const text = z.string().max(HUMAN_COLLAB_LIMITS.text).refine(clean("suggest"));
const commentText = z.string().min(1).max(HUMAN_COLLAB_LIMITS.commentText).refine(clean("comment"));
/** STRICT: an unknown key (author, user, color, actorId, marks, …) is a 400. */
const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, ...range, kind: z.literal("suggest"), text }),
  z.strictObject({ ...base, ...range, kind: z.literal("comment"), text: commentText }),
  // NP-CO-02: a page-level thread — text only (no range, no quote, no thread id).
  z.strictObject({ ...base, kind: z.literal("page-comment"), text: commentText.refine((v) => v.trim().length > 0) }),
  z.strictObject({ ...base, kind: z.literal("reply"), threadId, text: commentText }),
  z.strictObject({ ...base, kind: z.literal("resolve"), threadId, resolved: z.boolean() }),
  z.strictObject({ ...base, kind: z.literal("delete-comment"), threadId }),
]);

/** The server-resolved caller. */
interface Caller {
  /** Receipt identity. */
  identity: string;
  email: string | null;
  role: Role;
  vaultId: string;
  grants: Grant[];
}

/**
 * Resolve the caller from the request's credentials — the same combination the
 * collab socket's `resolveLevel` makes: a signed-in account (session or device
 * token) plus, unless it is the vault owner, the grants of a `?t=` capability in
 * that vault; or the capability alone for a guest. Re-run for the final check,
 * so it always reads the CURRENT session, device token and grant rows.
 */
function resolveCaller(c: Context): Caller | null {
  const actor = resolveActor(c);
  if (actor.kind === "anon") return null;
  if (actor.kind === "link") {
    return { identity: `capability:${actor.capabilityId}`, email: null, role: "guest", vaultId: actor.vaultId, grants: actor.grants };
  }
  let grants = actor.grants;
  const header = c.req.header("authorization");
  const token = c.req.query("t") ?? (header?.startsWith("Capability ") ? header.slice("Capability ".length) : undefined);
  if (actor.role !== "owner" && token) {
    const claims = verifyCapability(token);
    if (claims) grants = grants.concat(grantsForCapability(claims.id).filter((g) => g.vault_id === actor.vaultId));
  }
  return { identity: `user:${actor.email}`, email: actor.email, role: actor.role, vaultId: actor.vaultId, grants };
}

const noteRef = (note: Note) => ({
  id: note.id,
  tags: note.tags ?? [],
  path: note.path ?? null,
  creator: typeof note.metadata?.prism_creator === "string" ? note.metadata.prism_creator : null,
  visibility: (note.metadata?.prism_visibility === "private" ? "private" : "workspace") as "private" | "workspace",
});
const levelOf = (who: Caller, note: Note): Level | null => collabLevelFor(who.grants, noteRef(note), who.role, who.email);
const kindOf = (note: Note) => noteKind({ path: note.path ?? null, tags: note.tags ?? null, metadata: note.metadata ?? null, content: note.content });

function fail(c: Context, status: number, error: HumanCollabErrorCode, message: string, extra: Partial<HumanCollabErrorBody> = {}): Response {
  return c.json({ error, message, ...extra } satisfies HumanCollabErrorBody, status as never);
}

/** The collab document a note is served under (its space key when federated). */
function documentNameFor(vaultId: string, noteId: string): string {
  if (getFederationEnabled()) {
    const fed = getFederatedByLocal(noteId);
    if (fed && (fed.vault_id ?? "primary") === vaultId) return fed.space_note_key;
  }
  return docNameFor(vaultId, noteId);
}

type Direct = Awaited<ReturnType<typeof hocuspocus.openDirectConnection>>;
/**
 * Let go of the document. `store` runs the normal immediate store (and unload).
 * A REFUSED command must not cause a write, so it releases without storing — a
 * store here would, e.g., convert a never-opened Markdown note to collab HTML on
 * behalf of a request that was rejected.
 */
async function release(conn: Direct, store: boolean): Promise<void> {
  if (store) return conn.disconnect();
  const doc = conn.document;
  if (!doc) return;
  conn.document = null;
  doc.removeDirectConnection();
  if (doc.getConnectionsCount() === 0) await hocuspocus.unloadDocument(doc);
}

export const humanCollabApi = new Hono();

humanCollabApi.use("*", rateLimit({ max: 120, windowMs: 60_000, name: "human-collab" }));

humanCollabApi.post("/:id/commands", async (c) => {
  c.header("Cache-Control", "no-store");
  const who = resolveCaller(c);
  if (!who) return fail(c, 401, "unauthenticated", "Sign in or open a valid sharing link.");
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;

  const raw = await readCapped(c.req.raw, HUMAN_COLLAB_LIMITS.body);
  let json: unknown = null;
  try {
    json = raw === null ? null : JSON.parse(raw);
  } catch {
    /* handled below */
  }
  const parsed = commandSchema.safeParse(json);
  if (!parsed.success) {
    // Say WHY when it is the text (the user can fix that); never echo the body.
    const j = json as { kind?: unknown; text?: unknown } | null;
    const why = j && typeof j.text === "string" && (j.kind === "suggest" || j.kind === "comment" || j.kind === "page-comment" || j.kind === "reply") ? textProblem(j.text, j.kind === "suggest" ? "suggest" : "comment") : null;
    return fail(c, 400, "invalid_command", why ?? "That collaboration request is not valid.");
  }
  const command = parsed.data as HumanCollabCommand;

  // A note is addressed ONLY by its id. The vault also resolves /notes/:x by
  // path and by unique title; letting such an alias through would open a SECOND
  // collab document (and snapshot row) for the same note, whose store would
  // then be folded over the real live document. So: a strict id shape before
  // any vault call, and below the resolved note must BE that id — anything else
  // answers exactly like a note that does not exist.
  const id = c.req.param("id");
  const missing = () => fail(c, 404, "not_found", "This document is not available.");
  if (!id || !isNoteId(id)) return missing();

  // Workspace binding: a request that names a workspace must name the one this
  // caller is bound to (a link's own vault; a known vault for an account).
  const named = c.req.header("x-prism-vault");
  const registered = getVaultRegistry().some((v) => v.id === who.vaultId);
  if (!registered || (named !== undefined && named !== who.vaultId)) {
    return fail(c, 403, "vault_mismatch", "This request does not belong to the document's workspace. Reopen the document.");
  }

  // Per actor, per document: far below the per-IP limiter above, because every
  // accepted command makes the server re-hash and re-diff the document. Keyed on
  // the server-derived identity; refusals that never reach this line (bad body,
  // bad id, wrong workspace) do not count.
  const wait = consumeRateLimit(`human-collab-actor:${who.vaultId}:${id}:${who.identity}`, config.collabCommandsPerMinute, 60_000);
  if (wait !== null) {
    c.header("Retry-After", String(wait));
    return fail(c, 429, "rate_limited", "You are sending changes to this document too quickly. Wait a moment and try again.", { retry: true });
  }

  const receiptKey = { vaultId: who.vaultId, noteId: id, actor: who.identity };
  try {
    const note = await vaultClient(who.vaultId).getNote(id);
    if (note.id !== id) return missing(); // resolved through a path/title alias
    const level = levelOf(who, note);
    if (!atLeast(level, "suggest")) return fail(c, 403, "forbidden", "Suggest access is required for this document.");
    // A locked page keeps comments open but takes no suggested edits.
    if (command.kind === "suggest" && note.metadata?.prism_locked === true) return fail(c, 423, "locked", "This page is locked. Suggestions are paused until it is unlocked.");
    const kind = kindOf(note);
    if (kind !== "document") {
      return fail(c, 400, "unsupported_kind", `Suggested edits and anchored comments are available only for prose documents. This ${kind} is view-only with suggest access.`, { noteKind: kind });
    }

    // Lost-acknowledgement fast path: a confirmed receipt answers by itself —
    // no document load, no revision check (the document may have moved on).
    const prior = findReceipt(receiptKey, command);
    if (prior?.state === "durable") {
      c.header("Idempotent-Replayed", "true");
      return c.json(prior.result);
    }

    pruneReceiptsIfDue();
    const docName = documentNameFor(who.vaultId, id);
    const TOO_COMPLEX = "This page is too large or complex for the live editor, so suggestions and comments are unavailable on it.";
    let conn: Direct;
    try {
      conn = await hocuspocus.openDirectConnection(docName, { human: who.identity });
    } catch (e) {
      // The note's body cannot be converted in budget: it has no live document at all.
      if (e instanceof DocumentTooComplexError) return fail(c, 413, "document_too_large", TOO_COMPLEX);
      if (e instanceof CollabBusyError) return fail(c, 503, "not_confirmed", "The server is busy. Keep your draft and retry the same request.", { retry: true });
      throw e;
    }
    let outcome: HumanCommandOutcome | null = null;
    try {
      if (!conn.document) return fail(c, 502, "upstream_error", "The live document could not be opened. Keep your draft and retry the same request.", { retry: true });
      // A blocked document (its note changed to content it cannot absorb) is never stored again.
      if (isDocBlocked(docName)) return fail(c, 413, "document_too_large", TOO_COMPLEX);
      // The engine needs the document's rendered size; measure it off the main
      // thread now (a no-op once known), so its synchronous section never renders.
      try {
        await ensureRenderedSize(conn.document as unknown as Y.Doc, { actor: who.identity });
      } catch (e) {
        if (!(e instanceof ConversionError)) throw e;
        return e.reason === "busy"
          ? fail(c, 503, "not_confirmed", "The server is busy. Keep your draft and retry the same request.", { retry: true })
          : fail(c, 413, "document_too_large", TOO_COMPLEX);
      }
      // Everything above awaited (note read, document load). Read the note once
      // more, then decide and mutate with NO await in between: the credential,
      // the grant rows, the workspace, the note's privacy/tags and the access
      // revision are all re-read in the same tick as the mutation.
      const revision = accessRevision();
      const fresh = await vaultClient(who.vaultId).getNote(id);
      if (fresh.id !== id) return missing();
      // ── synchronous from here to the end of executeHumanCommand ──
      const now = resolveCaller(c);
      const nowLevel = now ? levelOf(now, fresh) : null;
      if (revision !== accessRevision() || !now || now.identity !== who.identity || now.vaultId !== who.vaultId || !atLeast(nowLevel, "suggest")) {
        return fail(c, 403, "access_changed", "Your access to this document changed. Reopen it before trying again.");
      }
      const freshKind = kindOf(fresh);
      if (freshKind !== "document") {
        return fail(c, 400, "unsupported_kind", "This note is no longer a prose document.", { noteKind: freshKind });
      }
      const name = safeAuthorName(now.email ? creatorNameFor(now.email) ?? "Member" : "Guest");
      outcome = executeHumanCommand(conn.document as unknown as Y.Doc, {
        ...receiptKey,
        docName,
        level: nowLevel as Level,
        author: { name, color: colorFor(now.identity), actorId: documentActorId(now.identity) },
      }, command);
      // History attribution for the store below (a suggestion / comment, not a direct edit).
      if (!outcome.replayed) noteCollabWriter(docName, now.email ?? "link", "suggestion");
    } finally {
      // Store only when a command is (or was) applied; a refusal writes nothing.
      await release(conn, outcome !== null);
    }

    // Answer only for a change that is on disk. If the store could not confirm
    // it (vault write failed), the client keeps its draft and retries the SAME
    // request: that finds the receipt and never applies it twice.
    const final = getCollabReceipt(who.vaultId, id, who.identity, command.requestId);
    if (final?.state !== "durable") {
      return fail(c, 503, "not_confirmed", "The change could not be confirmed as saved yet. Keep your draft and retry the same request.", { retry: true });
    }
    if (outcome.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(outcome.result);
  } catch (error) {
    if (error instanceof HumanCommandError) return fail(c, error.status, error.code, error.message, error.retry ? { retry: true } : {});
    if (error instanceof VaultError && error.status === 404) return missing();
    console.error("[human-collab] command failed:", error instanceof Error ? error.name : "unknown");
    return fail(c, 502, "upstream_error", "The change could not be confirmed. Keep your draft and retry the same request.", { retry: true });
  }
});
