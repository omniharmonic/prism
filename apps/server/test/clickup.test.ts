/**
 * ClickUp task ingester — status/priority mapping, note shape, backfill vs
 * incremental query params, pagination termination, dedup/upsert, path-conflict
 * retry, rate-limit behavior, and cursor semantics — all with a fake fetch +
 * fake vault (no live API). The live path is exercised by the on-demand
 * /api/integrations/clickup/sync route.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClickUpClient,
  ClickUpError,
  isRateLimited,
  mapStatus,
  mapPriority,
  clickupTaskNote,
  ingestClickUp,
  type ClickUpTask,
  type ClickUpTasksPage,
  type ClickUpVault,
  type ClickUpCredential,
} from "../src/worker/clickup";
import type { Note } from "../src/parachute";

const BASE = "https://api.clickup.com/api/v2";
const USER = { user: { id: 43171299, username: "ben" } };
const TEAMS = { teams: [{ id: "team1", name: "INU" }] };
const CTX = { teamId: "team1", teamName: "INU" };
const noSleep = async () => {};

/** Fake fetch: records every URL, answers via `handler`. */
function makeFetch(handler: (url: string) => { status?: number; body: unknown }) {
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const { status = 200, body } = handler(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/** Standard handler: /user + /team answered, task pages supplied per page number. */
function taskPagesHandler(pages: ClickUpTasksPage[], overrides?: (url: string) => { status?: number; body: unknown } | null) {
  return (url: string): { status?: number; body: unknown } => {
    const custom = overrides?.(url);
    if (custom) return custom;
    if (url === `${BASE}/user`) return { body: USER };
    if (url === `${BASE}/team`) return { body: TEAMS };
    if (url.includes("/task?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return { body: pages[page] ?? { tasks: [], last_page: true } };
    }
    throw new Error(`unexpected url ${url}`);
  };
}

function task(over: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id: "abc123",
    name: "Ship the sync",
    status: { status: "to do", type: "open" },
    date_updated: "1755500000000",
    url: "https://app.clickup.com/t/abc123",
    list: { id: "l1", name: "Sprint 12" },
    space: { id: "s1" },
    ...over,
  };
}

/** A vault note as the ingester writes it (the dedup key fields). */
function existingNote(sourceId: string, dateUpdated: string, over: Partial<Note> = {}): Note {
  return {
    id: `note-${sourceId}`,
    content: "",
    path: null,
    metadata: { source: "clickup", source_id: sourceId, clickup_date_updated: dateUpdated },
    tags: ["task", "clickup"],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function makeVault(existing: Note[] = []) {
  const created: Array<{ content: string; path?: string; metadata?: Record<string, unknown>; tags?: string[] }> = [];
  const updated: Array<{ id: string; patch: { content?: string; metadata?: Record<string, unknown> } }> = [];
  const conflictPaths = new Set<string>();
  let seq = 0;
  const vault: ClickUpVault = {
    async listNotes() {
      return existing;
    },
    async createNote(p) {
      if (conflictPaths.has(p.path ?? "")) {
        conflictPaths.delete(p.path ?? "");
        throw new Error("path_conflict: a note already exists at this path");
      }
      created.push(p);
      return { id: `created-${++seq}`, content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "", updatedAt: "" };
    },
    async updateNote(id, patch) {
      updated.push({ id, patch });
      return { id, content: patch.content ?? "", path: null, metadata: patch.metadata ?? null, tags: null, createdAt: "", updatedAt: "" };
    },
  };
  return { vault, created, updated, conflictPaths };
}

const cred = (over: Partial<ClickUpCredential> = {}): ClickUpCredential => ({ apiKey: "pk_test_x", ...over });

// ── mapStatus / mapPriority ──

test("mapStatus: status.type done/closed wins regardless of the string", () => {
  assert.equal(mapStatus({ status: "complete", type: "done" }), "done");
  assert.equal(mapStatus({ status: "Closed", type: "closed" }), "done");
  assert.equal(mapStatus({ status: "in progress", type: "done" }), "done");
});

test("mapStatus: custom/open statuses match by keyword", () => {
  assert.equal(mapStatus({ status: "to do", type: "open" }), "todo");
  assert.equal(mapStatus({ status: "in progress", type: "custom" }), "in-progress");
  assert.equal(mapStatus({ status: "Doing", type: "custom" }), "in-progress");
  assert.equal(mapStatus({ status: "In Review", type: "custom" }), "in-progress");
  assert.equal(mapStatus({ status: "active", type: "custom" }), "in-progress");
  assert.equal(mapStatus({ status: "Blocked", type: "custom" }), "blocked");
  assert.equal(mapStatus({ status: "waiting on client", type: "custom" }), "blocked");
  assert.equal(mapStatus({ status: "on hold", type: "custom" }), "blocked");
  assert.equal(mapStatus({ status: "stuck", type: "custom" }), "blocked");
  assert.equal(mapStatus({ status: "cancelled", type: "custom" }), "cancelled");
  assert.equal(mapStatus({ status: "won't do", type: "custom" }), "cancelled");
  assert.equal(mapStatus({ status: "wont do", type: "custom" }), "cancelled");
  assert.equal(mapStatus({ status: "backlog", type: "custom" }), "todo");
  assert.equal(mapStatus(null), "todo");
  assert.equal(mapStatus(undefined), "todo");
});

test("mapPriority: urgent→critical, high/low pass through, normal→medium, null→medium (never omitted — the vault would default an omitted schema'd field to 'critical')", () => {
  assert.equal(mapPriority({ priority: "urgent" }), "critical");
  assert.equal(mapPriority({ priority: "high" }), "high");
  assert.equal(mapPriority({ priority: "normal" }), "medium");
  assert.equal(mapPriority({ priority: "low" }), "low");
  assert.equal(mapPriority(null), "medium");
  assert.equal(mapPriority(undefined), "medium");
  assert.equal(mapPriority({ priority: "bogus" }), "medium");
});

// ── clickupTaskNote ──

test("clickupTaskNote maps the full note shape", () => {
  const t = task({
    id: "86cxyz",
    name: "Ship the ClickUp Sync!",
    markdown_description: "Do **this** first.",
    text_content: "plain fallback",
    status: { status: "in progress", type: "custom" },
    priority: { priority: "urgent" },
    due_date: "1755600000000",
    date_updated: "1755512345678",
    assignees: [{ id: 1, username: "ben", email: "b@x" }, { id: 2, username: "ana" }],
    parent: "parent1",
    folder: { id: "f1", name: "Q3", hidden: false },
  });
  const n = clickupTaskNote(t, CTX);
  assert.deepEqual(n.tags, ["task", "clickup"]);
  assert.equal(n.path, "vault/tasks/clickup/ship-the-clickup-sync");
  assert.equal(n.content, "# Ship the ClickUp Sync!\n\nDo **this** first.\n\n[Open in ClickUp](https://app.clickup.com/t/abc123)");
  const md = n.metadata;
  assert.equal(md.type, "task");
  assert.equal(md.source, "clickup");
  assert.equal(md.source_id, "86cxyz");
  assert.equal(md.status, "in-progress");
  assert.equal(md.clickup_status, "in progress");
  assert.equal(md.clickup_date_updated, "1755512345678");
  assert.equal(md.due, new Date(1755600000000).toISOString());
  assert.equal(md.priority, "critical");
  assert.equal(md.assigned, "ben");
  assert.equal(md.project, "Sprint 12");
  assert.equal(md.context, "INU / Q3 / Sprint 12");
  assert.equal(md.clickup_url, "https://app.clickup.com/t/abc123");
  assert.equal(md.clickup_team_id, "team1");
  assert.equal(md.clickup_parent, "parent1");
  assert.ok(!Number.isNaN(Date.parse(md.synced_at as string)));
});

test("clickupTaskNote omits null fields and skips the hidden folder in the breadcrumb", () => {
  const t = task({ priority: null, due_date: null, assignees: [], parent: null, folder: { id: "f0", name: "hidden", hidden: true } });
  const n = clickupTaskNote(t, CTX);
  assert.ok(!("due" in n.metadata));
  assert.equal(n.metadata.priority, "medium"); // always explicit — see mapPriority
  assert.ok(!("assigned" in n.metadata));
  assert.ok(!("clickup_parent" in n.metadata));
  assert.equal(n.metadata.context, "INU / Sprint 12");
});

test("clickupTaskNote falls back to text_content when markdown_description is absent", () => {
  const n = clickupTaskNote(task({ markdown_description: null, text_content: "plain text" }), CTX);
  assert.ok(n.content.includes("plain text"));
  const bare = clickupTaskNote(task({ markdown_description: null, text_content: null }), CTX);
  assert.equal(bare.content, "# Ship the sync\n\n[Open in ClickUp](https://app.clickup.com/t/abc123)");
});

// ── client / query params ──

test("client sends the bare token (no Bearer) and throws typed errors", async () => {
  const { fetchImpl } = makeFetch(() => ({ status: 401, body: { err: "no" } }));
  let header = "";
  const spying = (async (input: unknown, init?: RequestInit) => {
    header = (init?.headers as Record<string, string>).Authorization ?? "";
    return fetchImpl(input as string);
  }) as typeof fetch;
  const client = new ClickUpClient("pk_test_x", spying);
  await assert.rejects(client.getUser(), (e: unknown) => e instanceof ClickUpError && e.status === 401);
  assert.equal(header, "pk_test_x");
});

test("isRateLimited matches only ClickUp 429s", () => {
  assert.equal(isRateLimited(new ClickUpError(429, "clickup 429")), true);
  assert.equal(isRateLimited(new ClickUpError(500, "clickup 500")), false);
  assert.equal(isRateLimited(new Error("boom")), false);
});

test("backfill (no cursor): open-only, no date filter, assignees[] from getUser", async () => {
  const { fetchImpl, urls } = makeFetch(taskPagesHandler([{ tasks: [task()], last_page: true }]));
  const { vault, created } = makeVault();
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), vault, { credential: cred(), sinceMs: null, sleep: noSleep });
  assert.equal(res.created, 1);
  const taskUrl = urls.find((u) => u.includes("/task?"))!;
  const qs = new URL(taskUrl).searchParams;
  assert.equal(qs.get("subtasks"), "true");
  assert.equal(qs.get("include_markdown_description"), "true");
  assert.equal(qs.get("order_by"), "updated");
  assert.deepEqual(qs.getAll("assignees[]"), ["43171299"]);
  assert.equal(qs.get("date_updated_gt"), null);
  assert.equal(qs.get("include_closed"), null);
  assert.equal(created[0]!.metadata!.clickup_team_id, "team1");
});

test("incremental (cursor): date_updated_gt + include_closed=true", async () => {
  const { fetchImpl, urls } = makeFetch(taskPagesHandler([{ tasks: [], last_page: true }]));
  await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault().vault, { credential: cred(), sinceMs: 1755000000000, sleep: noSleep });
  const qs = new URL(urls.find((u) => u.includes("/task?"))!).searchParams;
  assert.equal(qs.get("date_updated_gt"), "1755000000000");
  assert.equal(qs.get("include_closed"), "true");
});

test("assignedOnly=false: no getUser call, no assignees[] param", async () => {
  const { fetchImpl, urls } = makeFetch(taskPagesHandler([{ tasks: [], last_page: true }]));
  await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault().vault, {
    credential: cred({ assignedOnly: false }),
    sinceMs: null,
    sleep: noSleep,
  });
  assert.ok(!urls.some((u) => u === `${BASE}/user`));
  assert.deepEqual(new URL(urls.find((u) => u.includes("/task?"))!).searchParams.getAll("assignees[]"), []);
});

