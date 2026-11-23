/**
 * Client error reports (L-1, 2026-11-08).
 *
 * The Mac client's window went flat grey during an agent's edit burst and NOTHING was recorded:
 * the release web view has no console, the macOS log needs admin, and the error never reached
 * the app's error boundary. The client now reports what it can — an uncaught error (also the
 * one that unmounts the whole React root), an unhandled rejection, an error-boundary catch, and
 * a main-thread stall — to the server owner's own server.
 *
 * Owner-only (the admin router's guard: server owner by email + CSRF on writes), so a member's
 * client cannot write here. Each report is bounded field by field and holds no note content by
 * construction of the client (message, stack, route path, build, platform). The newest
 * MAX_ROWS are kept; at most REPORTS_PER_HOUR are accepted per owner.
 */
import { db } from "./db";

db.exec(`
  CREATE TABLE IF NOT EXISTS client_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    stack TEXT,
    route TEXT,
    build TEXT,
    platform TEXT,
    detail TEXT
  )
`);

export const CLIENT_ERROR_KINDS = ["error", "rejection", "boundary", "uncaught", "stall"] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];
export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  route?: string;
  build?: string;
  platform?: string;
  /** Kind-specific, short: e.g. "stalled 4210 ms". */
  detail?: string;
  /** When it happened on the client (ms); the server's clock when absent or implausible. */
  at?: number;
}
export interface ClientErrorRow extends Required<Pick<ClientErrorReport, "kind" | "message">> {
  id: number;
  at: number;
  stack: string | null;
  route: string | null;
  build: string | null;
  platform: string | null;
  detail: string | null;
}

export const MAX_ROWS = 200;
export const REPORTS_PER_HOUR = 60;
const LIMITS = { message: 500, stack: 4_000, route: 200, build: 60, platform: 60, detail: 200 } as const;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : undefined;

/** Strict parse of a report body: unknown keys are dropped, every field is bounded. Null = refused. */
export function parseClientError(body: unknown, now = Date.now()): ClientErrorReport | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (!CLIENT_ERROR_KINDS.includes(o.kind as ClientErrorKind)) return null;
  const message = str(o.message, LIMITS.message);
  if (!message) return null;
  const at = typeof o.at === "number" && Number.isFinite(o.at) && Math.abs(o.at - now) < 7 * 86_400_000 ? Math.round(o.at) : now;
  // A route is a path only: never a query string or a fragment (a share link's ?t= must not land here).
  const route = str(o.route, LIMITS.route)?.split(/[?#]/)[0];
  return {
    kind: o.kind as ClientErrorKind,
    message,
    at,
    ...(str(o.stack, LIMITS.stack) ? { stack: str(o.stack, LIMITS.stack) } : {}),
    ...(route ? { route } : {}),
    ...(str(o.build, LIMITS.build) ? { build: str(o.build, LIMITS.build) } : {}),
    ...(str(o.platform, LIMITS.platform) ? { platform: str(o.platform, LIMITS.platform) } : {}),
    ...(str(o.detail, LIMITS.detail) ? { detail: str(o.detail, LIMITS.detail) } : {}),
  };
}

const accepted: number[] = [];
/** Per-owner hourly budget (there is one owner). Test hook: pass `now`. */
export function takeReportSlot(now = Date.now()): boolean {
  while (accepted.length && now - accepted[0]! > 3_600_000) accepted.shift();
  if (accepted.length >= REPORTS_PER_HOUR) return false;
  accepted.push(now);
  return true;
}
export function resetReportSlotsForTests(): void {
  accepted.length = 0;
}

export function recordClientError(r: ClientErrorReport): number {
  const info = db
    .prepare("INSERT INTO client_errors (at, kind, message, stack, route, build, platform, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(r.at ?? Date.now(), r.kind, r.message, r.stack ?? null, r.route ?? null, r.build ?? null, r.platform ?? null, r.detail ?? null);
  db.prepare("DELETE FROM client_errors WHERE id NOT IN (SELECT id FROM client_errors ORDER BY id DESC LIMIT ?)").run(MAX_ROWS);
  return Number(info.lastInsertRowid);
}

export function listClientErrors(limit = 50): ClientErrorRow[] {
  return db.prepare("SELECT id, at, kind, message, stack, route, build, platform, detail FROM client_errors ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(limit, MAX_ROWS))) as ClientErrorRow[];
}

export function clearClientErrors(): number {
  return db.prepare("DELETE FROM client_errors").run().changes;
}
