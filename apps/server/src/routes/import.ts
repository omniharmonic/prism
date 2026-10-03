/**
 * Import routes (wave 3A; engine in ../transfer/import.ts). Mounted in api.ts
 * BEFORE the owner short-circuit.
 *
 *   POST   /api/import?dryRun=1|0&parent=<folder>&name=<file name>
 *          body = the file itself (a .zip — incl. a Notion export — or one
 *          .md / .html / .csv), `X-Prism-Import: 1` REQUIRED
 *            dryRun (the DEFAULT) → 200 ImportPreview (nothing is written)
 *            dryRun=0            → 202 {jobId, preview}
 *   GET    /api/import/:id   → ImportJob (progress + result; the caller's own job)
 *   DELETE /api/import/:id   → cancel (pages already written stay; re-running converges)
 *
 * AUTH. Workspace owner/admin only, as a signed-in PERSON (session cookie or
 * `pd_` device token): members/guests → 403, links/anon → 401, in-process MCP and
 * the loopback owner token → 403.
 * CSRF. The body is not JSON, so `csrfRefusal` does not fit; the equivalent is
 * enforced BEFORE the body is read: a custom header (`X-Prism-Import: 1`, which
 * a cross-site form can never send and which forces a CORS preflight), a
 * non-form Content-Type, and the Sec-Fetch-Site / Origin checks for anything
 * but a device token.
 * BOUNDS. `IMPORT_MAX_BYTES` (100 MB) while streaming (hono/body-limit); the body
 * is buffered ONCE, one import request at a time (bounded wait → 503 `busy`);
 * archive limits in the engine; `IMPORT_PER_HOUR` (30 previews, 10 writes) per
 * account; ONE write job at a time per server (409 `busy`).
 */
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { looksLikeZip, type ImportJob } from "@prism/core/import-export";
import type { VaultEntry } from "../config";
import { resolveVaultEntry } from "../db";
import { requestVia, type Actor } from "../auth/actor";
import { roleAtLeast } from "../roles";
import { consumeRateLimit } from "../middleware/ratelimit";
import { BusyError, Semaphore } from "../media/limits";
import { recordAction } from "../actions/store";
import { activeJobs, createJob, envInt, findJob, type Job } from "../transfer/jobs";
import { buildPlan, ImportError, importConfig, previewOf, readUpload, resolveActions, resolveRoot, runImport, type ImportProgress } from "../transfer/import";
import { originRefusal, personOrRefusal } from "./export";

const NOT_FOUND = { error: "not_found" };
const isAdmin = (a: Actor) => roleAtLeast(a.role, "admin");
const entryFor = (c: Context, a: Actor): VaultEntry => resolveVaultEntry(c.req.header("x-prism-vault") ?? a.vaultId);
const CONTENT_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream", "text/markdown", "text/html", "text/csv"]);
const slots = new Semaphore(1, 4);

const isDryRun = (c: Context): boolean => {
  const v = c.req.query("dryRun");
  return !(v === "0" || v === "false");
};

/** Everything that can refuse the request, BEFORE a byte of the body is read. */
async function importGate(c: Context, next: Next) {
  const actor = personOrRefusal(c);
  if (actor instanceof Response) return actor;
  if (!isAdmin(actor)) return c.json({ error: "forbidden", detail: "importing is limited to the owner and admins" }, 403);
  if (c.req.header("x-prism-import") !== "1") return c.json({ error: "csrf_refused", detail: "missing X-Prism-Import header" }, 403);
  const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!CONTENT_TYPES.has(ct)) return c.json({ error: "unsupported_media_type", detail: "send the file itself as the request body" }, 415);
  const csrf = originRefusal(c);
  if (csrf) return csrf;
  const dry = isDryRun(c);
  const retry = consumeRateLimit(`import-${dry ? "dry" : "write"}:${actor.email.toLowerCase()}`, dry ? envInt("IMPORT_PREVIEWS_PER_HOUR", 30, 1) : envInt("IMPORT_WRITES_PER_HOUR", 10, 1), 3_600_000);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "rate_limited", retryAfter: retry }, 429);
  }
  if (!dry && activeJobs("import").length > 0) return c.json({ error: "busy", detail: "another import is still running" }, 409);
  return next();
}

const shape = (job: Job<ImportProgress>): ImportJob => ({
  id: job.id,
  state: job.state,
  destination: job.progress.destination,
  done: job.progress.done,
  total: job.progress.total,
  created: job.progress.created,
  updated: job.progress.updated,
  unchanged: job.progress.unchanged,
  conflicts: job.progress.conflicts,
  attachments: job.progress.attachments,
  failed: job.progress.failed.slice(0, 50),
  problems: job.progress.problems.slice(0, 50),
  firstId: job.progress.firstId,
  error: job.error,
});