test("spaceIds narrows via repeated space_ids[]; teamId filters the team list", async () => {
  const handler = (url: string): { status?: number; body: unknown } => {
    if (url === `${BASE}/user`) return { body: USER };
    if (url === `${BASE}/team`) return { body: { teams: [{ id: "team1", name: "INU" }, { id: "team2", name: "Gitcoin" }] } };
    if (url.includes("/task?")) return { body: { tasks: [], last_page: true } };
    throw new Error(`unexpected ${url}`);
  };
  const { fetchImpl, urls } = makeFetch(handler);
  await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault().vault, {
    credential: cred({ teamId: "team2", spaceIds: "s1, s2" }),
    sinceMs: null,
    sleep: noSleep,
  });
  const taskUrls = urls.filter((u) => u.includes("/task?"));
  assert.equal(taskUrls.length, 1);
  assert.ok(taskUrls[0]!.includes("/team/team2/task?"));
  assert.deepEqual(new URL(taskUrls[0]!).searchParams.getAll("space_ids[]"), ["s1", "s2"]);
});

// ── pagination ──

test("pagination: continues past a full page, stops on last_page", async () => {
  const page0 = { tasks: Array.from({ length: 100 }, (_, i) => task({ id: `t${i}`, name: `Task ${i}` })), last_page: false };
  const page1 = { tasks: [task({ id: "t100", name: "Task 100" })], last_page: true };
  const { fetchImpl, urls } = makeFetch(taskPagesHandler([page0, page1]));
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault().vault, { credential: cred(), sinceMs: null, sleep: noSleep });
  assert.equal(urls.filter((u) => u.includes("/task?")).length, 2);
  assert.equal(res.created, 101);
});

