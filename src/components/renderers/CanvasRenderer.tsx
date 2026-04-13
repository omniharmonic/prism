import { useCallback, useRef, useState, useMemo } from "react";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { Link2, Link2Off, PanelLeftOpen, PanelLeftClose, Filter, X, ExternalLink } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";
import { useSettingsStore } from "../../app/stores/settings";
import { useNotes, useTags } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { vaultApi } from "../../lib/parachute/client";
import { useQueryClient } from "@tanstack/react-query";
import type { Note } from "../../lib/types";

type ExcalidrawAPI = {
  getSceneElements: () => readonly any[];
  updateScene: (scene: { elements: readonly any[] }) => void;
  scrollToContent: (elements?: readonly any[]) => void;
  getAppState: () => any;
};

// ─── Helpers ─────────────────────────────────────────────────

function parseCanvasData(content: string): { elements: readonly any[]; appState?: Record<string, any>; files?: Record<string, any> } {
  if (!content || content.trim() === "" || content.trim() === " ") return { elements: [] };
  try {
    const data = JSON.parse(content);
    return { elements: data.elements || [], appState: data.appState, files: data.files };
  } catch {
    return { elements: [] };
  }
}

/** Build a rich label for a note card */
function buildCardLabel(note: Note, includeBody: boolean): string {
  const meta = (note.metadata || {}) as Record<string, any>;
  const title = note.path?.split("/").pop() || "Untitled";
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
      channels.push(...Object.keys(meta.channels).filter(k => meta.channels[k]));
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

function getCardColor(note: Note, isDark: boolean): { bg: string; stroke: string; text: string } {
  const tags = note.tags || [];
  const base = isDark
    ? { bg: "#2a2a3e", stroke: "#4a4a6a", text: "#e0e0e0" }
    : { bg: "#f0f0ff", stroke: "#b0b0d0", text: "#1e1e1e" };
  if (tags.includes("task")) return isDark ? { bg: "#2a3e2a", stroke: "#4a6a4a", text: "#c0e0c0" } : { bg: "#eef7ee", stroke: "#a0c0a0", text: "#1e1e1e" };
  if (tags.includes("person")) return isDark ? { bg: "#3e2a3e", stroke: "#6a4a6a", text: "#e0c0e0" } : { bg: "#f7eef7", stroke: "#c0a0c0", text: "#1e1e1e" };
  if (tags.includes("project")) return isDark ? { bg: "#2a3e3e", stroke: "#4a6a6a", text: "#c0e0e0" } : { bg: "#eef7f7", stroke: "#a0c0c0", text: "#1e1e1e" };
  if (tags.includes("meeting") || tags.includes("event")) return isDark ? { bg: "#3e3e2a", stroke: "#6a6a4a", text: "#e0e0c0" } : { bg: "#f7f7ee", stroke: "#c0c0a0", text: "#1e1e1e" };
  return base;
}

function eid(): string {
  return Math.random().toString(36).substring(2, 15);
}

function getCanvasNoteIds(elements: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el.customData?.prismNoteId && el.type === "rectangle") ids.add(el.customData.prismNoteId);
  }
  return ids;
}

function findNoteElement(elements: readonly any[], noteId: string): any | null {
  return elements.find((el: any) => el.type === "rectangle" && el.customData?.prismNoteId === noteId) || null;
}

// ─── Main Component ──────────────────────────────────────────

