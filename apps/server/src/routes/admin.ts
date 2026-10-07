/**
 * Server-owner maintenance jobs (parity A) — `/api/admin/*`, mounted BEFORE the
 * gateway so the owner short-circuit never proxies these to the vault.
 *
 *   POST /api/admin/wikilinks/resolve {dryRun?: boolean = true}  → 202 {job}
 *   GET  /api/admin/wikilinks/resolve                             → {job | null}
 *   POST /api/admin/wikilinks/resolve/cancel                      → {ok}
 *
 * SERVER OWNER only (by email, like live actions — never a vault admin or a
 * vault-role owner: the job writes across the whole active vault with the
 * server's vault token). Mutations pass the live-actions CSRF guard. The job
 * runs on the owner's ACTIVE vault (X-Prism-Vault). See wikilinks-job.ts.
 */
import { Hono, type Context } from "hono";
import { config } from "../config";
import { resolveActor, requestVia } from "../auth/actor";
import { vaultClient } from "../parachute";
import { csrfRefusal } from "./actions";
import { cancelWikilinkJob, startWikilinkJob, wikilinkJobStatus, WikilinkJobBusyError, type WikilinkJob } from "../wikilinks-job";
import { recordAction } from "../actions/store";
import { deleteCollabSetAside, getCollabSetAside, listCollabSetAside, listCollabUnsaved } from "../db";
import { mountPeopleCandidates, mountPeopleLinkJob, mountPeopleMerge, mountPeopleOwner } from "./people-admin";

export const adminApi = new Hono();

const ownerVault = (c: Context): string | null => {
  const a = resolveActor(c);
  return a.kind === "user" && a.email === config.ownerEmail ? a.vaultId : null;
};

adminApi.use("*", async (c, next) => {
  if (ownerVault(c) === null) return c.json({ error: "forbidden" }, 403);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const csrf = csrfRefusal(c, requestVia(c));
    if (csrf) return csrf;
  }
  await next();
});

// ── pages whose live changes are not in the vault (collab_unsaved) ────────────
//   GET  /api/admin/collab/unsaved                       → {rows:[{vaultId,noteId,reason,permanent,since,attempts}]}
//   POST /api/admin/collab/unsaved/:id/discard {confirm:true, force?:true}   (force: a row that is still being retried)
// The way out of a page that can NEVER be saved as it is (too large to render,
// refused by the vault, given up on): the live changes the vault lacks are
// dropped and the document becomes the stored page again (collab.ts
// `discardUnsavedChanges`). Destructive, so: server owner, the CSRF guard above,
// a human origin, an explicit `confirm`, and one audit row with counts only.
adminApi.get("/collab/unsaved", (c) => {
  const vaultId = ownerVault(c)!;
  c.header("Cache-Control", "no-store");
  return c.json({
    rows: listCollabUnsaved(200, vaultId).map((r) => ({ vaultId: r.vault_id, noteId: r.name, reason: r.reason, permanent: r.permanent === 1, since: r.since, attempts: r.attempts })),
    // What a page held when the vault's copy REPLACED its unsaved live changes because no
    // merge could be trusted (`uncertain_base`) or no base was known (`no_base`). Nothing
    // typed is destroyed silently: the text is here (ids + sizes; the body by id, below).
    setAside: listCollabSetAside(vaultId).map((r) => ({ id: r.id, vaultId: r.vault_id, noteId: r.name, at: r.at, reason: r.reason, kind: r.kind, bytes: r.bytes })),
  });
});
//   GET    /api/admin/collab/set-aside/:id   → {id, noteId, at, reason, kind, body}  (the page as plain text)
//   DELETE /api/admin/collab/set-aside/:id
// 🔒 A DELIBERATE EXCEPTION to "the owner's own view": `body` is the text of a page
// — possibly ANOTHER member's private page — as its live document held it when the
// vault's copy replaced it. It is the only recovery path for that text, so it
// stays; in exchange it is the server owner by e-mail, a HUMAN origin (a session
// or device credential — never the Prism MCP, never the loopback token), and every
// read and delete writes an `action_audit` row (ids only, never the text). Rows
// go after 90 days and with their note (purge from Trash / delete).
const setAsideId = (raw: string): number | null => (/^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null);
const setAsideAccess = (c: Context, action: "admin.collab-set-aside-read" | "admin.collab-set-aside-delete") => {
  const vaultId = ownerVault(c)!;
  const actor = resolveActor(c) as Extract<ReturnType<typeof resolveActor>, { kind: "user" }>;
  const via = requestVia(c);
  const human = via === "session" || via === "device";
  const audit = (status: "ok" | "failed" | "refused", target: Record<string, unknown>, error?: string) =>
    recordAction({ actorEmail: actor.email, via, origin: human ? "human" : "agent", action, vaultId, target, status, error });
  return { vaultId, human, audit, id: setAsideId(c.req.param("id") ?? "") };
};
adminApi.get("/collab/set-aside/:id", (c) => {
  const { vaultId, human, audit, id } = setAsideAccess(c, "admin.collab-set-aside-read");
  if (!human) {
    audit("refused", { id }, "agent_origin_refused");
    return c.json({ error: "agent_origin_refused" }, 403);
  }
  const row = id === null ? null : getCollabSetAside(id, vaultId);
  if (!row) {
    audit("refused", { id }, "not_found");
    return c.json({ error: "not_found" }, 404);
  }
  audit("ok", { id: row.id, noteId: row.name, reason: row.reason, kind: row.kind, bytes: row.bytes });
  c.header("Cache-Control", "no-store");
  return c.json({ id: row.id, vaultId: row.vault_id, noteId: row.name, at: row.at, reason: row.reason, kind: row.kind, body: row.body });
});
adminApi.delete("/collab/set-aside/:id", (c) => {
  const { vaultId, human, audit, id } = setAsideAccess(c, "admin.collab-set-aside-delete");
  if (!human) {
    audit("refused", { id }, "agent_origin_refused");
    return c.json({ error: "agent_origin_refused" }, 403);
  }
  const row = id === null ? null : getCollabSetAside(id, vaultId);
  if (!row || !deleteCollabSetAside(row.id, vaultId)) {
    audit("refused", { id }, "not_found");
    return c.json({ error: "not_found" }, 404);
  }
  audit("ok", { id: row.id, noteId: row.name });
  return c.json({ ok: true });
});
adminApi.post("/collab/unsaved/:id/discard", async (c) => {
  const vaultId = ownerVault(c)!;
  const actor = resolveActor(c) as Extract<ReturnType<typeof resolveActor>, { kind: "user" }>;
  const via = requestVia(c);
  if (via !== "session" && via !== "device") return c.json({ error: "agent_origin_refused" }, 403);
  const id = c.req.param("id");
  const body = (await c.req.json<{ confirm?: unknown; force?: unknown }>().catch(() => ({}))) as { confirm?: unknown; force?: unknown };
  const collab = await import("../collab"); // lazily: collab ⇄ routes import cycle
  if (!collab.isNoteId(id)) return c.json({ error: "not_found" }, 404);
  if (body.confirm !== true) return c.json({ error: "confirm_required", detail: "send {\"confirm\": true} — the page's unsaved live changes are dropped for good" }, 400);
  const audit = (status: "ok" | "failed" | "refused", target: Record<string, unknown>, error?: string) =>
    recordAction({ actorEmail: actor.email, via, origin: "human", action: "admin.collab-discard-unsaved", vaultId, target, status, error });
  let result: Awaited<ReturnType<typeof collab.discardUnsavedChanges>>;
  try {
    result = await collab.discardUnsavedChanges(vaultId, id, { force: body.force === true });
  } catch (e) {
    audit("failed", { discarded: 0 }, e instanceof Error ? e.message : "error");
    return c.json({ error: "upstream_error" }, 502);
  }
  if (result.reason === "none") return c.json({ error: "not_found", detail: "that page has no unsaved live changes" }, 404);
  if (result.reason === "not_permanent") {
    audit("refused", { discarded: 0, permanent: 0 }, "not_permanent");
    return c.json({ error: "not_permanent", detail: "this page's changes are still being saved (the server keeps retrying) — discarding them needs {\"confirm\": true, \"force\": true}" }, 409);
  }
  if (!result.discarded) {
    audit("refused", { discarded: 0, permanent: result.permanent ? 1 : 0 }, result.reason ?? undefined);
    return result.reason === "busy" ? c.json({ error: "busy", retry: true }, 503) : c.json({ error: "vault_unreachable", retry: true }, 502);
  }
  audit("ok", { discarded: 1, permanent: result.permanent ? 1 : 0, live: result.live ? 1 : 0 });
  return c.json({ ok: true, discarded: true, live: result.live });
});

