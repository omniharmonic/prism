/**
 * Graph-maintenance tools for the OWNER's agents: work the identity review
 * queue, look at detected duplicates, RECOMMEND merges, file gaps, and read the
 * measured state of the linking layer.
 *
 *   prism_people_review_queue      read   open rows, paged, with candidate summaries
 *   prism_people_review_context    read   one row: source excerpt + per-candidate signals
 *   prism_people_review_decide     write  resolve ONE row to ONE of its candidates, or dismiss it
 *   prism_people_duplicates        read   detected duplicate pairs (+ any open recommendation)
 *   prism_people_recommend_merge   write  a recommendation for the owner — never a merge
 *   prism_people_file_review       write  put a gap the agent noticed INTO the queue (owner decides)
 *   prism_people_link_status       read   queue depth/age, last job, caps — the numbers a report quotes
 *
 * WHO: the SERVER OWNER (by email), exactly like `/api/admin/people/*`. For
 * everyone else `access` is false, so the tools are absent from tools/list and
 * a call answers like a tool that does not exist.
 *
 * HOW THEY REACH THE LOGIC: they call the shared service functions
 * (`people-review-service.ts` → `identity-review.ts`) directly — the same
 * functions the owner routes call — instead of dispatching to
 * `/api/admin/people/*`. Reasons: (1) the admin router's guard is a browser
 * CSRF/origin guard; teaching it to wave MCP through would weaken it for every
 * admin route; (2) with no dispatch into the admin router there is, by
 * construction, no path from an MCP credential to `/merge`, `/link` or `/owner`
 * — an agent cannot merge, start the backfill job or change who "me" is;
 * (3) enforcement is not duplicated: lock, CAS, directed-edge check and the
 * audit row live in the shared functions.
 *
 * WHAT AN AGENT MAY NOT DO HERE (each enforced below, each tested):
 *  - decide more than ONE row per call (no `applyToKey`);
 *  - pick a person who is not one of the row's candidates;
 *  - teach a person a key (`add_identity`) on name-only evidence;
 *  - decide a row another agent FILED (origin `agent:*`) or a
 *    `tombstone-unresolved` row (that writes a merge pointer) — owner only;
 *  - exceed the per-credential daily caps;
 *  - merge. A recommendation is a row in SQLite the owner reads.
 */
import * as z from "zod/v4";
import { config } from "../config";
import type { Note } from "../parachute";
import { recordAction, shortHash } from "../actions/store";
import { IdentityIndex, isNonHumanPerson, isTombstone, ownerProfile, personKeys } from "../identity";
import { enqueueCandidate, getCandidate, listCandidates, openCandidateCounts, queueStats, resolvedCountsForKey, type IdentityCandidate } from "../identity-store";
import { MERGED_INTO, ReviewError } from "../identity-review";
import { CANONICAL, noteKinds, type CanonicalRelationship } from "../relationships";
import { lastLinkJobOutcome, linkJobStatus } from "../people-link-job";
import { peopleLockHolder } from "../people-lock";
import { ownerConfigFor } from "../people-owner";
import { dismissReview, duplicatePairs, peopleListing, peopleVault, resolveReview } from "../people-review-service";
import { agentActionCounts, agentActionsLastDay, beginAgentAction, listRecommendations, openRecommendationCount, pairKey, RATIONALE_MAX, recommendMerge } from "../people-agent-store";
import type { McpPrincipal } from "./auth";
import { ToolError } from "./errors";
import { defineTool, type PrismTool } from "./tools";

/** The server owner, by email — the same rule as the admin router (never a vault-role owner or admin). */
const isServerOwner = (p: McpPrincipal): boolean => p.actor.kind === "user" && p.actor.email === config.ownerEmail;

/**
 * What a daily cap counts against. A user-made PAT / device counts on its own;
 * every hosted agent turn mints a NEW per-turn PAT, so those share one bucket
 * per account (otherwise each turn would start with a fresh allowance).
 */
const capKeyOf = (p: McpPrincipal): string => (p.agentTurnId ? `agent-turns:${p.actor.email}` : `${p.via}:${p.credentialId}`);
const auditVia = (p: McpPrincipal): string => `mcp:${p.via}`;