test("pagination: a short page ends the loop even without last_page (belt+braces)", async () => {
  const { fetchImpl, urls } = makeFetch(taskPagesHandler([{ tasks: [task()] }]));
  await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault().vault, { credential: cred(), sinceMs: null, sleep: noSleep });
  assert.equal(urls.filter((u) => u.includes("/task?")).length, 1);
});

// ── dedup / upsert ──

test("dedup: same-or-older date_updated skips; newer updates with full mapped metadata", async () => {
  const existing = [
    existingNote("same", "2000"),
    existingNote("newer", "1000"),
  ];
  const pages = [{ tasks: [task({ id: "same", date_updated: "2000" }), task({ id: "newer", name: "Now newer", date_updated: "3000" }), task({ id: "brand-new", name: "Brand new", date_updated: "500" })], last_page: true }];
  const { fetchImpl } = makeFetch(taskPagesHandler(pages));
  const { vault, created, updated } = makeVault(existing);
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), vault, { credential: cred(), sinceMs: 1, sleep: noSleep });
  assert.equal(res.skipped, 1);
  assert.equal(res.updated, 1);
  assert.equal(res.created, 1);
  assert.equal(updated[0]!.id, "note-newer");
  assert.equal(updated[0]!.patch.metadata!.clickup_date_updated, "3000");
  assert.ok(updated[0]!.patch.content!.startsWith("# Now newer"));
  assert.equal(created[0]!.metadata!.source_id, "brand-new");
});

