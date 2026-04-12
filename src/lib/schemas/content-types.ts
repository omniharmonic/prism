import type { ContentType, Note } from "../types";

// Known Prism renderer types
const KNOWN_TYPES = new Set<string>([
  "document", "note", "presentation", "code", "email",
  "message-thread", "task-board", "task", "event",
  "project", "spreadsheet", "website", "canvas", "briefing",
  "dashboard", "messages-dashboard",
]);

// Tag → ContentType mapping, ordered by priority (first match wins)
// When a note has multiple structural tags, higher-priority mappings take precedence.
const TAG_TO_CONTENT_TYPE: [string, ContentType][] = [
  // High-priority: specific renderers
  ["task", "task"],
  ["slides", "presentation"],
  ["briefing", "briefing"],
  ["dashboard", "dashboard"],
  ["project", "project"],
  ["project-page", "website"],

  // Medium-priority: document subtypes (all render as documents)
  ["meeting", "document"],
  ["transcript", "document"],
  ["concept", "document"],
  ["writing", "document"],
  ["research", "document"],
  ["proposal", "document"],
  ["spec", "document"],
  ["script", "document"],
  ["person", "document"],
  ["organization", "document"],
  ["decision-record", "document"],
  ["grant-application", "document"],
  ["project-update", "document"],
  ["report", "document"],
  ["page", "document"],
  ["index", "document"],
];

// Infer content type from note metadata, tags, or heuristics
export function inferContentType(note: Note): ContentType {
  const meta = note.metadata;

  // 1a. Backend-enriched prism_type (set by Rust enrichment layer)
  if (meta && typeof meta.prism_type === "string" && KNOWN_TYPES.has(meta.prism_type)) {
    return meta.prism_type as ContentType;
  }

  // 1b. Explicit metadata.type — only if it's a known renderer type
  if (meta && typeof meta.type === "string" && KNOWN_TYPES.has(meta.type)) {
    return meta.type as ContentType;
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
      case "xlsx":
        return "spreadsheet";
    }
  }

  // 4. Default to document
  return "document";
}

// The original vault tag for a note (the structural tag that determined its type)
export function getStructuralTag(note: Note): string | null {
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