adminApi.get("/wikilinks/resolve", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ job: wikilinkJobStatus() });
});

adminApi.post("/wikilinks/resolve", async (c) => {
  const body = (await c.req.json<{ dryRun?: unknown }>().catch(() => ({}))) as { dryRun?: unknown };
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return c.json({ error: "bad_request", detail: "dryRun must be true or false" }, 400);
  const dryRun = body.dryRun !== false; // dry run unless explicitly false
  const vaultId = ownerVault(c)!;
  const actor = resolveActor(c) as Extract<ReturnType<typeof resolveActor>, { kind: "user" }>;
  const via = requestVia(c);
  // A WRITE run is recorded in action_audit when it ends (security review M3):
  // counts only — no note ids, paths or link targets.
  const onEnd = dryRun
    ? undefined
    : (j: WikilinkJob) =>
        recordAction({
          actorEmail: actor.email,
          via,
          origin: via === "session" || via === "device" ? "human" : "agent",
          action: "admin.wikilinks-resolve",
          vaultId,
          target: { jobId: j.id, status: j.status, scanned: j.scanned, resolved: j.resolved, notesUpdated: j.notesUpdated, ambiguous: j.ambiguous, conflicts: j.conflicts, errors: j.errors },
          status: j.status === "done" ? "ok" : "failed",
          error: j.error,
        });
  try {
    const { job } = startWikilinkJob(vaultClient(vaultId), vaultId, { dryRun, onEnd });
    console.log(`[admin] wikilink resolve started (${dryRun ? "dry run" : "WRITE"}) on vault ${vaultId}`);
    return c.json({ job }, 202);
  } catch (e) {
    if (e instanceof WikilinkJobBusyError) return c.json({ error: "busy", detail: e.message, job: wikilinkJobStatus() }, 409);
    throw e;
  }
});

adminApi.post("/wikilinks/resolve/cancel", (c) => c.json({ ok: cancelWikilinkJob() }));

// Identity + linking layer (review queue, backfill job, duplicate merge): /api/admin/people/*.
mountPeopleCandidates(adminApi);
mountPeopleOwner(adminApi);
mountPeopleLinkJob(adminApi);
mountPeopleMerge(adminApi);
