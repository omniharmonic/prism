/**
 * `GET /api/omni/today` (M2, read-only aggregation). Every section is built from an
 * existing Prism route, called IN-PROCESS with the requesting owner's own credential
 * (`dispatch`), so the answer is exactly what that person may read — nothing here
 * reads the vault around the gateway. A section that fails is `null` with its code in
 * `errors`; the others still answer. A section whose query failed on the vault side
 * (5xx) is asked once more before it is given up (see `query`).
 *
 *  agenda   — meeting notes (the calendar ingest's `meeting` tag) whose `date` is the day,
 *             cancelled ones dropped, by start.
 *  tasks    — `/api/query {assignedToMe:true}` open tasks, by due date.
 *  needsYou — pending approvals (+ nudges: M3, always [] for now).
 *  inFlight — threads with a running turn.
 */
import { listApprovals, approvalView, expireApprovals } from "./approvals";
import { getThread, runningThreadIds } from "./store";
import { omniConfig } from "./config";
import { leafTitle } from "@prism/core/pages";

export type Dispatch = (path: string, init: { method: string; body?: unknown }) => Promise<Response>;

const OPEN_TASK_EXCLUDE = ["completed", "cancelled", "archived", "done"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in the server's zone (the app normally sends its own `?date=`). */
export function localDate(d = new Date()): string {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 10);
}
export const validDate = (s: string | undefined): s is string => !!s && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));

type Row = { id: string; path: string | null; metadata: Record<string, unknown> };
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const title = (r: Row): string => s(r.metadata.title) ?? leafTitle(r.path ?? r.id, r.metadata) ?? r.id;

/** How long to wait before the one retry of a section whose query failed on the vault side. */
const RETRY_DELAY_MS = 750;
const CODE_RE = /^[a-z0-9_]{1,40}$/;

/**
 * One section's rows. A 5xx from `/api/query` is the VAULT failing that read (it has been
 * seen to refuse a good token, or drop a large listing, once in a while — more so while it
 * is busy with the other section's listing); a read is safe to ask again, so it is retried
 * ONCE after a pause. Anything else (4xx, a thrown dispatch) is final. The error is the
 * route's own code (`vault_error`, `vault_unreachable`, `rate_limited`, …), else
 * `query_<status>` — never the vault's text.
 */
async function query(dispatch: Dispatch, spec: Record<string, unknown>, retryDelayMs: number): Promise<{ rows: Row[]; identity?: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await dispatch("/api/query", { method: "POST", body: spec });
    if (res.ok) {
      const j = (await res.json()) as { rows?: Row[]; identity?: string };
      return { rows: Array.isArray(j.rows) ? j.rows : [], identity: j.identity };
    }
    const inner = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
    if (res.status >= 500 && attempt === 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    throw new Error(typeof inner === "string" && CODE_RE.test(inner) ? inner : `query_${res.status}`);
  }
}

export async function buildToday(dispatch: Dispatch, date: string, opts: { retryDelayMs?: number } = {}): Promise<Record<string, unknown>> {
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const errors: Record<string, string> = {};
  const origin = omniConfig.appOrigin();
  const link = (id: string) => `${origin}/page/${encodeURIComponent(id)}`;

  const agendaP = query(dispatch, {
    tags: ["meeting"],
    filter: { match: "all", conditions: [{ key: "date", op: "eq", value: date }] },
    sort: [{ key: "start", dir: "asc" }],
    limit: 100,
    fields: ["title", "start", "end", "location", "meetLink", "event_status", "date"],
  }, retryDelayMs)
    .then(({ rows }) =>
      rows
        .filter((r) => r.metadata.event_status !== "cancelled")
        .map((r) => ({ noteId: r.id, title: title(r), start: s(r.metadata.start), end: s(r.metadata.end), location: s(r.metadata.location), meetLink: s(r.metadata.meetLink), link: link(r.id) })),
    )
    .catch((e: Error) => {
      errors.agenda = e.message;
      return null;
    });

  const tasksP = query(dispatch, {
    tags: ["task"],
    assignedToMe: true,
    filter: { match: "all", conditions: [{ key: "status", op: "nin", value: OPEN_TASK_EXCLUDE }] },
    sort: [{ key: "due", dir: "asc" }],
    limit: 50,
    fields: ["title", "status", "due", "deadline", "priority", "omni_thread"],
  }, retryDelayMs)
    .then(({ rows, identity }) => ({
      identity: identity ?? null,
      rows: rows.map((r) => ({
        noteId: r.id,
        title: title(r),
        status: s(r.metadata.status),
        due: s(r.metadata.due) ?? s(r.metadata.deadline),
        priority: s(r.metadata.priority),
        threadId: s(r.metadata.omni_thread),
        link: link(r.id),
      })),
    }))
    .catch((e: Error) => {
      errors.tasks = e.message;
      return null;
    });

  expireApprovals();
  const approvals = listApprovals(omniConfig.ownerEmail(), "pending", 50).map(approvalView);
  const inFlight = [...new Set(runningThreadIds())]
    .map((id) => getThread(id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({ id: t.id, title: t.title, state: t.state, lastActivityAt: new Date(t.lastActivityAt).toISOString() }));

  const [agenda, tasks] = await Promise.all([agendaP, tasksP]);
  return {
    date,
    agenda,
    tasks: tasks?.rows ?? null,
    taskIdentity: tasks?.identity ?? null,
    needsYou: { approvals, nudges: [] },
    inFlight,
    openLoops: null,
    brief: null,
    errors,
  };
}
