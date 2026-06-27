import type { ContentType, Note } from "../types";
import tagSchemas from "./tag-schemas.json";

/** Shape of a single tag entry in the canonical tag-schemas.json. */
type TagSchemaEntry = {
  description?: string;
  contentType: string;
  precedence: number;
  fields?: Record<string, unknown>;
  rustContentType?: string;
};

/**
 * Structural subset that `inferContentType` / `getStructuralTag` actually read.
 * Both `Note` and `NoteTreeEntry` satisfy it — accepting this lets the lean
 * tree-view payload share the same type-inference helpers as full notes.
 */
type NoteForTypeInference = Pick<Note, "metadata" | "tags" | "path"> & {
  // Optional: when the full note body is available, content sniffing catches
  // structural types (e.g. an Excalidraw canvas) even if tags/metadata are missing
  // or wrong. Lean tree/tab payloads omit it and fall back to tag/ext inference.
  content?: string | null;
};

/** A note body that is an Excalidraw scene (the canonical canvas format). This is
 *  ground truth — a note containing this IS a canvas no matter what its tags say. */
export function looksLikeExcalidrawScene(content: string | null | undefined): boolean {
  if (!content) return false;
  const c = content.trimStart();
  if (!c.startsWith("{")) return false;
  if (!c.includes('"elements"')) return false;
  return c.includes('"appState"') || c.includes("excalidraw") || /"type"\s*:\s*"(rectangle|ellipse|diamond|arrow|line|freedraw|text|frame)"/.test(c);
}

// Known Prism renderer types
const KNOWN_TYPES = new Set<string>([
  "document", "note", "presentation", "code", "email",
  "message-thread", "task-board", "task", "event",
  "project", "spreadsheet", "website", "canvas", "briefing",
  "dashboard", "messages-dashboard",
]);

// Tag → ContentType mapping, ordered by priority (first match wins).
// DERIVED from the canonical tag-schemas.json (the single source of truth shared
// with the Rust `enrich_note` mapping) — do NOT hardcode entries here. The order
// reproduces the original hand-authored priority via each tag's ascending
// `precedence` (lower = higher priority).
// NOTE: "project" is intentionally lower-priority than document subtypes — the
// "project" tag is often used organizationally ("belongs to X project"), not
// structurally ("IS a project definition"). Only use ProjectRenderer when no more
// specific type is present. This is encoded as a high `precedence` in the JSON.
const TAG_TO_CONTENT_TYPE: [string, ContentType][] = Object.entries(
  (tagSchemas as unknown as { tags: Record<string, TagSchemaEntry> }).tags
)
  .sort(([, a], [, b]) => a.precedence - b.precedence)
  .map(([tag, entry]): [string, ContentType] => [tag, entry.contentType as ContentType]);

// Infer content type from note metadata, tags, or heuristics
export function inferContentType(note: NoteForTypeInference): ContentType {
  const meta = note.metadata;

  // 0. Content ground truth FIRST: a note whose body is an Excalidraw scene IS a
  // canvas — even if a stale tag or the desktop's Rust enrichment stamped a
  // different prism_type on it (the enrichment defaults unrecognized notes to
  // "document"). Content wins, so canvases render correctly everywhere.
  if (looksLikeExcalidrawScene(note.content)) return "canvas";

  // 1a. Backend-enriched prism_type (set by Rust enrichment layer)
  if (meta && typeof meta.prism_type === "string" && KNOWN_TYPES.has(meta.prism_type)) {
    return meta.prism_type as ContentType;
  }

  // 1b. Explicit metadata.type — known renderer types pass through; unknown types
  // that clearly describe document-like content fall back to "document" rather than
  // continuing to tag inference (which might incorrectly pick a structural renderer).
  if (meta && typeof meta.type === "string") {
    if (KNOWN_TYPES.has(meta.type)) return meta.type as ContentType;
    // Treat any unrecognized type as a document subtype
    if (meta.type.length > 0) return "document";
  }

  // 2. Tag-based inference — check tags against the mapping table
  if (note.tags && note.tags.length > 0) {
    const tagSet = new Set(note.tags);
    for (const [tag, type] of TAG_TO_CONTENT_TYPE) {
      if (tagSet.has(tag)) {
        return type;
      }
    }
  }

  // 3. Path-based inference — check file extension
  if (note.path) {
    const ext = note.path.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "md":
      case "txt":
      case "doc":
      case "docx":
        return "document";
      case "ts":
      case "tsx":
      case "js":
      case "jsx":
      case "py":
      case "rs":
      case "go":
      case "java":
      case "rb":
      case "c":
      case "cpp":
      case "h":
      case "css":
      case "scss":
      case "json":
      case "yaml":
      case "yml":
      case "toml":
      case "sh":
      case "bash":
        return "code";
      case "html":
      case "htm":
        return "website";
      case "csv":
      case "tsv":
      case "xlsx":
        return "spreadsheet";
      case "excalidraw":
        return "canvas";
    }
  }

  // 4. Default to document
  return "document";
}

// Dev-time self-check (cheap; runs once at module load): confirm the mapping
// derived from tag-schemas.json resolves every canonical tag to its declared
// contentType under first-match-wins. This guards against the JSON drifting from
// the renderer pipeline. Logs (never throws) so it can never break production.
{
  const canonicalTags = (tagSchemas as unknown as {
    tags: Record<string, TagSchemaEntry>;
  }).tags;
  for (const [tag, entry] of Object.entries(canonicalTags)) {
    const resolved = inferContentType({ tags: [tag], metadata: null, path: null, content: null });
    if (resolved !== entry.contentType) {
      // eslint-disable-next-line no-console
      console.error(
        `[content-types] tag-schema drift: "${tag}" resolved to "${resolved}" but tag-schemas.json declares "${entry.contentType}"`
      );
    }
  }
}

// The original vault tag for a note (the structural tag that determined its type)
export function getStructuralTag(note: NoteForTypeInference): string | null {
  if (note.tags && note.tags.length > 0) {
    const tagSet = new Set(note.tags);
    for (const [tag] of TAG_TO_CONTENT_TYPE) {
      if (tagSet.has(tag)) {
        return tag;
      }
    }
  }
  return null;
}

// Icon name mapping for content types (Lucide icon names)
export const CONTENT_TYPE_ICONS: Record<ContentType, string> = {
  document: "FileText",
  note: "StickyNote",
  presentation: "Presentation",
  code: "Code",
  email: "Mail",
  "message-thread": "MessageSquare",
  "task-board": "LayoutDashboard",
  task: "CheckSquare",
  event: "Calendar",
  project: "FolderKanban",
  spreadsheet: "Table2",
  website: "Globe",
  canvas: "Frame",
  briefing: "Newspaper",
  dashboard: "LayoutDashboard",
  "messages-dashboard": "MessageSquare",
};

// Display names
export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  document: "Document",
  note: "Note",
  presentation: "Presentation",
  code: "Code",
  email: "Email",
  "message-thread": "Messages",
  "task-board": "Task Board",
  task: "Task",
  event: "Event",
  project: "Project",
  spreadsheet: "Spreadsheet",
  website: "Website",
  canvas: "Canvas",
  briefing: "Briefing",
  dashboard: "Dashboard",
  "messages-dashboard": "Messages",
};
