/**
 * ClickUp → vault task ingester (one-way pull). Pulls tasks assigned to the
 * token's user from every workspace the token sees (narrowable via credential
 * fields) and upserts them as vault task notes, deduped by metadata.source_id.
 * No write-back, no webhooks, no deletion handling in v1.
 *
 * First run (no cursor): backfills OPEN tasks only. Incremental runs: all tasks
 * updated since the cursor (with a 120s overlap applied by the scheduler),
 * including closed ones. The cursor value is the max `date_updated` seen on a
 * COMPLETE clean pass — never Date.now() — so a rate-limited or capped run
 * leaves the cursor where it was and the next slot re-covers the gap. A failed
 * per-task vault write clamps the cursor just below that task's `date_updated`,
 * so the change is re-fetched next run instead of silently lost.
 *
 * `fetch` + the vault client are injectable so the mapping and the ingest loop
 * are unit-tested without the live API (see test/clickup.test.ts).
 */
import type { Note } from "../parachute";

const BASE = "https://api.clickup.com/api/v2";
type FetchLike = typeof fetch;

/** Credential shape stored in tenant_secrets (kind "clickup"). */
export interface ClickUpCredential {
  apiKey: string;
  /** Restrict to one workspace (team) id; blank/absent = all workspaces. */
  teamId?: string;
  /** Comma-separated ClickUp space ids to restrict to. */
  spaceIds?: string;
  /** Only tasks assigned to the token's user. Default TRUE. */
  assignedOnly?: boolean;
}

export interface ClickUpUser {
  id: number;
  username: string;
}
export interface ClickUpTeam {
  id: string;
  name: string;
}
export interface ClickUpTask {
  id: string;
  name?: string;
  markdown_description?: string | null;
  text_content?: string | null;
  status?: { status?: string; type?: string } | null;
  priority?: { priority?: string } | null;
  /** epoch-ms strings (ClickUp serializes timestamps as 13-digit strings) */
  due_date?: string | null;
  date_created?: string;
  date_updated?: string;
  assignees?: Array<{ id?: number; username?: string; email?: string }>;
  tags?: Array<{ name?: string }>;
  parent?: string | null;
  url?: string;
  list?: { id?: string; name?: string };
  folder?: { id?: string; name?: string; hidden?: boolean };
  space?: { id?: string };
  archived?: boolean;
}
export interface ClickUpTasksPage {
  tasks: ClickUpTask[];
  last_page?: boolean;
}

export class ClickUpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClickUpError";
  }
}

/** Does this error look like a ClickUp rate-limit (100 req/min/token → 429)? */
export function isRateLimited(e: unknown): boolean {
  return e instanceof ClickUpError && e.status === 429;
}

/** Minimal ClickUp client — the read paths task ingest needs. */
export class ClickUpClient {
  constructor(
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(pathAndQuery: string): Promise<T> {
    // ClickUp wants the bare token in Authorization — no "Bearer" prefix.
    const r = await this.fetchImpl(`${BASE}${pathAndQuery}`, { headers: { Authorization: this.apiKey } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new ClickUpError(r.status, `clickup ${r.status}: ${body.slice(0, 200) || "request failed"}`);
    }
    return (await r.json()) as T;
  }

  /** The token's own user (deduces the assignee filter). */
  async getUser(): Promise<ClickUpUser> {
    return (await this.request<{ user: ClickUpUser }>("/user")).user;
  }

  /** Workspaces (ClickUp calls them teams) the token can see. */
  async getTeams(): Promise<ClickUpTeam[]> {
    return (await this.request<{ teams?: ClickUpTeam[] }>("/team")).teams ?? [];
  }

  /** One page (100 tasks) of a team's filtered task view. Array-valued params
   *  (assignees[], space_ids[]) are repeated per element. */
  async getTasksPage(teamId: string, params: Record<string, string | string[]>, page: number): Promise<ClickUpTasksPage> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const x of v) qs.append(k, x);
      else qs.append(k, v);
    }
    qs.set("page", String(page));
    return this.request<ClickUpTasksPage>(`/team/${teamId}/task?${qs}`);
  }
}

// ── pure mapping (unit-tested without the live API) ──────────────────────────

