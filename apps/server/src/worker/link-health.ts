/**
 * Link health — a cheap, READ-ONLY daily measure of how well the newest notes are
 * LINKED (the lint next door measures field SHAPES; a vault can be perfectly shaped
 * and still fall apart into unconnected notes).
 *
 * What it reads (lean listings only — no bodies, only the metadata keys named here,
 * every listing capped; the work is bounded by LINK_HEALTH_SAMPLE and
 * LINK_HEALTH_TARGET_CAP, never by the size of the vault):
 *   - three TARGET listings: person, project, organization → id / path sets
 *     (+ project slug, title, aliases), ≤ LINK_HEALTH_TARGET_CAP rows each;
 *   - one SAMPLE listing per measured tag: the newest LINK_HEALTH_SAMPLE notes by
 *     `updated_at`, with their hydrated links.
 *
 * Measures (share = hit / n, 0..1):
 *   meeting.person             meetings with ≥ 1 link to a person note
 *                              (a vault link, or a person wikilink in `attendees`)
 *   meeting.project            meetings with ≥ 1 resolvable project
 *   meeting.project.resolved   of the `projects` VALUES meetings hold, the share
 *                              that resolve to a project note
 *   transcript.meeting         transcripts tied to a meeting (also tagged `meeting`,
 *                              `meetingNoteId`, or a has-transcript / documented-by link)
 *   task.project               tasks with a resolvable project
 *   task.project.resolved      of the task `project` VALUES, the share that resolve
 *   email.person               emails linked to a person note
 *   thread.person              message threads linked to a person note
 *   person.linked              person notes with ≥ 1 link of any kind (not orphans)
 *   dangling                   LOWER IS BETTER: of the wikilinks in relation fields
 *                              that point into the people / projects / organizations
 *                              folders, the share whose target note does not exist
 *
 * Reported as the `link-health` health source (GET /acl/workers). `failing` (→ the
 * usual once-per-episode alert) when a measure with ≥ LINK_HEALTH_MIN_SAMPLE notes
 *   (a) is under an explicit floor (LINK_HEALTH_MIN_<MEASURE>; for `dangling`
 *       LINK_HEALTH_MAX_DANGLING) — none is set by default, or
 *   (b) has fallen LINK_HEALTH_MAX_DROP (0.2) below its own running level. The level
 *       is a slow average of past runs and is frozen while the measure is low, so a
 *       linker that stops keeps alerting until it is fixed, without anyone having to
 *       guess a threshold first.
 * Counts and measure names only — never a value, path or id. Off unless
 * LINK_HEALTH_ENABLED=true; never throws into the tick.
 */
import { config } from "../config";
import { getWorkerCursor, setWorkerCursor } from "../db";
import { vaultClient } from "../parachute";

const CURSOR = "link-health";
/** Weight of the newest run in the running level (the rest stays with the past). */
const LEVEL_ALPHA = 0.2;

export const LINK_MEASURES = [
  "meeting.person", "meeting.project", "meeting.project.resolved", "transcript.meeting",
  "task.project", "task.project.resolved", "email.person", "thread.person", "person.linked", "dangling",
] as const;
export type LinkMeasure = (typeof LINK_MEASURES)[number];
/** Measures where a HIGHER share is worse. */
const LOWER_IS_BETTER: ReadonlySet<string> = new Set(["dangling"]);

/** Relation fields whose wikilink values are checked for a missing target. */
const RELATION_FIELDS = ["attendees", "people", "projects", "project", "organizations", "collaborators"] as const;
const SAMPLE_KEYS: Readonly<Record<string, readonly string[]>> = {
  meeting: ["attendees", "projects", "organizations", "transcriptNoteId", "transcriptNoteIds"],
  transcript: ["attendees", "projects", "meetingNoteId"],
  task: ["project", "projects"],
  email: ["source"],
  "message-thread": ["platform"],
  person: ["type"],
};
const TRANSCRIPT_RELATIONSHIPS: ReadonlySet<string> = new Set(["has-transcript", "documented-by"]);

export interface LinkRow {
  id: string;
  path?: string | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  links?: Array<{ sourceId: string; targetId: string; relationship: string }>;
  displayTitle?: string | null;
}