export function createImportApi(opts: { onWrite?: () => void } = {}) {
  const importApi = new Hono();

  importApi.post(
    "/import",
    importGate,
    (c, next) => {
      const limit = importConfig().maxBytes;
      return bodyLimit({ maxSize: limit, onError: (cc) => cc.json({ error: "too_large", limit }, 413) })(c, next);
    },
    async (c) => {
      const actor = personOrRefusal(c);
      if (actor instanceof Response) return actor;
      const dryRun = isDryRun(c);
      const fileName = (c.req.query("name") ?? "import").slice(0, 300);
      let release: () => void;
      try {
        release = await slots.acquire(3000);
      } catch (e) {
        if (e instanceof BusyError) {
          c.header("Retry-After", "5");
          return c.json({ error: "busy" }, 503);
        }
        throw e;
      }
      try {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (bytes.length === 0) return c.json({ error: "bad_request", detail: "the file is empty" }, 400);
        if (bytes.length > importConfig().maxBytes) return c.json({ error: "too_large", limit: importConfig().maxBytes }, 413);
        const entry = entryFor(c, actor);
        let upload;
        try {
          upload = readUpload(bytes, fileName);
        } catch (e) {
          if (e instanceof ImportError) return c.json({ error: e.code, detail: e.message }, e.status);
          throw e;
        }
        const single = !looksLikeZip(bytes);
        const parent = c.req.query("parent") ?? (single ? "vault/Imports" : `vault/Imports/${upload.archiveName}`);
        const placed = await resolveRoot(entry, parent);
        if ("status" in placed) return c.json(placed.body, placed.status);
        let plan;
        let resolved;
        try {
          plan = buildPlan(entry, upload.files, placed.root);
          resolved = await resolveActions(entry, plan, placed.existing);
        } catch (e) {
          if (e instanceof ImportError) return c.json({ error: e.code, detail: e.message }, e.status);
          console.warn(`[import] planning failed: ${(e as Error).name}`);
          return c.json({ error: "bad_request", detail: "the file could not be read" }, 400);
        }
        const preview = previewOf(plan, resolved, upload.refused);
        c.header("Cache-Control", "private, no-store");
        if (dryRun) return c.json(preview);
        if (activeJobs("import").length > 0) return c.json({ error: "busy", detail: "another import is still running" }, 409);
        const via = requestVia(c);
        const job = createJob<ImportProgress>("import", actor.email, entry.id, {
          destination: plan.root,
          done: 0,
          total: resolved.length,
          created: 0,
          updated: 0,
          unchanged: 0,
          conflicts: 0,
          attachments: 0,
          failed: [],
          problems: [...upload.refused, ...plan.problems].slice(0, 200),
          firstId: null,
        });
        void runImport(job, entry, { ...actor, vaultId: entry.id }, plan, resolved, {
          onWrite: opts.onWrite,
          // One audit row per WRITE run: counts only — never a path, title or file name.
          onEnd: (j) =>
            recordAction({
              actorEmail: actor.email,
              via,
              origin: "human",
              action: "admin.import",
              vaultId: entry.id,
              target: { jobId: j.id, state: j.state, created: j.progress.created, updated: j.progress.updated, unchanged: j.progress.unchanged, conflicts: j.progress.conflicts, failed: j.progress.failed.length, attachments: j.progress.attachments },
              status: j.state === "done" ? "ok" : "failed",
              error: j.error,
            }),
        });
        return c.json({ jobId: job.id, preview: { ...preview, dryRun: false } }, 202);
      } finally {
        release();
      }
    },
  );

  function ownJob(c: Context): Job<ImportProgress> | Response {
    const actor = personOrRefusal(c);
    if (actor instanceof Response) return actor;
    if (!isAdmin(actor)) return c.json({ error: "forbidden" }, 403);
    const retry = consumeRateLimit(`import-read:${actor.email.toLowerCase()}`, 600, 60_000);
    if (retry !== null) return c.json({ error: "rate_limited", retryAfter: retry }, 429);
    return findJob<ImportProgress>("import", c.req.param("id") ?? "", actor.email, entryFor(c, actor).id) ?? c.json(NOT_FOUND, 404);
  }

  importApi.get("/import/:id", (c) => {
    const job = ownJob(c);
    if (job instanceof Response) return job;
    c.header("Cache-Control", "private, no-store");
    return c.json(shape(job));
  });

  importApi.delete("/import/:id", (c) => {
    const csrf = originRefusal(c);
    if (csrf) return csrf;
    const job = ownJob(c);
    if (job instanceof Response) return job;
    job.cancelled = true;
    return c.json({ ok: true });
  });

  return importApi;
}