test("archived tasks are skipped", async () => {
  const { fetchImpl } = makeFetch(taskPagesHandler([{ tasks: [task({ archived: true })], last_page: true }]));
  const { vault, created } = makeVault();
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), vault, { credential: cred(), sinceMs: null, sleep: noSleep });
  assert.equal(res.created, 0);
  assert.equal(res.skipped, 1);
  assert.equal(created.length, 0);
});

test("path conflict retries once with an id suffix", async () => {
  const { fetchImpl } = makeFetch(taskPagesHandler([{ tasks: [task({ id: "86czqjabcdef" })], last_page: true }]));
  const { vault, created, conflictPaths } = makeVault();
  conflictPaths.add("vault/tasks/clickup/ship-the-sync");
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), vault, { credential: cred(), sinceMs: null, sleep: noSleep });
  assert.equal(res.created, 1);
  assert.equal(created[0]!.path, "vault/tasks/clickup/ship-the-sync-abcdef");
});

test("a non-conflict create error counts as an error and never aborts the run", async () => {
  const pages = [{ tasks: [task({ id: "bad" }), task({ id: "good", name: "Good one" })], last_page: true }];
  const { fetchImpl } = makeFetch(taskPagesHandler(pages));
  const { vault, created } = makeVault();
  const origCreate = vault.createNote.bind(vault);
  vault.createNote = async (p) => {
    if ((p.metadata as Record<string, unknown>).source_id === "bad") throw new Error("vault 500");
    return origCreate(p);
  };
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), vault, { credential: cred(), sinceMs: null, sleep: noSleep });
  assert.equal(res.errors, 1);
  assert.equal(res.skipped, 0);
  assert.equal(res.created, 1);
  assert.equal(created[0]!.metadata!.source_id, "good");
});

// ── rate limit + cursor semantics ──

test("rate-limit mid-run: ends quietly with the cursor held (maxDateUpdatedMs=0), keeps counts", async () => {
  const page0 = { tasks: Array.from({ length: 100 }, (_, i) => task({ id: `t${i}`, name: `Task ${i}`, date_updated: "9000" })), last_page: false };
  const handler = taskPagesHandler([page0], (url) => {
    if (url.includes("/task?") && new URL(url).searchParams.get("page") === "1") return { status: 429, body: { err: "slow down" } };
    return null;
  });
  const { fetchImpl } = makeFetch(handler);
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault().vault, { credential: cred(), sinceMs: 1, sleep: noSleep });
  assert.equal(res.rateLimited, true);
  assert.equal(res.maxDateUpdatedMs, 0);
  assert.equal(res.created, 100);
});