export interface MeasureResult {
  n: number;
  hit: number;
  share: number;
  /** The running level this measure is compared with (null until it has one). */
  level: number | null;
}

export interface LinkHealthOutcome {
  at: string;
  status: "ok" | "failing" | "error";
  error?: string;
  measures: Record<string, MeasureResult>;
  /** Measures that are under their floor or have dropped below their level. */
  low: string[];
  /** Target listings that hit the cap (their `dangling` checks were skipped). */
  truncated: string[];
}

export interface LinkHealthDeps {
  /** A lean listing of one tag: newest first, no bodies, only `keys` of the metadata. */
  list?: (tag: string, keys: readonly string[], limit: number, withLinks: boolean) => Promise<LinkRow[]>;
  now?: () => number;
  sample?: number;
  minSample?: number;
  maxDrop?: number;
  targetCap?: number;
  /** measure → floor (ceiling for lower-is-better measures). */
  floors?: Readonly<Record<string, number>>;
  getCursor?: (vaultId: string, name: string) => string | null;
  setCursor?: (vaultId: string, name: string, v: string) => void;
}

/** `LINK_HEALTH_MIN_MEETING_PERSON=0.5` → `{ "meeting.person": 0.5 }`; `LINK_HEALTH_MAX_DANGLING` for `dangling`. */
export function floorsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of LINK_MEASURES) {
    const key = `LINK_HEALTH_${LOWER_IS_BETTER.has(m) ? "MAX" : "MIN"}_${m.toUpperCase().replace(/\./g, "_")}`;
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0 && v <= 1) out[m] = v;
  }
  return out;
}

/** The target of a `[[wikilink]]` value (label and heading dropped), or null when the value is not one. */
export function wikilinkTarget(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t.startsWith("[[") || !t.endsWith("]]")) return null;
  let target = t.slice(2, -2);
  for (const ch of ["|", "#"]) {
    const k = target.indexOf(ch);
    if (k >= 0) target = target.slice(0, k);
  }
  target = target.trim().replace(/^\/+|\/+$/g, "");
  return target || null;
}