export default function CanvasRenderer({ note }: RendererProps) {
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme === "dark";
  const contentRef = useRef(note.content || "");
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [includeBody, setIncludeBody] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const linkArrowIds = useRef<Set<string>>(new Set());
  const openTab = useUIStore((s) => s.openTab);
  const queryClient = useQueryClient();

  const getContent = useCallback(() => contentRef.current, []);
  const { isSaving, lastSaved, scheduleSave } = useAutoSave(note.id, getContent);
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  const initialData = parseCanvasData(note.content);

  // ─── Arrow → Link sync (scan-based, not diff-based) ────

  // Track which arrow IDs have been synced to Parachute
  const syncedArrows = useRef<Map<string, { sourceId: string; targetId: string; relationship: string }>>(new Map());

  const handleChange = useCallback((elements: readonly any[], appState: any, files: any) => {
    // Serialize canvas state
    const serialized = JSON.stringify({
      elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize,
        gridStep: appState.gridStep,
        zoom: appState.zoom,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
      },
      files,
    });
    contentRef.current = serialized;
    scheduleSaveRef.current();

    // ── Detect selected note card for "Open" button ──
    const selectedIds = appState.selectedElementIds || {};
    let foundNoteId: string | null = null;
    for (const elId of Object.keys(selectedIds)) {
      if (!selectedIds[elId]) continue;
      const el = elements.find((e: any) => e.id === elId);
      if (el?.customData?.prismNoteId && el.type === "rectangle") {
        foundNoteId = el.customData.prismNoteId;
        break;
      }
    }
    setSelectedNoteId(foundNoteId);

    // ── Scan ALL arrows for link sync ──
    for (const el of elements) {
      if (el.type !== "arrow" || el.isDeleted) continue;
      if (linkArrowIds.current.has(el.id)) continue;

      const startBound = el.startBinding?.elementId;
      const endBound = el.endBinding?.elementId;
      if (!startBound || !endBound) continue;

      const startEl = elements.find((e: any) => e.id === startBound);
      const endEl = elements.find((e: any) => e.id === endBound);

      if (!startEl?.customData?.prismNoteId || !endEl?.customData?.prismNoteId) {
        continue;
      }

      const sourceId = startEl.customData.prismNoteId;
      const targetId = endEl.customData.prismNoteId;
      if (sourceId === targetId) {
        continue;
      }

      const labelEl = elements.find((e: any) => e.type === "text" && e.containerId === el.id);
      const relationship = labelEl?.text?.trim() || "related";

      const existing = syncedArrows.current.get(el.id);
      if (existing && existing.sourceId === sourceId && existing.targetId === targetId && existing.relationship === relationship) {
        continue;
      }

      // If relationship changed, delete old link first
      if (existing) {
        vaultApi.deleteLink(existing.sourceId, existing.targetId, existing.relationship).catch(() => {});
      }

      // Create the Parachute link
      vaultApi.createLink(sourceId, targetId, relationship).then(() => {
        queryClient.invalidateQueries({ queryKey: ["vault", "links"] });
      }).catch((err) => {
        console.error("Failed to create link:", err);
      });
      syncedArrows.current.set(el.id, { sourceId, targetId, relationship });
    }

    // Check for deleted arrows that had links
    for (const [arrowId, link] of syncedArrows.current) {
      const el = elements.find((e: any) => e.id === arrowId);
      if (!el || el.isDeleted) {
        vaultApi.deleteLink(link.sourceId, link.targetId, link.relationship).catch(() => {});
        syncedArrows.current.delete(arrowId);
      }
    }
  }, []);

  // ─── Add note card ──────────────────────────────────────

  const handleAddNoteCard = useCallback(async (noteToAdd: Note) => {
    const api = apiRef.current;
    if (!api) return;

    const elements = api.getSceneElements();
    if (findNoteElement(elements, noteToAdd.id)) return;

    // Fetch full note content if preview mode is on
    let fullNote = noteToAdd;
    if (includeBody) {
      try {
        fullNote = await vaultApi.getNote(noteToAdd.id);
      } catch (e) {
        console.error("Preview fetch failed:", e);
        fullNote = noteToAdd;
      }
    }

    const label = buildCardLabel(fullNote, includeBody);
    const colors = getCardColor(fullNote, isDark);
    const lineCount = label.split("\n").length;

    const x = 100 + (getCanvasNoteIds(elements).size % 5) * 250;
    const y = 100 + Math.floor(getCanvasNoteIds(elements).size / 5) * 180;

    const rectId = eid();
    const cardHeight = Math.max(70, lineCount * 18 + 30);

    const newElements = convertToExcalidrawElements([
      {
        type: "rectangle",
        id: rectId,
        x, y,
        width: 240,
        height: cardHeight,
        strokeColor: colors.stroke,
        backgroundColor: colors.bg,
        fillStyle: "solid",
        strokeWidth: 1,
        roundness: { type: 3, value: 8 },
        customData: { prismNoteId: fullNote.id, prismNotePath: fullNote.path, prismTags: fullNote.tags },
        label: {
          text: label,
          fontSize: 12,
          fontFamily: 1,
          textAlign: "left",
          verticalAlign: "top",
          strokeColor: colors.text,
        },
      } as any,
    ]);

    // Tag text elements with note ID
    for (const el of newElements) {
      if ((el as any).type === "text" && (el as any).containerId === rectId) {
        (el as any).customData = { prismNoteId: fullNote.id };
      }
    }

    api.updateScene({
      elements: [...elements, ...newElements],
      commitToHistory: true,
    } as any);
  }, [isDark, includeBody]);

  // ─── Open selected note in tab ──────────────────────────

  const handleOpenSelected = useCallback(() => {
    if (!selectedNoteId) return;
    const api = apiRef.current;
    if (!api) return;
    const el = findNoteElement(api.getSceneElements(), selectedNoteId);
    const path = el?.customData?.prismNotePath || "";
    const title = path.split("/").pop() || "Untitled";
    // Fetch full note to infer type
    vaultApi.getNote(selectedNoteId).then((n) => {
      const type = inferContentType(n);
      openTab(selectedNoteId, title, type);
    }).catch(() => {
      openTab(selectedNoteId, title, "document");
    });
  }, [selectedNoteId, openTab]);

  // ─── Toggle existing links ─────────────────────────────

  const toggleLinks = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;

    if (showLinks) {
      const elements = api.getSceneElements();
      const filtered = elements.filter((e: any) => !linkArrowIds.current.has(e.id));
      api.updateScene({ elements: filtered });
      linkArrowIds.current.clear();
      setShowLinks(false);
      return;
    }

    const elements = api.getSceneElements();
    const noteIds = getCanvasNoteIds(elements);
    if (noteIds.size === 0) { setShowLinks(true); return; }

    const allLinks: Array<{ sourceId: string; targetId: string; relationship: string }> = [];
    for (const nid of noteIds) {
      try {
        const links = await vaultApi.getLinks(nid);
        for (const link of links) {
          if (noteIds.has(link.sourceId) && noteIds.has(link.targetId)) {
            if (!allLinks.some(l => l.sourceId === link.sourceId && l.targetId === link.targetId && l.relationship === link.relationship)) {
              allLinks.push({ sourceId: link.sourceId, targetId: link.targetId, relationship: link.relationship });
            }
          }
        }
      } catch (e) {
        console.error("Failed to fetch links for", nid, e);
      }
    }

    const rawElements: any[] = [];
    for (const link of allLinks) {
      const sourceEl = findNoteElement(elements, link.sourceId);
      const targetEl = findNoteElement(elements, link.targetId);
      if (!sourceEl || !targetEl) continue;

      const arrowId = eid();
      const arrowDef: any = {
        type: "arrow",
        id: arrowId,
        x: sourceEl.x + sourceEl.width,
        y: sourceEl.y + sourceEl.height / 2,
        strokeColor: isDark ? "#6a6aaa" : "#8080c0",
        strokeWidth: 1.5,
        startArrowhead: null,
        endArrowhead: "arrow",
        start: { id: sourceEl.id },
        end: { id: targetEl.id },
        customData: { prismLinkViz: true },
      };

      if (link.relationship && link.relationship !== "related") {
        arrowDef.label = {
          text: link.relationship,
          fontSize: 11,
          fontFamily: 1,
          strokeColor: isDark ? "#8888cc" : "#6060a0",
        };
      }

      linkArrowIds.current.add(arrowId);
      // Also track in syncedArrows so deletion is detected
      syncedArrows.current.set(arrowId, {
        sourceId: link.sourceId,
        targetId: link.targetId,
        relationship: link.relationship || "related",
      });
      rawElements.push(arrowDef);
    }

    if (rawElements.length > 0) {
      const converted = convertToExcalidrawElements(rawElements);
      for (const el of converted) linkArrowIds.current.add((el as any).id);
      api.updateScene({ elements: [...elements, ...converted], commitToHistory: true } as any);
    }
    setShowLinks(true);
  }, [showLinks, isDark]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-3 py-1 text-xs flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center gap-1.5">
          <span style={{ color: "var(--text-secondary)" }}>
            {note.path?.split("/").pop() || "Canvas"}
          </span>
          <div style={{ width: 1, height: 16, background: "var(--glass-border)" }} />
          <button
            onClick={() => setShowDrawer(!showDrawer)}
            className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: showDrawer ? "var(--color-accent)" : "var(--text-secondary)" }}
            title="Note drawer"
          >
            {showDrawer ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
            Notes
          </button>
          <button
            onClick={toggleLinks}
            className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: showLinks ? "var(--color-accent)" : "var(--text-secondary)" }}
            title={showLinks ? "Hide existing links" : "Show existing links"}
          >
            {showLinks ? <Link2Off size={13} /> : <Link2 size={13} />}
            {showLinks ? "Hide links" : "Show links"}
          </button>
          <label className="flex items-center gap-1 px-2 py-1 cursor-pointer" style={{ color: "var(--text-muted)" }}>
            <input
              type="checkbox"
              checked={includeBody}
              onChange={(e) => setIncludeBody(e.target.checked)}
              className="cursor-pointer"
            />
            Preview
          </label>
          {/* Open selected note */}
          {selectedNoteId && (
            <button
              onClick={handleOpenSelected}
              className="flex items-center gap-1 px-2 py-1 rounded-md transition-colors"
              style={{ background: "var(--color-accent)", color: "white" }}
            >
              <ExternalLink size={11} />
              Open note
            </button>
          )}
        </div>
        <span style={{ color: "var(--text-muted)" }}>
          {isSaving ? "Saving..." : lastSaved ? `Saved ${lastSaved.toLocaleTimeString()}` : ""}
        </span>
      </div>

      <div className="flex-1 flex min-h-0">
        {showDrawer && (
          <NoteDrawer onAddNote={handleAddNoteCard} canvasNoteIds={getCanvasNoteIds(apiRef.current?.getSceneElements() || [])} />
        )}
        <div className="flex-1 min-h-0 relative" style={{ width: "100%", height: "100%", overflow: "hidden" }}>
          <Excalidraw
            excalidrawAPI={(api) => { apiRef.current = api; }}
            initialData={{
              elements: initialData.elements as any,
              appState: { ...initialData.appState, theme: isDark ? "dark" : "light" } as any,
              files: initialData.files,
            }}
            onChange={handleChange as any}
            theme={isDark ? "dark" : "light"}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Note Drawer ─────────────────────────────────────────────

