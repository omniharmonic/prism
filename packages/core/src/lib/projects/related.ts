/** Project membership is metadata.projects; legacy project values remain readable during migration. */
import { inferContentType } from "../schemas/content-types";
export const PROJECT_SECTIONS = ["meetings", "tasks", "documents", "people"] as const;
export type ProjectSection = typeof PROJECT_SECTIONS[number];
export interface ProjectNote { id: string; path?: string | null; tags?: string[] | null; metadata?: Record<string, unknown> | null; updatedAt?: string | null }
export interface ProjectRelatedRow { id: string; path: string | null; title: string; type: string; status: string | null; date: string | null; updatedAt: string | null }
export interface ProjectRelatedPage { items: ProjectRelatedRow[]; next: string | null; total: number }
export function projectTarget(value: string): string {
  return value.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split(/[|#]/)[0]!.trim().replace(/\.md$/i, "").replace(/\/+$/, "").toLowerCase();
}
export function projectReferences(project: ProjectNote): Set<string> {
  const refs = [project.id, project.path ?? ""];
  const folder = (project.path ?? "").replace(/\/PROJECT(?:\.md)?$/i, "");
  if (folder.startsWith("vault/projects/")) refs.push(folder, folder.slice("vault/projects/".length));
  if (typeof project.metadata?.slug === "string") refs.push(project.metadata.slug);
  return new Set(refs.filter(Boolean).map(projectTarget));
}
export function belongsToProject(note: ProjectNote, project: ProjectNote): boolean {
  if (note.id === project.id) return false;
  const refs = projectReferences(project);
  // A populated canonical field wins over stale singular metadata.
  const value = note.metadata?.projects ?? note.metadata?.project;
  const values = Array.isArray(value) ? value : [value];
  return values.some(v => typeof v === "string" && refs.has(projectTarget(v)));
}
export function projectSection(note: ProjectNote): ProjectSection {
  const tags = note.tags ?? [];
  if (tags.includes("person") || note.metadata?.type === "person") return "people";
  if (tags.includes("task") || note.metadata?.type === "task") return "tasks";
  if (tags.includes("meeting") || tags.includes("transcript") || note.metadata?.type === "meeting") return "meetings";
  return "documents";
}
export function projectIsLive(note: ProjectNote): boolean {
  return !note.tags?.some(t => ["prism-trashed", "template", "duplicate"].includes(t)) && !note.metadata?.prism_trashed_at && !note.metadata?.merged_into;
}
export function projectRelatedPage(notes: ProjectNote[], project: ProjectNote, kind: ProjectSection, after = "", limit = 6): ProjectRelatedPage {
  const rows = notes.filter(n => projectIsLive(n) && belongsToProject(n, project) && projectSection(n) === kind)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id));
  const start = after ? rows.findIndex(n => n.id === after) + 1 : 0;
  if (after && !start) throw new Error("project_cursor_changed");
  const page = rows.slice(start, start + limit);
  return { total: rows.length, next: start + limit < rows.length ? page.at(-1)!.id : null,
    items: page.map(n => ({ id: n.id, path: n.path ?? null, title: String(n.metadata?.title || n.metadata?.name || n.path?.split("/").pop() || "Untitled"),
      type: inferContentType({ path: n.path ?? null, tags: n.tags ?? null, metadata: n.metadata ?? null, content: null }), status: typeof n.metadata?.status === "string" ? n.metadata.status : null, date: typeof (kind === "tasks" ? n.metadata?.due_date ?? n.metadata?.due : kind === "meetings" ? n.metadata?.date ?? n.metadata?.start_time : null) === "string" ? String(kind === "tasks" ? n.metadata?.due_date ?? n.metadata?.due : n.metadata?.date ?? n.metadata?.start_time) : null, updatedAt: n.updatedAt ?? null })) };
}
