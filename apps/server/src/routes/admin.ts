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
import { mountPeopleCandidates, mountPeopleLinkJob, mountPeopleMerge } from "./people-admin";

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
mountPeopleLinkJob(adminApi);
mountPeopleMerge(adminApi);