function NoteDrawer({
  onAddNote,
  canvasNoteIds,
}: {
  onAddNote: (note: Note) => void;
  canvasNoteIds: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { data: allNotes } = useNotes();
  const { data: allTags } = useTags();
  const openTab = useUIStore((s) => s.openTab);

  const filtered = useMemo(() => {
    let notes = allNotes || [];
    if (selectedTag) notes = notes.filter((n) => n.tags?.includes(selectedTag));
    if (query) {
      const q = query.toLowerCase();
      notes = notes.filter((n) => (n.path?.split("/").pop()?.toLowerCase() || "").includes(q));
    }
    return notes.slice(0, 50);
  }, [allNotes, selectedTag, query]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const addSelected = () => {
    for (const n of filtered) {
      if (selectedIds.has(n.id)) onAddNote(n);
    }
    setSelectedIds(new Set());
  };

  return (
    <div className="flex flex-col h-full" style={{ width: 260, borderRight: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}>
      <div className="p-2 space-y-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes..."
          className="w-full h-7 rounded-md px-2 text-xs outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
        />
        <div className="flex items-center gap-1 flex-wrap">
          <Filter size={11} style={{ color: "var(--text-muted)" }} />
          {selectedTag ? (
            <button onClick={() => setSelectedTag(null)} className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px]" style={{ background: "var(--color-accent)", color: "white" }}>
              {selectedTag} <X size={9} />
            </button>
          ) : (
            <select value="" onChange={(e) => setSelectedTag(e.target.value || null)} className="h-5 rounded px-1 text-[10px] outline-none cursor-pointer" style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-secondary)" }}>
              <option value="">All tags</option>
              {(allTags || []).map((t) => (
                <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="px-2 pb-1">
          <button onClick={addSelected} className="w-full py-1 rounded-md text-xs font-medium" style={{ background: "var(--color-accent)", color: "white" }}>
            Add {selectedIds.size} to canvas
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto px-1">
        {filtered.map((n) => {
          const onCanvas = canvasNoteIds.has(n.id);
          const isSelected = selectedIds.has(n.id);
          const tags = n.tags || [];
          const title = n.path?.split("/").pop() || "Untitled";

          return (
            <div key={n.id} className="flex items-start gap-1.5 px-2 py-1.5 rounded-md transition-colors hover:bg-[var(--glass-hover)]" style={{ opacity: onCanvas ? 0.5 : 1 }}>
              <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(n.id)} disabled={onCanvas} className="mt-0.5 cursor-pointer" />
              <button
                onClick={() => onAddNote(n)}
                onDoubleClick={() => openTab(n.id, title, inferContentType(n))}
                disabled={onCanvas}
                className="flex-1 text-left min-w-0"
              >
                <div className="text-xs truncate" style={{ color: "var(--text-primary)" }}>{title}</div>
                {tags.length > 0 && (
                  <div className="flex gap-1 mt-0.5 flex-wrap">
                    {tags.slice(0, 3).map((t) => (
                      <span key={t} className="text-[9px] px-1 rounded" style={{ background: "var(--glass)", color: "var(--text-muted)" }}>{t}</span>
                    ))}
                  </div>
                )}
              </button>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="text-xs py-4 text-center" style={{ color: "var(--text-muted)" }}>No notes found</div>}
      </div>
    </div>
  );
}
