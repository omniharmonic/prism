import { useCallback, useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { Link2, Link2Off, PanelLeftOpen, PanelLeftClose, ExternalLink } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";
import { useSettingsStore } from "../../app/stores/settings";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import { useVaultClient } from "../../data/VaultClientContext";
import { useCanvasConnectionMode } from "./CanvasConnectionMode";
import { useCanvasRelationSync } from "./useCanvasRelationSync";
import { useCanvasPresentation } from "./CanvasPresentation";
import { useCanvasCardNavigation } from "./CanvasCardList";
import { useCanvasNoteAccess } from "./useCanvasNoteAccess";
import { authoredCanvasElements } from "./canvas-scene";
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
    return { elements: authoredCanvasElements(data.elements || []), appState: data.appState, files: data.files };
  } catch {
    return { elements: [] };
  }
}

// ─── Main Component ──────────────────────────────────────────

export default function CanvasRenderer({ note, readOnly }: RendererProps) {
  const client = useVaultClient();
  const access = useCanvasNoteAccess();
  const presentation = useCanvasPresentation();
  const editableRef = useRef(!readOnly);
  editableRef.current = !readOnly;
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme === "dark";
  const contentRef = useRef(note.content || "");
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const [showDrawer, setShowDrawer] = useState(false);
  const {updateCards, cardList, browseCards, close: closeCardList} = useCanvasCardNavigation(apiRef, access.read, () => setShowDrawer(false));
  const [showLinks, setShowLinks] = useState(false);
  const [includeBody, setIncludeBody] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const linkArrowIds = useRef<Set<string>>(new Set());
  const openTab = useUIStore((s) => s.openTab);
  const relations = useCanvasRelationSync(note.id, !readOnly);
  const connectionMode = useCanvasConnectionMode(apiRef, !readOnly);

  const getContent = useCallback(() => contentRef.current, []);
  const { isSaving, lastSaved, saveError, saveNow, scheduleSave } = useAutoSave(note.id, getContent);
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  const initialData = parseCanvasData(note.content);

  const handleChange = useCallback((elements: readonly any[], appState: any, files: any) => {
    // Read-only surfaces (published Wiki / anonymous): never serialize, save, or
    // sync links. Excalidraw still fires onChange for pan/zoom in view mode.
    updateCards(elements);
    connectionMode.observe(elements, appState);
    if (readOnly) return;
    // Serialize canvas state
    const serialized = JSON.stringify({
      elements: authoredCanvasElements(elements),
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

    relations.observe(elements);
  }, [readOnly, updateCards, relations.observe, connectionMode.observe]);

  // ─── Add note card ──────────────────────────────────────

  const handleAddNoteCard = useCallback(async (noteToAdd: Note) => {
    const api = apiRef.current;
    if (!api) return;

    if (!editableRef.current) throw Error("Canvas is read-only");
    const fullNote = await access.read(noteToAdd.id);
    if (!editableRef.current) throw Error("Canvas is read-only");
    // Re-read the scene after the request: concurrent card additions must survive.
    const elements = api.getSceneElements();
    if (findNoteElement(elements, noteToAdd.id)) return;

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
  }, [isDark, includeBody, access.read]);

  // ─── Open selected note in tab ──────────────────────────

  const handleOpenSelected = useCallback(() => {
    if (!selectedNoteId) return;
    const api = apiRef.current;
    if (!api) return;
    access.read(selectedNoteId).then((n) => {
      const title = (typeof n.metadata?.title === "string" && n.metadata.title) || n.path?.split("/").pop() || "Untitled";
      openTab(n.id, title, inferContentType(n));
    }).catch(() => { /* visible error from access.read */ });
  }, [selectedNoteId, openTab, access.read]);

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
        const links = await client.getLinks(nid);
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
      rawElements.push(arrowDef);
    }

    if (rawElements.length > 0) {
      const converted = convertToExcalidrawElements(rawElements);
      for (const el of converted) {
        (el as any).customData = { ...(el as any).customData, prismLinkViz: true };
        linkArrowIds.current.add((el as any).id);
      }
      api.updateScene({ elements: [...elements, ...converted], commitToHistory: true } as any);
    }
    setShowLinks(true);
  }, [showLinks, isDark, client]);

  return (
    <div ref={presentation.ref} role={presentation.expanded ? "dialog" : undefined} aria-modal={presentation.expanded || undefined} aria-label={presentation.expanded ? "Focused canvas" : undefined} onKeyDown={presentation.onKeyDown} className="flex flex-col h-full" style={presentation.style}>
      {/* Toolbar */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span style={{ color: "var(--text-secondary)" }}>
            {note.path?.split("/").pop() || "Canvas"}
          </span>
          {!readOnly && <>
          <div style={{ width: 1, height: 16, background: "var(--glass-border)" }} />
          <button
            onClick={() => { setShowDrawer(!showDrawer);closeCardList(); }}
            className="focus-ring flex min-h-11 items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: showDrawer ? "var(--color-accent)" : "var(--text-secondary)" }}
            title="Note drawer"
          >
            {showDrawer ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
            Notes
          </button>
          <button
            onClick={toggleLinks}
            className="focus-ring flex min-h-11 items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: showLinks ? "var(--color-accent)" : "var(--text-secondary)" }}
            title={showLinks ? "Hide existing links" : "Show existing links"}
          >
            {showLinks ? <Link2Off size={13} /> : <Link2 size={13} />}
            {showLinks ? "Hide links" : "Show links"}
          </button>
          <label className="flex min-h-11 items-center gap-2 px-3 py-2 cursor-pointer" style={{ color: "var(--text-muted)" }}>
            <input
              type="checkbox"
              checked={includeBody}
              onChange={(e) => setIncludeBody(e.target.checked)}
              className="cursor-pointer"
            />
            Copy preview
          </label>
          {/* Open selected note */}
          {selectedNoteId && (
            <button
              onClick={handleOpenSelected}
              className="focus-ring flex min-h-11 items-center gap-2 px-3 py-2 rounded-lg transition-colors"
              style={{ background: "var(--color-accent)", color: "white" }}
            >
              <ExternalLink size={11} />
              Open note
            </button>
          )}
          </>}
          {connectionMode.control}
          {browseCards}
          {presentation.control}
        </div>
        <span style={{ color: "var(--text-muted)" }}>
          {isSaving ? "Saving..." : lastSaved ? `Saved ${lastSaved.toLocaleTimeString()}` : ""}
        </span>
      </div>

      {saveError && <p role="alert" className="px-3 py-2 text-xs">{saveError} <button type="button" className="focus-ring min-h-11 rounded-lg border border-[var(--glass-border)] px-3" onClick={saveNow}>Retry canvas save</button></p>}
      {relations.status}
      {access.error && <p role="alert" className="px-4 py-2 text-sm">{access.error}</p>}
      <div className="relative flex-1 flex min-h-0">
        {cardList}
        {showDrawer && (
          <NoteDrawer onClose={() => setShowDrawer(false)} onAddNote={handleAddNoteCard} canvasNoteIds={getCanvasNoteIds(apiRef.current?.getSceneElements() || [])} />
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
