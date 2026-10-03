/**
 * Export routes (wave 3A; engine in ../transfer/export.ts). Mounted in api.ts
 * BEFORE the owner short-circuit — these are Prism routes, not vault routes.
 *
 *   POST   /api/export                {scope:"page"|"vault", noteId?, format:"markdown"|"html",
 *                                      subpages?=true, attachments?=true}       → 202 {jobId}
 *   GET    /api/export/:id            → ExportJob (progress; the caller's own job only)
 *   GET    /api/export/:id/download   → the ZIP, streamed (state must be "done")
 *   DELETE /api/export/:id            → cancel + delete
 *
 * AUTH. A signed-in account only (session cookie or `pd_` device token):
 * capability links / anon → 401, an in-process MCP actor or the loopback owner
 * token → 403 (an export is a bulk read a person asks for). `scope:"vault"` needs
 * the admin role; `scope:"page"` needs VIEW on the page (strict id; not viewable,
 * missing and trashed all answer 404). What is INCLUDED is decided per note by
 * the engine with the caller's own view caps — the role only opens the door.
 * POST is CSRF-guarded (`csrfRefusal`), DELETE by the origin checks. One running
 * export per account, `EXPORT_MAX_CONCURRENT` (2) in all, `EXPORT_STARTS_PER_HOUR`
 * (20) per account. A job id is 128 random bits AND bound to (account, vault).
 */
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ExportFormat, ExportJob, ExportScope } from "@prism/core/import-export";
import { config, type VaultEntry } from "../config";
import { resolveVaultEntry } from "../db";
import { resolveActor, requestVia, type Actor } from "../auth/actor";
import { roleAtLeast } from "../roles";
import { isNoteId } from "../collab";
import { consumeRateLimit } from "../middleware/ratelimit";
import { contentDisposition } from "../attachments";
import { csrfRefusal } from "./actions";
import { activeJobs, createJob, dropJob, envInt, findJob, type Job } from "../transfer/jobs";
import { exportCandidates, exportConfig, runExport, type ExportProgress, type ExportSpec, type UserActor } from "../transfer/export";

export const exportApi = new Hono();

const NOT_FOUND = { error: "not_found" };
const isAdmin = (a: Actor) => roleAtLeast(a.role, "admin");
const entryFor = (c: Context, a: Actor): VaultEntry => (isAdmin(a) ? resolveVaultEntry(c.req.header("x-prism-vault")) : resolveVaultEntry(a.vaultId));

/** A signed-in PERSON (session/device), or the refusal. */
export function personOrRefusal(c: Context): UserActor | Response {
  const via = requestVia(c);
  if (via === "mcp" || via === "local-token") return c.json({ error: "forbidden", detail: "not available to agents" }, 403);
  const actor = resolveActor(c);
  if (actor.kind !== "user" || (via !== "session" && via !== "device")) return c.json({ error: "unauthorized" }, 401);
  return actor;
}

export function originRefusal(c: Context): Response | null {
  if (requestVia(c) === "device") return null;
  const site = (c.req.header("sec-fetch-site") ?? "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return c.json({ error: "csrf_refused" }, 403);
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    const o = origin.replace(/\/+$/, "");
    if (o !== config.appOrigin && !config.nativeOrigins.includes(o)) return c.json({ error: "csrf_refused" }, 403);
  }
  return null;
}

function rateLimited(c: Context, key: string, max: number, windowMs: number): Response | null {
  const retry = consumeRateLimit(key, max, windowMs);
  if (retry === null) return null;
  c.header("Retry-After", String(retry));
  return c.json({ error: "rate_limited", retryAfter: retry }, 429);
}

const shape = (job: Job<ExportProgress>): ExportJob => ({
  id: job.id,
  state: job.state,
  scope: job.progress.scope,
  format: job.progress.format,
  done: job.progress.done,
  total: job.progress.total,
  attachments: job.progress.attachments,
  skipped: job.progress.skipped,
  bytes: job.progress.bytes,
  fileName: job.state === "done" ? job.progress.fileName : null,
  error: job.error,
  expiresAt: job.expiresAt,
});

