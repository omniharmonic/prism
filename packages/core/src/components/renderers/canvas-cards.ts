import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { Note } from "../../lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Shared "note card" helpers for the Excalidraw canvas — the single source of
 * truth for embedding a Parachute note as a card element. Used by both the
 * offline `CanvasRenderer` and the collaborative `CollabCanvas` so the two
 * agree on card shape, colors, and how an embedded note is identified
 * (`el.type === "rectangle" && el.customData.prismNoteId`).
 */

/** Build a rich multi-line label for a note card (title + tag-aware metadata). */
export function buildCardLabel(note: Note, includeBody: boolean): string {
  const meta = (note.metadata || {}) as Record<string, any>;
  const title = (typeof meta.title === "string" && meta.title.trim()) || note.path?.split("/").pop() || "Untitled";
  const tags = note.tags || [];
  const lines = [title];

  // Tag-specific metadata
  if (tags.includes("task")) {
    const parts = [];
    if (meta.status) parts.push(meta.status);
    if (meta.priority) parts.push(`P: ${meta.priority}`);
    if (meta.due) parts.push(`Due: ${meta.due}`);
    if (parts.length) lines.push(parts.join(" · "));
  } else if (tags.includes("person")) {
    const channels: string[] = [];
    if (meta.email) channels.push("Email");
    if (meta.phone) channels.push("Phone");
    if (meta.channels && typeof meta.channels === "object") {
      channels.push(...Object.keys(meta.channels).filter((k) => meta.channels[k]));
    }
    if (channels.length) lines.push(channels.join(" · "));
  } else if (tags.includes("project")) {
    if (meta.status) lines.push(meta.status);
  } else if (tags.includes("meeting") || tags.includes("event")) {
    if (meta.date) lines.push(meta.date);
    if (meta.attendees) {
      const att = Array.isArray(meta.attendees) ? meta.attendees.slice(0, 3).join(", ") : String(meta.attendees);
      lines.push(att);
    }
  }

  // Body content preview
  if (includeBody && note.content && note.content.trim().length > 1) {
    const plain = note.content.replace(/<[^>]+>/g, "").trim();
    const preview = plain.length > 120 ? plain.slice(0, 120) + "…" : plain;
    if (preview) {
      lines.push("───");
      lines.push(preview);
    }
  }

  if (tags.length > 0) lines.push(`[${tags.slice(0, 3).join(", ")}]`);
  return lines.join("\n");
}

/** Canonical scene colors. Excalidraw maps these to the active display theme. */
export function getCardColor(note: Note, _isDark: boolean): { bg: string; stroke: string; text: string } {
  const base = { bg: "#ffffff", stroke: "#d8dde5", text: "#252b36" };
  const accents: Record<string, string> = { task: "#bad8c6", person: "#d2c6e7", project: "#b4d7d5", meeting: "#e2d3ad", event: "#e2d3ad" };
  const tag = (note.tags || []).find(tag => accents[tag]);
  return tag ? { ...base, stroke: accents[tag] } : base;
}

/** A short random element id (Excalidraw assigns its own internally too). */
export function eid(): string {
  return Math.random().toString(36).substring(2, 15);
}

/** The set of note ids currently embedded as cards on the canvas. */
export function getCanvasNoteIds(elements: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const el of elements) {
    if (!el.isDeleted && el.customData?.prismNoteId && el.type === "rectangle") ids.add(el.customData.prismNoteId);
  }
  return ids;
}

/** Find the rectangle card element for a given note id, if present. */
export function findNoteElement(elements: readonly any[], noteId: string): any | null {
  return elements.find((el: any) => !el.isDeleted && el.type === "rectangle" && el.customData?.prismNoteId === noteId) || null;
}

/**
 * Build the Excalidraw elements for one embedded note card (a rectangle bound to
 * a text label), positioned in a 5-wide grid by `existingCount`. The rectangle
 * carries `customData.prismNoteId/prismNotePath/prismTags`; the bound text is
 * tagged with `prismNoteId` too so deletes/links can find it. Returns the
 * converted elements ready to drop into a scene or a Yjs element map.
 */
export function buildNoteCardElements(opts: {
  note: Note;
  includeBody: boolean;
  isDark: boolean;
  existingCount: number;
}): any[] {
  const { note, includeBody, isDark, existingCount } = opts;
  const label = buildCardLabel(note, includeBody);
  const colors = getCardColor(note, isDark);
  const lineCount = label.split("\n").length;

  const x = 100 + (existingCount % 5) * 250;
  const y = 100 + Math.floor(existingCount / 5) * 180;

  const rectId = eid();
  const cardHeight = Math.max(70, lineCount * 22 + 36);

  const newElements = convertToExcalidrawElements([
    {
      type: "rectangle",
      id: rectId,
      x,
      y,
      width: 240,
      height: cardHeight,
      strokeColor: colors.stroke,
      backgroundColor: colors.bg,
      fillStyle: "solid",
      strokeWidth: 1,
      roughness: 0,
      roundness: { type: 3, value: 8 },
      customData: { prismNoteId: note.id, prismNotePath: note.path, prismTitle: label.split("\n")[0], prismTags: note.tags },
      label: {
        text: label,
        fontSize: 14,
        fontFamily: 2,
        textAlign: "left",
        verticalAlign: "top",
        strokeColor: colors.text,
      },
    } as any,
  ]) as any[];

  // Tag the bound text element with the note id so deletion/link logic can match it.
  for (const el of newElements) {
    if (el.type === "text" && el.containerId === rectId) {
      el.customData = { prismNoteId: note.id };
    }
  }

  return newElements;
}
