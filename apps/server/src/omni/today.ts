/**
 * `GET /api/omni/today` (M2, read-only aggregation). Every section is built from an
 * existing Prism route, called IN-PROCESS with the requesting owner's own credential
 * (`dispatch`), so the answer is exactly what that person may read — nothing here
 * reads the vault around the gateway. A section that fails is `null` with its code in
 * `errors`; the others still answer.
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

async function query(dispatch: Dispatch, spec: Record<string, unknown>): Promise<{ rows: Row[]; identity?: string }> {
  const res = await dispatch("/api/query", { method: "POST", body: spec });
  if (!res.ok) throw new Error(`query_${res.status}`);
  const j = (await res.json()) as { rows?: Row[]; identity?: string };
  return { rows: Array.isArray(j.rows) ? j.rows : [], identity: j.identity };
}

export async function buildToday(dispatch: Dispatch, date: string): Promise<Record<string, unknown>> {
  const errors: Record<string, string> = {};
  const origin = omniConfig.appOrigin();
  const link = (id: string) => `${origin}/page/${encodeURIComponent(id)}`;

  const agendaP = query(dispatch, {
    tags: ["meeting"],
    filter: { match: "all", conditions: [{ key: "date", op: "eq", value: date }] },
    sort: [{ key: "start", dir: "asc" }],
    limit: 100,
    fields: ["title", "start", "end", "location", "meetLink", "event_status", "date"],
  })
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
  })
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