exportApi.post("/export", bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
  const actor = personOrRefusal(c);
  if (actor instanceof Response) return actor;
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "bad_request", detail: "body must be a JSON object" }, 400);
  for (const k of Object.keys(body)) if (!["scope", "noteId", "format", "subpages", "attachments"].includes(k)) return c.json({ error: "bad_request", detail: `unknown field: ${k.slice(0, 40)}` }, 400);
  const scope = body.scope as ExportScope;
  const format = body.format as ExportFormat;
  if (scope !== "page" && scope !== "vault") return c.json({ error: "bad_request", detail: "scope must be page or vault" }, 400);
  if (format !== "markdown" && format !== "html") return c.json({ error: "bad_request", detail: "format must be markdown or html" }, 400);
  for (const k of ["subpages", "attachments"] as const) if (body[k] !== undefined && typeof body[k] !== "boolean") return c.json({ error: "bad_request", detail: `${k} must be a boolean` }, 400);
  if (scope === "vault" && !isAdmin(actor)) return c.json({ error: "forbidden", detail: "exporting the whole workspace is limited to the owner and admins" }, 403);
  let rootId: string | undefined;
  if (scope === "page") {
    if (typeof body.noteId !== "string" || !isNoteId(body.noteId)) return c.json(NOT_FOUND, 404);
    rootId = body.noteId;
  }
  const who = actor.email.toLowerCase();
  const limited = rateLimited(c, `export-start:${who}`, envInt("EXPORT_STARTS_PER_HOUR", 20, 1), 3_600_000);
  if (limited) return limited;
  const mine = activeJobs("export", who)[0];
  if (mine) return c.json({ error: "busy", detail: "another export of yours is still running", jobId: mine.id }, 409);
  if (activeJobs("export").length >= envInt("EXPORT_MAX_CONCURRENT", 2, 1)) {
    c.header("Retry-After", "30");
    return c.json({ error: "busy" }, 503);
  }

  const entry = entryFor(c, actor);
  const spec: ExportSpec = { entry, actor: { ...actor, vaultId: entry.id }, scope, rootId, format, subpages: body.subpages !== false, attachments: body.attachments !== false };
  let rows;
  try {
    rows = await exportCandidates(spec);
  } catch (e) {
    console.warn(`[export] listing failed: ${(e as Error).message}`);
    return c.json({ error: "vault_unreachable" }, 502);
  }
  if (!rows) return c.json(NOT_FOUND, 404);
  if (rows.length > exportConfig().maxNotes) return c.json({ error: "too_large", detail: "too many pages for one export" }, 413);
  const job = createJob<ExportProgress>("export", who, entry.id, { scope, format, done: 0, total: rows.length, attachments: 0, skipped: 0, bytes: 0, fileName: null, filePath: null });
  void runExport(job, spec, rows);
  c.header("Cache-Control", "private, no-store");
  return c.json({ jobId: job.id, total: rows.length }, 202);
});

function ownJob(c: Context): Job<ExportProgress> | Response {
  const actor = personOrRefusal(c);
  if (actor instanceof Response) return actor;
  const limited = rateLimited(c, `export-read:${actor.email.toLowerCase()}`, 600, 60_000);
  if (limited) return limited;
  // Bound to the ACCOUNT (and an unguessable id); the job remembers its own vault, so a
  // plain browser download — which cannot send X-Prism-Vault — still finds it.
  const job = findJob<ExportProgress>("export", c.req.param("id") ?? "", actor.email);
  return job ?? c.json(NOT_FOUND, 404);
}

exportApi.get("/export/:id", (c) => {
  const job = ownJob(c);
  if (job instanceof Response) return job;
  c.header("Cache-Control", "private, no-store");
  return c.json(shape(job));
});

exportApi.get("/export/:id/download", (c) => {
  const job = ownJob(c);
  if (job instanceof Response) return job;
  const path = job.progress.filePath;
  if (job.state !== "done" || !path) return c.json({ error: "not_ready", state: job.state }, 409);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return c.json(NOT_FOUND, 404);
  }
  return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(size),
      "Content-Disposition": contentDisposition("attachment", job.progress.fileName ?? "export.zip"),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});

exportApi.delete("/export/:id", (c) => {
  const csrf = originRefusal(c);
  if (csrf) return csrf;
  const job = ownJob(c);
  if (job instanceof Response) return job;
  job.cancelled = true;
  // A running job cleans up after itself when it sees the flag; a finished one is dropped now.
  if (job.state !== "running" && job.state !== "queued") dropJob(job as Job<unknown>);
  return c.json({ ok: true });
});