const sanitizePath = (s: string): string =>
  (s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";

/** ClickUp status → the vault task enum (todo|in-progress|blocked|done|cancelled).
 *  `status.type` is authoritative for done/closed; custom statuses fall back to
 *  keyword matching on the (arbitrary, user-named) status string. */
export function mapStatus(status: ClickUpTask["status"]): string {
  const type = status?.type ?? "";
  if (type === "done" || type === "closed") return "done";
  const s = (status?.status ?? "").toLowerCase();
  if (/progress|doing|review|active/.test(s)) return "in-progress";
  if (/block|wait|hold|stuck/.test(s)) return "blocked";
  if (/cancel|won'?t/.test(s)) return "cancelled";
  return "todo";
}

/** ClickUp priority → the vault enum (critical|high|medium|low). No ClickUp
 *  priority → "medium": the mapper must always write one explicitly, because
 *  Parachute fills omitted schema'd enum fields with the FIRST enum value on
 *  create — which for `priority` is "critical", the worst possible default on
 *  the vault's only indexed field. */
export function mapPriority(priority: ClickUpTask["priority"]): string {
  const map: Record<string, string> = { urgent: "critical", high: "high", normal: "medium", low: "low" };
  return (priority?.priority && map[priority.priority]) || "medium";
}

const msToIso = (x: string | null | undefined): string | undefined => {
  const n = Number(x);
  return x && Number.isFinite(n) ? new Date(n).toISOString() : undefined;
};

/** Team context the task object itself lacks (a task carries only space.id). */
export interface ClickUpTaskContext {
  teamId: string;
  teamName: string;
}

/** Build the vault note for one ClickUp task. */
export function clickupTaskNote(
  task: ClickUpTask,
  ctx: ClickUpTaskContext,
): { content: string; path: string; tags: string[]; metadata: Record<string, unknown> } {
  const name = task.name || "Untitled Task";
  const description = (task.markdown_description ?? "") || (task.text_content ?? "");
  const url = task.url ?? "";

  let content = `# ${name}\n\n`;
  if (description.trim()) content += `${description.trim()}\n\n`;
  content += `[Open in ClickUp](${url})`;

  // Breadcrumb for where the task lives; ClickUp's "hidden" folder is the
  // synthetic container for folderless lists, not a real location.
  const folderName = task.folder && !task.folder.hidden ? task.folder.name : undefined;
  const context = [ctx.teamName, folderName, task.list?.name].filter(Boolean).join(" / ");

  const due = msToIso(task.due_date);
  const priority = mapPriority(task.priority);
  const assigned = task.assignees?.[0]?.username;

  return {
    content,
    path: `vault/tasks/clickup/${sanitizePath(name)}`,
    tags: ["task", "clickup"],
    metadata: {
      type: "task",
      source: "clickup",
      source_id: task.id,
      synced_at: new Date().toISOString(),
      status: mapStatus(task.status),
      clickup_status: task.status?.status ?? "",
      clickup_date_updated: task.date_updated ?? "",
      ...(due ? { due } : {}),
      priority,
      ...(assigned ? { assigned } : {}),
      project: task.list?.name ?? "",
      context,
      clickup_url: url,
      clickup_team_id: ctx.teamId,
      ...(task.parent ? { clickup_parent: task.parent } : {}),
    },
  };
}

// ── ingest loop ──────────────────────────────────────────────────────────────

/** The minimal vault surface the ingester needs (so tests inject a fake). */
export interface ClickUpVault {
  listNotes(opts: { tags?: string[]; includeContent?: boolean }): Promise<Note[]>;
  createNote(p: { content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }): Promise<Note>;
  updateNote(id: string, p: { content?: string; metadata?: Record<string, unknown> }): Promise<Note>;
}

export type ClickUpEvent =
  | { kind: "created"; id: string; name: string }
  | { kind: "updated"; id: string; name: string }
  | { kind: "rate-limited" };

export interface ClickUpIngestOptions {
  credential: ClickUpCredential;
  /** null → first-run backfill (open tasks only, no date filter). */
  sinceMs: number | null;
  onEvent?: (e: ClickUpEvent) => void;
  /** Cap on created+updated this run; hitting it ends the run un-advanced. */
  maxPerRun?: number;
  /** ~1s between page requests keeps well under 100 req/min. */
  throttleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ClickUpIngestResult {
  created: number;
  updated: number;
  skipped: number;
  /** Vault writes that threw — distinct from benign skips so a failing write
   *  path never reads like an idle ingester. */
  errors: number;
  /** Max task `date_updated` seen, ms — the next cursor. 0 on an INCOMPLETE
   *  pass (rate-limited / capped), so the caller keeps the previous cursor.
   *  Clamped below the earliest failed vault write so it gets re-fetched. */
  maxDateUpdatedMs: number;
  rateLimited: boolean;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One ingest pass: resolve teams, page through each team's filtered tasks, and
 * upsert into the vault deduped by metadata.source_id. A known task is skipped
 * unless the source `date_updated` is newer than what the note recorded. A
 * rate-limit anywhere ends the run quietly (resume next slot); any other
 * per-task error counts as skipped and never aborts the run.
 */
export async function ingestClickUp(
  client: Pick<ClickUpClient, "getUser" | "getTeams" | "getTasksPage">,
  vault: ClickUpVault,
  opts: ClickUpIngestOptions,
): Promise<ClickUpIngestResult> {
  const { credential, sinceMs } = opts;
  const emit = opts.onEvent ?? (() => {});
  const throttleMs = opts.throttleMs ?? 1000;
  const sleep = opts.sleep ?? realSleep;
  const assignedOnly = credential.assignedOnly !== false;

  const out: ClickUpIngestResult = { created: 0, updated: 0, skipped: 0, errors: 0, maxDateUpdatedMs: 0, rateLimited: false };
  const endRateLimited = (): ClickUpIngestResult => {
    out.rateLimited = true;
    out.maxDateUpdatedMs = 0; // incomplete pass — cursor must not advance
    emit({ kind: "rate-limited" });
    return out;
  };

  // 1) Identity + team list. A rate-limit here just ends the run quietly.
  let userId: number | null = null;
  let teams: ClickUpTeam[];
  try {
    if (assignedOnly) userId = (await client.getUser()).id;
    teams = await client.getTeams();
    if (credential.teamId) teams = teams.filter((t) => t.id === credential.teamId);
  } catch (e) {
    if (isRateLimited(e)) return endRateLimited();
    throw e;
  }

  // 2) Known tasks, by source_id (dedup + freshness comparison).
  const existing = await vault.listNotes({ tags: ["task"], includeContent: false });
  const bySourceId = new Map<string, Note>();
  for (const n of existing) {
    const md = n.metadata ?? {};
    if (md.source !== "clickup") continue;
    if (typeof md.source_id === "string") bySourceId.set(md.source_id, n);
  }

  const params: Record<string, string | string[]> = {
    subtasks: "true",
    include_markdown_description: "true",
    order_by: "updated",
  };
  if (assignedOnly && userId !== null) params["assignees[]"] = [String(userId)];
  const spaceIds = (credential.spaceIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (spaceIds.length) params["space_ids[]"] = spaceIds;
  if (sinceMs !== null) {
    // Incremental: everything (incl. closed) updated since the cursor. The
    // backfill omits both, which is what limits it to open tasks.
    params.date_updated_gt = String(sinceMs);
    params.include_closed = "true";
  }

  // 3) Page through each team; upsert per task.
  let maxSeen = 0;
  // Earliest date_updated among tasks whose vault write failed — the cursor
  // must not advance past it, or the change is lost until the next ClickUp edit.
  let minFailedMs = Infinity;
  let pagesFetched = 0;
  for (const team of teams) {
    for (let page = 0; ; page++) {
      if (pagesFetched > 0) await sleep(throttleMs);
      let res: ClickUpTasksPage;
      try {
        res = await client.getTasksPage(team.id, params, page);
      } catch (e) {
        if (isRateLimited(e)) return endRateLimited();
        throw e;
      }
      pagesFetched++;

      for (const task of res.tasks) {
        const updatedMs = Number(task.date_updated) || 0;
        if (updatedMs > maxSeen) maxSeen = updatedMs;
        if (task.archived) {
          out.skipped++;
          continue;
        }
        const known = bySourceId.get(task.id);
        if (known && updatedMs <= Number(known.metadata?.clickup_date_updated ?? 0)) {
          out.skipped++;
          continue;
        }
        if (opts.maxPerRun && out.created + out.updated >= opts.maxPerRun) {
          return out; // capped: incomplete pass — maxDateUpdatedMs stays 0, cursor stays put
        }
        const note = clickupTaskNote(task, { teamId: team.id, teamName: team.name });
        try {
          if (known) {
            await vault.updateNote(known.id, { content: note.content, metadata: note.metadata });
            out.updated++;
            emit({ kind: "updated", id: task.id, name: task.name ?? "" });
          } else {
            // Two tasks can slug to the same path; retry once with an id suffix.
            let created: Note;
            try {
              created = await vault.createNote(note);
            } catch (e) {
              if (!/path_conflict|409/.test(String((e as Error).message))) throw e;
              created = await vault.createNote({ ...note, path: `${note.path}-${task.id.slice(-6).toLowerCase()}` });
            }
            bySourceId.set(task.id, created);
            out.created++;
            emit({ kind: "created", id: task.id, name: task.name ?? "" });
          }
        } catch {
          out.errors++; // one bad task never aborts the run
          if (updatedMs < minFailedMs) minFailedMs = updatedMs;
        }
      }

      // last_page is confirmed present on this endpoint; the length check is
      // belt-and-braces against it ever going missing.
      if (res.last_page || res.tasks.length < 100) break;
    }
  }

  // Complete pass — safe to advance, but never past a task whose vault write
  // failed: clamp just below the earliest failure so the next incremental
  // window (date_updated_gt) re-fetches it. A failure with no usable
  // date_updated clamps to 0, holding the cursor entirely.
  out.maxDateUpdatedMs = minFailedMs === Infinity ? maxSeen : Math.max(0, Math.min(maxSeen, minFailedMs - 1));
  return out;
}
