import { useCallback, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { Link2, Link2Off, PanelLeftOpen, PanelLeftClose, ExternalLink } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";
import { useSettingsStore } from "../../app/stores/settings";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { vaultApi } from "../../lib/parachute/client";
import { useQueryClient } from "@tanstack/react-query";
import type { Note } from "../../lib/types";
import { NoteDrawer } from "./NoteDrawer";
import { getCanvasNoteIds, findNoteElement, buildNoteCardElements, eid } from "./canvas-cards";

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

// ─── Main Component ──────────────────────────────────────────

export default function CanvasRenderer({ note, readOnly }: RendererProps) {
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
    // Read-only surfaces (published Wiki / anonymous): never serialize, save, or
    // sync links. Excalidraw still fires onChange for pan/zoom in view mode.
    if (readOnly) return;
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
  }, [readOnly]);

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

    const newElements = buildNoteCardElements({
      note: fullNote,
      includeBody,
      isDark,
      existingCount: getCanvasNoteIds(elements).size,
    });

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

      if (link.relationship !== "related") {
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
        relationship: link.relationship,
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
          {!readOnly && <>
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
          </>}
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
            viewModeEnabled={readOnly}
          />
        </div>
      </div>
    </div>
  );
}