const values = (v: unknown): unknown[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
const lower = (s: string): string => s.trim().toLowerCase();

export interface Targets {
  personIds: Set<string>;
  personPaths: Set<string>;
  projectIds: Set<string>;
  projectPaths: Set<string>;
  /** Lower-cased slugs, titles and aliases a plain (non-link) project value may use. */
  projectNames: Set<string>;
  orgPaths: Set<string>;
  truncated: string[];
}

export function buildTargets(people: readonly LinkRow[], projects: readonly LinkRow[], orgs: readonly LinkRow[], cap: number): Targets {
  const paths = (rows: readonly LinkRow[]) => new Set(rows.map((r) => (r.path ?? "").replace(/^\/+|\/+$/g, "")).filter(Boolean));
  const projectNames = new Set<string>();
  for (const p of projects) {
    const parts = (p.path ?? "").split("/").filter(Boolean);
    // vault/projects/<slug>/PROJECT → <slug>; a legacy note at vault/projects/<slug> → <slug>.
    const slug = parts.length >= 3 && parts[0] === "vault" && parts[1] === "projects" ? parts[2] : undefined;
    if (slug) projectNames.add(lower(slug));
    const md = p.metadata ?? {};
    for (const v of [md.title, md.slug, p.displayTitle, ...values(md.aliases)]) if (typeof v === "string" && v.trim()) projectNames.add(lower(v));
  }
  const truncated = [
    ...(people.length >= cap ? ["person"] : []),
    ...(projects.length >= cap ? ["project"] : []),
    ...(orgs.length >= cap ? ["organization"] : []),
  ];
  return {
    personIds: new Set(people.map((r) => r.id)),
    personPaths: paths(people),
    projectIds: new Set(projects.map((r) => r.id)),
    projectPaths: paths(projects),
    projectNames,
    orgPaths: paths(orgs),
    truncated,
  };
}

/** Does one stored project value (a wikilink, a slug, a name) resolve to a project note? */
export function projectValueResolves(v: unknown, t: Targets): boolean {
  if (typeof v !== "string" || !v.trim()) return false;
  const target = wikilinkTarget(v);
  if (target !== null) return t.projectPaths.has(target); // the folder form `vault/projects/<slug>` is not a note
  return t.projectNames.has(lower(v));
}

const otherEnds = (row: LinkRow): string[] => (row.links ?? []).map((l) => (l.sourceId === row.id ? l.targetId : l.sourceId));

class Tally {
  private readonly counts = new Map<string, { n: number; hit: number }>();
  add(measure: LinkMeasure, hit: boolean, n = 1): void {
    const c = this.counts.get(measure) ?? { n: 0, hit: 0 };
    c.n += n;
    if (hit) c.hit += n;
    this.counts.set(measure, c);
  }
  get(measure: string): { n: number; hit: number } {
    return this.counts.get(measure) ?? { n: 0, hit: 0 };
  }
}

/** Count dangling relation wikilinks on one note into `dangling` (only targets inside a folder whose listing is complete). */
function tallyDangling(row: LinkRow, t: Targets, tally: Tally): void {
  const md = row.metadata ?? {};
  const complete = (kind: string) => !t.truncated.includes(kind);
  for (const f of RELATION_FIELDS) {
    for (const v of values(md[f])) {
      const target = wikilinkTarget(v);
      if (target === null) continue;
      if (target.startsWith("vault/people/") && complete("person")) tally.add("dangling", !t.personPaths.has(target));
      else if (target.startsWith("vault/projects/") && complete("project")) tally.add("dangling", !t.projectPaths.has(target));
      else if (target.startsWith("vault/organizations/") && complete("organization")) tally.add("dangling", !t.orgPaths.has(target));
    }
  }
}

/** Pure: every measure from the sampled rows. `samples` is keyed by tag. */
export function measureLinks(samples: Readonly<Record<string, readonly LinkRow[]>>, t: Targets): Record<string, { n: number; hit: number }> {
  const tally = new Tally();
  const linkedToPerson = (row: LinkRow) => otherEnds(row).some((id) => t.personIds.has(id));
  const linkedToProject = (row: LinkRow) => otherEnds(row).some((id) => t.projectIds.has(id));

  for (const row of samples.meeting ?? []) {
    const md = row.metadata ?? {};
    const personWikilink = values(md.attendees).some((v) => {
      const target = wikilinkTarget(v);
      return target !== null && t.personPaths.has(target);
    });
    tally.add("meeting.person", linkedToPerson(row) || personWikilink);
    const projectValues = values(md.projects).filter((v) => typeof v === "string" && v.trim());
    tally.add("meeting.project", linkedToProject(row) || projectValues.some((v) => projectValueResolves(v, t)));
    for (const v of projectValues) tally.add("meeting.project.resolved", projectValueResolves(v, t));
    tallyDangling(row, t, tally);
  }
  for (const row of samples.transcript ?? []) {
    const md = row.metadata ?? {};
    const tied =
      (row.tags ?? []).includes("meeting") ||
      (typeof md.meetingNoteId === "string" && md.meetingNoteId.trim() !== "") ||
      (row.links ?? []).some((l) => TRANSCRIPT_RELATIONSHIPS.has(l.relationship));
    tally.add("transcript.meeting", tied);
    tallyDangling(row, t, tally);
  }
  for (const row of samples.task ?? []) {
    const md = row.metadata ?? {};
    const projectValues = [...values(md.project), ...values(md.projects)].filter((v) => typeof v === "string" && v.trim());
    tally.add("task.project", linkedToProject(row) || projectValues.some((v) => projectValueResolves(v, t)));
    for (const v of projectValues) tally.add("task.project.resolved", projectValueResolves(v, t));
    tallyDangling(row, t, tally);
  }
  for (const row of samples.email ?? []) tally.add("email.person", linkedToPerson(row));
  for (const row of samples["message-thread"] ?? []) tally.add("thread.person", linkedToPerson(row));
  for (const row of samples.person ?? []) tally.add("person.linked", (row.links ?? []).length > 0);

  return Object.fromEntries(LINK_MEASURES.map((m) => [m, tally.get(m)]));
}

export function lastLinkHealthOutcome(vaultId = "primary", getCursor: (v: string, n: string) => string | null = getWorkerCursor): LinkHealthOutcome | null {
  try {
    const raw = getCursor(vaultId, CURSOR);
    return raw ? (JSON.parse(raw) as LinkHealthOutcome) : null;
  } catch {
    return null;
  }
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export async function runLinkHealthOnce(vaultId = "primary", deps: LinkHealthDeps = {}): Promise<LinkHealthOutcome> {
  const now = deps.now ?? Date.now;
  const sample = deps.sample ?? config.linkHealthSample;
  const minSample = deps.minSample ?? config.linkHealthMinSample;
  const maxDrop = deps.maxDrop ?? config.linkHealthMaxDrop;
  const cap = deps.targetCap ?? config.linkHealthTargetCap;
  const floors = deps.floors ?? floorsFromEnv();
  const getCursor = deps.getCursor ?? getWorkerCursor;
  const setCursor = deps.setCursor ?? setWorkerCursor;
  const list =
    deps.list ??
    ((tag: string, keys: readonly string[], limit: number, withLinks: boolean) =>
      vaultClient(vaultId, { timeoutMs: 30_000 }).listNotes({ tags: [tag], limit, orderBy: "updated_at", includeMetadata: [...keys], includeLinks: withLinks }) as Promise<LinkRow[]>);

  const previous = lastLinkHealthOutcome(vaultId, getCursor);
  const measures: Record<string, MeasureResult> = {};
  const low: string[] = [];
  let truncated: string[] = [];
  let error: string | undefined;
  try {
    const people = await list("person", ["type"], cap, false);
    const projects = await list("project", ["title", "slug", "aliases"], cap, false);
    const orgs = await list("organization", ["type"], cap, false);
    const targets = buildTargets(people, projects, orgs, cap);
    truncated = targets.truncated;
    const samples: Record<string, LinkRow[]> = {};
    for (const [tag, keys] of Object.entries(SAMPLE_KEYS)) samples[tag] = await list(tag, keys, sample, true);
    const counted = measureLinks(samples, targets);
    for (const m of LINK_MEASURES) {
      const c = counted[m] ?? { n: 0, hit: 0 };
      const share = c.n ? round3(c.hit / c.n) : 0;
      const before = previous?.measures?.[m]?.level;
      let level: number | null = typeof before === "number" && Number.isFinite(before) ? before : null;
      let isLow = false;
      if (c.n >= minSample) {
        const worseBy = level === null ? 0 : LOWER_IS_BETTER.has(m) ? share - level : level - share;
        const floor = floors[m];
        const underFloor = floor !== undefined && (LOWER_IS_BETTER.has(m) ? share > floor : share < floor);
        isLow = underFloor || (maxDrop > 0 && worseBy >= maxDrop);
        // The level follows the measure slowly — and not at all while it is low, so a
        // linker that stopped is compared with how things were, not with its own outage.
        if (!isLow) level = round3(level === null ? share : level * (1 - LEVEL_ALPHA) + share * LEVEL_ALPHA);
      }
      if (isLow) low.push(m);
      measures[m] = { n: c.n, hit: c.hit, share, level };
    }
  } catch (e) {
    error = `link health: ${(e as Error).message}`.slice(0, 200);
    // Keep the levels through an errored run.
    for (const m of LINK_MEASURES) {
      const before = previous?.measures?.[m];
      if (before) measures[m] = { n: 0, hit: 0, share: before.share, level: before.level };
    }
  }
  const outcome: LinkHealthOutcome = {
    at: new Date(now()).toISOString(),
    status: error ? "error" : low.length ? "failing" : "ok",
    ...(error ? { error } : {}),
    measures,
    low,
    truncated,
  };
  try {
    setCursor(vaultId, CURSOR, JSON.stringify(outcome));
  } catch {
    /* health falls back to "never ran" */
  }
  return outcome;
}

/** Due when enabled and the last persisted run is older than the interval (restart-safe). */
export function linkHealthDue(vaultId = "primary", nowMs = Date.now(), getCursor: (v: string, n: string) => string | null = getWorkerCursor): boolean {
  if (!config.linkHealthEnabled || config.linkHealthIntervalMs <= 0) return false;
  const last = lastLinkHealthOutcome(vaultId, getCursor);
  const at = last ? Date.parse(last.at) : NaN;
  return !Number.isFinite(at) || nowMs - at >= config.linkHealthIntervalMs;
}