test("rate-limit on getUser ends the run quietly; other errors propagate", async () => {
  const { fetchImpl } = makeFetch(() => ({ status: 429, body: {} }));
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault().vault, { credential: cred(), sinceMs: null, sleep: noSleep });
  assert.equal(res.rateLimited, true);
  assert.equal(res.created + res.updated, 0);

  const { fetchImpl: f500 } = makeFetch(() => ({ status: 500, body: {} }));
  await assert.rejects(
    ingestClickUp(new ClickUpClient("pk_test_x", f500), makeVault().vault, { credential: cred(), sinceMs: null, sleep: noSleep }),
    (e: unknown) => e instanceof ClickUpError && e.status === 500,
  );
});

test("cursor value is the max date_updated seen (incl. skipped tasks), never Date.now()", async () => {
  const existing = [existingNote("t2", "7777")];
  const pages = [{ tasks: [task({ id: "t1", date_updated: "5000" }), task({ id: "t2", date_updated: "7777" }), task({ id: "t3", name: "Third", date_updated: "6000" })], last_page: true }];
  const { fetchImpl } = makeFetch(taskPagesHandler(pages));
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault(existing).vault, { credential: cred(), sinceMs: 1, sleep: noSleep });
  assert.equal(res.maxDateUpdatedMs, 7777);
});

test("throttle: sleeps between page requests, not before the first", async () => {
  const sleeps: number[] = [];
  const page0 = { tasks: Array.from({ length: 100 }, (_, i) => task({ id: `t${i}`, name: `Task ${i}` })), last_page: false };
  const { fetchImpl } = makeFetch(taskPagesHandler([page0, { tasks: [], last_page: true }]));
  await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault().vault, {
    credential: cred(),
    sinceMs: null,
    sleep: async (ms) => void sleeps.push(ms),
  });
  assert.deepEqual(sleeps, [1000]);
});

test("a failed vault write clamps the cursor below that task, so it is re-fetched", async () => {
  const pages = [{ tasks: [task({ id: "ok1", name: "OK 1", date_updated: "5000" }), task({ id: "bad", name: "Bad", date_updated: "6000" }), task({ id: "ok2", name: "OK 2", date_updated: "9000" })], last_page: true }];
  const { fetchImpl } = makeFetch(taskPagesHandler(pages));
  const { vault } = makeVault();
  const origCreate = vault.createNote.bind(vault);
  vault.createNote = async (p) => {
    if ((p.metadata as Record<string, unknown>).source_id === "bad") throw new Error("vault 500");
    return origCreate(p);
  };
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), vault, { credential: cred(), sinceMs: 1, sleep: noSleep });
  assert.equal(res.created, 2);
  assert.equal(res.errors, 1);
  assert.equal(res.maxDateUpdatedMs, 5999); // not 9000 — "bad" must fall inside the next date_updated_gt window
});

test("a failed vault write with no date_updated holds the cursor entirely", async () => {
  const pages = [{ tasks: [task({ id: "bad", name: "Bad", date_updated: undefined }), task({ id: "ok", name: "OK", date_updated: "9000" })], last_page: true }];
  const { fetchImpl } = makeFetch(taskPagesHandler(pages));
  const { vault } = makeVault();
  vault.createNote = async (p) => {
    if ((p.metadata as Record<string, unknown>).source_id === "bad") throw new Error("vault 500");
    return { id: "created-ok", content: p.content, path: p.path ?? null, metadata: p.metadata ?? null, tags: p.tags ?? null, createdAt: "", updatedAt: "" };
  };
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), vault, { credential: cred(), sinceMs: 1, sleep: noSleep });
  assert.equal(res.maxDateUpdatedMs, 0);
});

test("maxPerRun caps the run and holds the cursor", async () => {
  const pages = [{ tasks: [task({ id: "a", name: "A", date_updated: "100" }), task({ id: "b", name: "B", date_updated: "200" }), task({ id: "c", name: "C", date_updated: "300" })], last_page: true }];
  const { fetchImpl } = makeFetch(taskPagesHandler(pages));
  const res = await ingestClickUp(new ClickUpClient("pk_test_x", fetchImpl), makeVault().vault, { credential: cred(), sinceMs: 1, maxPerRun: 2, sleep: noSleep });
  assert.equal(res.created, 2);
  assert.equal(res.maxDateUpdatedMs, 0);
});