const SOURCE_KINDS = {
  email: ["email-from", "email-to"],
  thread: ["messages-with"],
  meeting: ["attended-by"],
  task: ["assigned-to", "belongs-to"],
  person: [MERGED_INTO],
} as const;
type SourceKind = keyof typeof SOURCE_KINDS;
const sourceKindOf = (relationship: string): SourceKind | "other" =>
  (Object.keys(SOURCE_KINDS) as SourceKind[]).find((k) => (SOURCE_KINDS[k] as readonly string[]).includes(relationship)) ?? "other";

const NAME_ONLY_REASONS = new Set(["name-only", "single-token-name", "ambiguous-name"]);
/** Evidence that is only a name: `add_identity` is refused (a name is never a key). */
const isNameOnly = (c: IdentityCandidate): boolean => c.key.kind === "name" || NAME_ONLY_REASONS.has(c.reason);
/** Rows only the owner may decide: a merge pointer, or a row an agent filed itself. */
const ownerOnlyReason = (c: IdentityCandidate): string | null =>
  c.relationship === MERGED_INTO ? "tombstone-unresolved rows write a merge pointer — the owner decides them" : c.origin.startsWith("agent:") ? "rows filed by an agent are decided by the owner" : null;

const cut = (s: unknown, n: number): string => {
  const t = typeof s === "string" ? s : s == null ? "" : String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const strs = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const titleOf = (n: Note): string => {
  const md = n.metadata ?? {};
  const t = [md.subject, md.title, md.name, n.displayTitle].find((x) => typeof x === "string" && x.trim());
  return cut((t as string | undefined) ?? n.path?.split("/").pop() ?? n.id, 160);
};

interface PersonSummary {
  id: string;
  name: string;
  path: string | null;
  organizations: string[];
  emailCount: number;
  keyKinds: string[];
  aliases: string[];
  linkCount: number;
  /** Set when the candidate has since been merged away / is not a live human. */
  live: boolean;
  mergedInto?: string | null;
}

function summarize(idx: IdentityIndex, id: string): PersonSummary | { id: string; missing: true } {
  const n = idx.get(id);
  if (!n) return { id, missing: true };
  const md = n.metadata ?? {};
  const keys = personKeys(n);
  const live = !isTombstone(n) && !isNonHumanPerson(n);
  return {
    id: n.id,
    name: cut(typeof md.name === "string" && md.name.trim() ? md.name : (n.path?.split("/").pop() ?? n.id), 120),
    path: n.path,
    organizations: [...strs(md.organization), ...strs(md.organizations)].slice(0, 3).map((o) => cut(o, 80)),
    emailCount: keys.strong.filter((k) => k.kind === "email").length,
    keyKinds: [...new Set(keys.strong.map((k) => k.kind))].sort(),
    aliases: strs(md.aliases).concat(strs(md.alias)).slice(0, 5).map((a) => cut(a, 80)),
    linkCount: Array.isArray(n.links) ? n.links.length : 0,
    live,
    ...(live ? {} : { mergedInto: idx.canonicalOf(n)?.id ?? null }),
  };
}

async function loadIndex(vaultId: string, fresh = false): Promise<IdentityIndex> {
  try {
    return new IdentityIndex(await peopleListing(vaultId, fresh));
  } catch {
    throw new ToolError("upstream_error", "the people listing is unavailable — try again later");
  }
}

const busyError = (): ToolError =>
  new ToolError("conflict", "another people operation (the link job, a merge or another decision) is running — retry in a minute", { reason: "busy", retry: true, holder: peopleLockHolder() });

function capOrThrow(p: McpPrincipal, budget: "decide" | "file" | "recommend", limit: number): number {
  const used = agentActionsLastDay(capKeyOf(p), budget);
  if (!(limit > 0) || used >= limit)
    throw new ToolError("rate_limited", `the daily limit for this credential is reached (${used} of ${Math.max(0, limit)} in the last 24 h) — stop and report`, { reason: "daily_cap", budget, limit: Math.max(0, limit), used });
  return limit - used - 1;
}

/** Bounded concurrency map (source-note lookups for one page). */
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

const rowView = (c: IdentityCandidate, idx: IdentityIndex) => ({
  id: c.id,
  reason: c.reason,
  relationship: c.relationship,
  sourceKind: sourceKindOf(c.relationship),
  sourceNoteId: c.sourceNoteId,
  key: { kind: c.key.kind, value: cut(c.key.value, 320) },
  display: c.display ? cut(c.display, 160) : null,
  nameOnly: isNameOnly(c),
  origin: c.origin,
  agentDecidable: ownerOnlyReason(c) === null,
  candidates: c.candidateIds.slice(0, 10).map((id) => summarize(idx, id)),
  createdAt: c.createdAt,
});

// ── read: the queue ──────────────────────────────────────────────────────────

export const reviewQueueTool = defineTool({
  name: "prism_people_review_queue",
  scope: "read",
  title: "Identity review queue",
  description:
    "List OPEN identity review rows, oldest first: identities the server would not link on its own (ambiguous key, name-only, …) with the " +
    "people each might be. Filter by `reason`, `relationship` or `source_kind`. Paged: pass the returned `next` as `after`. At most 25 rows " +
    "per call. Use prism_people_review_context on one row before deciding it.",
  inputSchema: z.object({
    reason: z.string().min(1).max(64).optional().describe("e.g. ambiguous-key, name-only, single-token-name, name-key-mismatch, ambiguous-name"),
    relationship: z.string().min(1).max(64).optional().describe("e.g. email-from, attended-by, messages-with, assigned-to"),
    source_kind: z.enum(["email", "thread", "meeting", "task", "person"]).optional(),
    limit: z.number().int().min(1).max(25).default(10),
    after: z.string().max(96).optional().describe("Cursor from a previous call's `next`"),
    include_titles: z.boolean().default(true).describe("Look up each source note's title (one vault read per row)"),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: isServerOwner,
  async handler(a, ctx) {
    const vaultId = ctx.principal.actor.vaultId;
    const page = listCandidates(vaultId, {
      status: "open",
      reason: a.reason,
      relationship: a.relationship,
      relationships: a.source_kind ? [...SOURCE_KINDS[a.source_kind]] : undefined,
      limit: a.limit,
      after: a.after ?? null,
    });
    const idx = page.candidates.length ? await loadIndex(vaultId) : new IdentityIndex([]);
    const vault = peopleVault(vaultId);
    const sources = a.include_titles
      ? await mapLimit([...new Set(page.candidates.map((c) => c.sourceNoteId))], 3, async (id) => {
          try {
            const n = await vault.getNote(id);
            return [id, { title: titleOf(n), path: n.path }] as const;
          } catch {
            return [id, null] as const;
          }
        })
      : [];
    const byId = new Map(sources);
    return {
      rows: page.candidates.map((c) => ({ ...rowView(c, idx), source: { id: c.sourceNoteId, ...(byId.get(c.sourceNoteId) ?? { title: null, path: null }) } })),
      next: page.next,
      open: openCandidateCounts(vaultId),
    };
  },
});

// ── read: one row's context ──────────────────────────────────────────────────

const EXCERPT_MAX = 1500;
const SOURCE_META_KEYS = ["subject", "title", "from", "to", "date", "start", "participants", "attendees", "attendeeEmails", "assigned", "assignee", "project", "threadId", "labels", "platform"];

/** Tags out, entities left alone, whitespace collapsed — linear, no backtracking. */
function plainText(s: string): string {
  let out = "";
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "<") {
      inTag = true;
      out += " ";
    } else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** ≤ EXCERPT_MAX chars of the source, centred on the first mention of the identity when there is one. */
function excerptOf(content: string, needles: string[]): { text: string; truncated: boolean; centredOnMention: boolean } {
  const text = plainText(content.slice(0, 400_000));
  if (text.length <= EXCERPT_MAX) return { text, truncated: false, centredOnMention: false };
  const lower = text.toLowerCase();
  let at = -1;
  for (const n of needles) {
    const k = n.trim().toLowerCase();
    if (k.length >= 3 && (at = lower.indexOf(k)) !== -1) break;
  }
  if (at === -1) return { text: text.slice(0, EXCERPT_MAX), truncated: true, centredOnMention: false };
  const start = Math.max(0, Math.min(at - 500, text.length - EXCERPT_MAX));
  return { text: text.slice(start, start + EXCERPT_MAX), truncated: true, centredOnMention: true };
}

export const reviewContextTool = defineTool({
  name: "prism_people_review_context",
  scope: "read",
  title: "Context for one review row",
  description:
    "Everything needed to decide ONE review row, bounded: a ≤1,500-character excerpt of the source note (centred on the first mention of " +
    "the identity), its key metadata, and for each candidate person a summary plus measured signals — `priorResolutionsOfThisKey` (how often " +
    "this exact key was already resolved to them), `sameRelationshipLinks` (their existing links of this kind), `sharedNeighbours` (notes " +
    "linked to both the source and the candidate, e.g. the same project) and `alreadyLinked`.",
  inputSchema: z.object({ id: z.string().min(1).max(64) }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: isServerOwner,
  async handler({ id }, ctx) {
    const vaultId = ctx.principal.actor.vaultId;
    const cand = getCandidate(vaultId, id);
    if (!cand) throw new ToolError("not_found", "no such review row");
    const idx = await loadIndex(vaultId);
    let src: Note;
    try {
      src = await peopleVault(vaultId).getNote(cand.sourceNoteId, { includeLinks: true });
    } catch (e) {
      if ((e as { status?: number })?.status === 404) throw new ToolError("not_found", "the source note no longer exists — dismiss the row");
      throw new ToolError("upstream_error", "the vault could not return the source note");
    }
    const md = src.metadata ?? {};
    const metadata: Record<string, string> = {};
    for (const k of SOURCE_META_KEYS) {
      const v = md[k];
      if (v === undefined || v === null || v === "") continue;
      metadata[k] = cut(typeof v === "string" ? v : JSON.stringify(v), 300);
    }
    const links = Array.isArray(src.links) ? src.links : [];
    const srcNeighbours = new Set(links.map((l) => (l.sourceId === src.id ? l.targetId : l.sourceId)));
    const prior = resolvedCountsForKey(vaultId, cand.key.kind, cand.key.hash);
    const candidates = cand.candidateIds.slice(0, 10).map((pid) => {
      const s = summarize(idx, pid);
      const n = idx.get(pid);
      if (!n || "missing" in s) return s;
      const plinks = Array.isArray(n.links) ? n.links : [];
      const shared = [...new Set(plinks.map((l) => (l.sourceId === n.id ? l.targetId : l.sourceId)).filter((x) => x !== src.id && srcNeighbours.has(x)))];
      return {
        ...s,
        emails: personKeys(n).strong.filter((k) => k.kind === "email").slice(0, 5).map((k) => k.value),
        priorResolutionsOfThisKey: prior[n.id] ?? 0,
        sameRelationshipLinks: plinks.filter((l) => l.relationship === cand.relationship && l.targetId === n.id).length,
        sharedNeighbours: { count: shared.length, ids: shared.slice(0, 10) },
        alreadyLinked: links.some((l) => l.relationship === cand.relationship && l.sourceId === src.id && l.targetId === n.id),
      };
    });
    const ownerOnly = ownerOnlyReason(cand);
    return {
      row: { ...rowView(cand, idx), status: cand.status, candidates: undefined },
      source: {
        id: src.id,
        path: src.path,
        title: titleOf(src),
        kinds: noteKinds(src),
        updatedAt: src.updatedAt,
        metadata,
        linkCount: links.length,
        excerpt: excerptOf(src.content ?? "", [cand.display ?? "", cand.key.value]),
      },
      candidates,
      decide: {
        agentDecidable: ownerOnly === null && cand.status === "open",
        ...(ownerOnly ? { ownerOnly } : {}),
        addIdentityAllowed: !isNameOnly(cand),
      },
    };
  },
});

// ── write: decide one row ────────────────────────────────────────────────────

export const reviewDecideTool = defineTool({
  name: "prism_people_review_decide",
  scope: "write",
  title: "Decide one review row",
  description:
    "Decide ONE open review row. `decision: \"resolve\"` links the source note to `person_id` — which MUST be one of the row's candidates — " +
    "with the row's relationship (one links-only write, compare-and-swap; nothing is forced). `decision: \"dismiss\"` closes the row without a " +
    "link (it is never re-queued). `rationale` is REQUIRED and is shown to the owner. `add_identity` (default false) also teaches the person " +
    "this key so it links by itself in future — refused when the evidence is only a name. Rows filed by an agent and tombstone-unresolved rows " +
    "are owner-only. There is a per-credential daily limit; a `conflict` with reason `busy` means retry later. When two candidates remain " +
    "plausible, do NOT call this — leave the row open.",
  inputSchema: z.object({
    id: z.string().min(1).max(64),
    decision: z.enum(["resolve", "dismiss"]),
    person_id: z.string().min(1).max(200).optional().describe("Required for resolve: one of the row's candidate person ids"),
    add_identity: z.boolean().default(false),
    rationale: z.string().min(12).max(RATIONALE_MAX).describe("Why — the evidence, quoting note ids. Stored for the owner."),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  access: isServerOwner,
  async handler(a, ctx) {
    const p = ctx.principal;
    const vaultId = p.actor.vaultId;
    const cand = getCandidate(vaultId, a.id);
    if (!cand) throw new ToolError("not_found", "no such review row");
    if (cand.status !== "open") throw new ToolError("conflict", "that row is already decided", { reason: "not_open", status: cand.status });
    const ownerOnly = ownerOnlyReason(cand);
    if (ownerOnly) throw new ToolError("forbidden", ownerOnly);
    if (a.decision === "resolve") {
      if (!a.person_id) throw new ToolError("invalid_request", "person_id is required to resolve");
      if (!cand.candidateIds.includes(a.person_id)) throw new ToolError("invalid_request", "person_id must be one of this row's candidates — an agent cannot link a row to anyone else");
      if (a.add_identity && isNameOnly(cand)) throw new ToolError("invalid_request", "add_identity is refused for name-only evidence: a name is never an identity key");
    } else if (a.person_id || a.add_identity) throw new ToolError("invalid_request", "person_id / add_identity do not apply to a dismissal");
    if (peopleLockHolder()) throw busyError();
    const remaining = capOrThrow(p, "decide", config.peopleAgentDecisionsPerDay);

    const entry = beginAgentAction({ vaultId, capKey: capKeyOf(p), credentialId: p.credentialId, kind: a.decision, candidateId: cand.id, personId: a.person_id ?? null, rationale: a.rationale });
    // ids, a hash and a length — the rationale text itself lives in the decision ledger only.
    const auditExtra = { agent: true, credentialId: p.credentialId, decisionId: entry.id, rationaleHash: shortHash(a.rationale), rationaleLength: a.rationale.length };
    const caller = { via: auditVia(p), origin: "agent" as const, auditExtra };
    try {
      if (a.decision === "dismiss") {
        const dismissed = dismissReview(vaultId, cand, { audit: caller });
        entry.finish(dismissed ? "ok" : "open");
        return { ok: true, decision: "dismiss", candidateId: cand.id, dismissed, decisionId: entry.id, remainingToday: remaining };
      }
      const out = await resolveReview(vaultId, cand, a.person_id!, { addIdentity: a.add_identity, applyToKey: false, ...caller });
      const closed = out.resolved > 0;
      entry.finish(closed ? "ok" : out.errors ? "failed" : "open", out.personId);
      return {
        ok: closed,
        decision: "resolve",
        candidateId: cand.id,
        personId: out.personId,
        linked: out.linked,
        alreadyLinked: out.alreadyLinked,
        // The source changed under us / has no version: nothing was forced; the row is still open.
        stillOpen: !closed,
        conflicts: out.conflicts,
        noStamp: out.noStamp,
        missing: out.missing,
        errors: out.errors,
        identityAdded: out.identityAdded,
        identitySkipped: out.identitySkipped,
        decisionId: entry.id,
        remainingToday: remaining,
      };
    } catch (e) {
      if (e instanceof ReviewError) {
        if (e.code === "busy") {
          entry.finish("released");
          throw busyError();
        }
        if (e.code === "not_open") {
          entry.finish("released");
          throw new ToolError("conflict", "that row is already decided", { reason: "not_open" });
        }
        entry.finish("failed");
        if (e.code === "person_not_found") throw new ToolError("not_found", "that person no longer exists as a live person note");
        throw new ToolError("upstream_error", "the people listing is unavailable — try again later");
      }
      entry.finish("failed");
      throw e;
    }
  },
});

// ── read: duplicates ─────────────────────────────────────────────────────────

export const duplicatesTool = defineTool({
  name: "prism_people_duplicates",
  scope: "read",
  title: "Detected duplicate people",
  description:
    "Pairs of person notes the server detects as possibly the same human, with `strength` (strong | medium | weak) and the KINDS of evidence " +
    "(email, matrix, telegram, phone, handle, name, abbreviated-name, …). Each pair carries any open merge recommendation. Read-only: merging " +
    "is the owner's action in Prism; use prism_people_recommend_merge to recommend one.",
  inputSchema: z.object({
    strength: z.enum(["strong", "medium", "weak"]).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(100_000).default(0),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: isServerOwner,
  async handler(a, ctx) {
    const vaultId = ctx.principal.actor.vaultId;
    let all;
    try {
      all = await duplicatePairs(vaultId);
    } catch {
      throw new ToolError("upstream_error", "the people listing is unavailable — try again later");
    }
    const counts = { strong: 0, medium: 0, weak: 0 };
    for (const d of all) counts[d.strength]++;
    const filtered = a.strength ? all.filter((d) => d.strength === a.strength) : all;
    const recs = new Map(listRecommendations(vaultId, { limit: 200 }).map((r) => [pairKey(r.personIds[0], r.personIds[1]), r]));
    return {
      pairs: filtered.slice(a.offset, a.offset + a.limit).map((d) => {
        const r = recs.get(pairKey(d.a.id, d.b.id));
        return { ...d, recommendation: r ? { id: r.id, canonicalId: r.canonicalId, confidence: r.confidence } : null };
      }),
      total: filtered.length,
      counts,
      next: a.offset + a.limit < filtered.length ? a.offset + a.limit : null,
      openRecommendations: recs.size,
    };
  },
});

// ── write: recommend a merge (never a merge) ─────────────────────────────────

export const recommendMergeTool = defineTool({
  name: "prism_people_recommend_merge",
  scope: "write",
  title: "Recommend a merge to the owner",
  description:
    "Record a RECOMMENDATION that two person notes are the same human, with the proposed surviving note, your rationale and a confidence " +
    "(0–1). This does NOT merge and changes no note: the owner sees it next to the duplicate pairs in Prism and merges (or dismisses) there. " +
    "One recommendation per pair; recommending an open pair again replaces yours; a pair the owner already dismissed or merged stays closed.",
  inputSchema: z.object({
    person_ids: z.array(z.string().min(1).max(200)).length(2),
    canonical_id: z.string().min(1).max(200).describe("Which of the two should survive"),
    rationale: z.string().min(12).max(RATIONALE_MAX),
    confidence: z.number().min(0).max(1),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: isServerOwner,
  async handler(a, ctx) {
    const p = ctx.principal;
    const vaultId = p.actor.vaultId;
    const [x, y] = a.person_ids as [string, string];
    if (x === y) throw new ToolError("invalid_request", "person_ids must be two different person notes");
    if (a.canonical_id !== x && a.canonical_id !== y) throw new ToolError("invalid_request", "canonical_id must be one of person_ids");
    const idx = await loadIndex(vaultId);
    const nx = idx.get(x), ny = idx.get(y);
    if (!nx || !ny) throw new ToolError("not_found", "both ids must be person notes");
    for (const n of [nx, ny]) if (isTombstone(n) || isNonHumanPerson(n)) throw new ToolError("invalid_request", "both notes must be live person notes (not already merged, not a bot or organization)");
    const canonical = a.canonical_id === x ? nx : ny;
    const secondary = canonical === nx ? ny : nx;
    const owner = ownerProfile(idx, ownerConfigFor(vaultId)).person;
    if (owner && secondary.id === owner.id) throw new ToolError("invalid_request", "the owner's own person note can only be the surviving note");
    const remaining = capOrThrow(p, "recommend", config.peopleAgentRecommendationsPerDay);
    let pair = null;
    try {
      pair = (await duplicatePairs(vaultId)).find((d) => pairKey(d.a.id, d.b.id) === pairKey(nx.id, ny.id)) ?? null;
    } catch {
      /* detection unavailable: recorded as not detected */
    }
    const { result, recommendation } = recommendMerge({
      vaultId, a: nx.id, b: ny.id, canonicalId: canonical.id, rationale: a.rationale, confidence: a.confidence, detected: !!pair, capKey: capKeyOf(p), credentialId: p.credentialId,
    });
    if (result !== "closed") {
      const entry = beginAgentAction({ vaultId, capKey: capKeyOf(p), credentialId: p.credentialId, kind: "recommend", candidateId: recommendation.id, personId: canonical.id, rationale: a.rationale });
      entry.finish("ok");
    }
    recordAction({
      actorEmail: config.ownerEmail,
      via: auditVia(p),
      origin: "agent",
      action: "agent.people-merge-recommend",
      vaultId,
      target: { recommendationId: recommendation.id, personIds: [nx.id, ny.id], canonicalId: canonical.id, detected: !!pair, strength: pair?.strength ?? null, confidence: a.confidence, result, credentialId: p.credentialId, rationaleHash: shortHash(a.rationale) },
      status: result === "closed" ? "refused" : "ok",
    });
    return {
      ok: result !== "closed",
      result,
      merged: false,
      recommendation: { id: recommendation.id, status: recommendation.status, personIds: recommendation.personIds, canonicalId: recommendation.canonicalId, detected: recommendation.detected },
      pair: pair ? { strength: pair.strength, evidence: pair.evidence } : null,
      note: result === "closed" ? "the owner already decided this pair; nothing was recorded" : "recorded for the owner to review in Prism — nothing was merged",
      remainingToday: result === "closed" ? remaining + 1 : remaining,
    };
  },
});

// ── write: file a gap into the queue ─────────────────────────────────────────

/** Relationships whose target is a person (what a filed row can ask the owner to link). */
const PERSON_RELATIONSHIPS = ["messages-with", "email-from", "email-to", "attended-by", "assigned-to"] as const;

export const fileReviewTool = defineTool({
  name: "prism_people_file_review",
  scope: "write",
  title: "File a missing link for the owner to review",
  description:
    "You noticed a record that should be linked to a person but is not (or a human sender with no person note). This puts the question INTO " +
    "the review queue for the owner — it links nothing and creates no person. Give the source note, the canonical relationship, the identity " +
    "as seen (`key`), and up to 5 candidate person ids (none = \"no person note exists for this human\"). Rows filed here can only be decided " +
    "by the owner, never by an agent.",
  inputSchema: z.object({
    source_note_id: z.string().min(1).max(200),
    relationship: z.enum(PERSON_RELATIONSHIPS),
    key: z.object({ kind: z.enum(["name", "email", "matrix", "telegram", "phone"]), value: z.string().min(2).max(320) }),
    display: z.string().min(1).max(160).optional().describe("The name as it appears in the source"),
    candidate_ids: z.array(z.string().min(1).max(200)).max(5).default([]),
    rationale: z.string().min(12).max(RATIONALE_MAX),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: isServerOwner,
  async handler(a, ctx) {
    const p = ctx.principal;
    const vaultId = p.actor.vaultId;
    let src: Note;
    try {
      src = await peopleVault(vaultId).getNote(a.source_note_id, { includeLinks: true });
    } catch (e) {
      if ((e as { status?: number })?.status === 404) throw new ToolError("not_found", "no such source note");
      throw new ToolError("upstream_error", "the vault could not return the source note");
    }
    const shape = CANONICAL[a.relationship as CanonicalRelationship];
    const kinds = noteKinds(src);
    if (shape.from !== "any" && !kinds.some((k) => (shape.from as string[]).includes(k)))
      throw new ToolError("invalid_request", `${a.relationship} runs from a ${(shape.from as string[]).join(" / ")} note; this note is ${kinds.join(" + ")}`);
    const idx = await loadIndex(vaultId);
    const ids: string[] = [];
    for (const id of a.candidate_ids) {
      const n = idx.get(id);
      if (!n || isTombstone(n) || isNonHumanPerson(n)) throw new ToolError("invalid_request", `candidate ${cut(id, 60)} is not a live person note`);
      if ((src.links ?? []).some((l) => l.relationship === a.relationship && l.sourceId === src.id && l.targetId === n.id))
        throw new ToolError("invalid_request", "the source is already linked to that candidate with this relationship");
      ids.push(n.id);
    }
    const remaining = capOrThrow(p, "file", config.peopleAgentFilesPerDay);
    const value = a.key.kind === "name" ? a.key.value.trim() : a.key.value.trim().toLowerCase();
    const result = enqueueCandidate({
      vaultId,
      sourceNoteId: src.id,
      relationship: a.relationship,
      key: { kind: a.key.kind, value },
      display: a.display ?? (a.key.kind === "name" ? value : null),
      candidateIds: ids,
      reason: ids.length ? "agent-flagged" : "agent-unmatched",
      origin: "agent:mcp",
    });
    const counted = result === "created" || result === "refreshed";
    if (counted) beginAgentAction({ vaultId, capKey: capKeyOf(p), credentialId: p.credentialId, kind: "file", candidateId: null, personId: null, rationale: a.rationale }).finish("ok");
    recordAction({
      actorEmail: config.ownerEmail,
      via: auditVia(p),
      origin: "agent",
      action: "agent.people-review-file",
      vaultId,
      target: { sourceNoteId: src.id, relationship: a.relationship, keyKind: a.key.kind, keyHash: shortHash(`${a.key.kind}\u0000${value}`), candidates: ids, result, credentialId: p.credentialId, rationaleHash: shortHash(a.rationale) },
      status: counted ? "ok" : "refused",
    });
    return {
      ok: counted,
      result,
      note:
        result === "closed" ? "the owner already decided this exact question; it stays closed" : result === "full" ? "the review queue is full; nothing was filed — report it instead" : "filed for the owner; nothing was linked",
      remainingToday: counted ? remaining : remaining + 1,
    };
  },
});

// ── read: measured status ────────────────────────────────────────────────────

export const linkStatusTool = defineTool({
  name: "prism_people_link_status",
  scope: "read",
  title: "Linking layer status (measured numbers)",
  description:
    "The numbers a maintenance report should quote instead of its own estimates: open review rows (total, by reason, by relationship, oldest, " +
    "older than 7/30 days), rows closed in the last 24 h, agent actions and remaining daily allowances, duplicate-pair counts, open merge " +
    "recommendations, the last link job's outcome (and its per-phase planned counts while the server remembers it), and whether a people " +
    "operation is running right now. Call it before and after a run and report the difference.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  access: isServerOwner,
  async handler(_a, ctx) {
    const p = ctx.principal;
    const vaultId = p.actor.vaultId;
    let duplicates: { strong: number; medium: number; weak: number } | null = { strong: 0, medium: 0, weak: 0 };
    try {
      for (const d of await duplicatePairs(vaultId)) duplicates![d.strength]++;
    } catch {
      duplicates = null; // unknown is reported as unknown, never as zero
    }
    const job = linkJobStatus();
    const allowance = (budget: "decide" | "file" | "recommend", limit: number) => {
      const used = agentActionsLastDay(capKeyOf(p), budget);
      return { limit: Math.max(0, limit), used, remaining: Math.max(0, limit - used) };
    };
    return {
      at: new Date().toISOString(),
      vaultId,
      queue: queueStats(vaultId),
      queueCapacity: config.peopleQueueMaxOpen,
      agentActionsLastDay: agentActionCounts(vaultId),
      allowance: {
        decisions: allowance("decide", config.peopleAgentDecisionsPerDay),
        filed: allowance("file", config.peopleAgentFilesPerDay),
        recommendations: allowance("recommend", config.peopleAgentRecommendationsPerDay),
      },
      duplicates,
      openMergeRecommendations: openRecommendationCount(vaultId),
      lastJob: lastLinkJobOutcome(vaultId),
      // Planned-but-unwritten links per phase from the job the server still holds in memory (null after a restart).
      lastJobPlan:
        job && job.vaultId === vaultId
          ? { jobId: job.id, dryRun: job.dryRun, status: job.status, phases: Object.fromEntries(job.phases.map((ph) => [ph, { scanned: job.report[ph].scanned, wouldLink: job.report[ph].wouldLink, notesToWrite: job.report[ph].notesToWrite, alreadyLinked: job.report[ph].alreadyLinked, queued: job.report[ph].queued }])) }
          : null,
      running: peopleLockHolder(),
    };
  },
});

export const PEOPLE_READ_TOOL_NAMES = ["prism_people_review_queue", "prism_people_review_context", "prism_people_duplicates", "prism_people_link_status"] as const;
export const PEOPLE_WRITE_TOOL_NAMES = ["prism_people_review_decide", "prism_people_recommend_merge", "prism_people_file_review"] as const;

export const PEOPLE_TOOLS = [reviewQueueTool, reviewContextTool, reviewDecideTool, duplicatesTool, recommendMergeTool, fileReviewTool, linkStatusTool] as unknown as PrismTool[];
