import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { Excalidraw, convertToExcalidrawElements, reconcileElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./canvas-workspace.css";
import { Link2, Link2Off, PanelLeftOpen, PanelLeftClose, ExternalLink } from "lucide-react";
import { useEffectiveTheme } from "../../app/stores/settings";
import { useUIStore } from "../../app/stores/ui";
import { useVaultClient } from "../../data/VaultClientContext";
import { inferContentType } from "../../lib/schemas/content-types";
import type { AwarenessProvider, CollabUser } from "./CollabEditor";
import type { Note } from "../../lib/types";
import { useCanvasConnectionMode } from "./CanvasConnectionMode";
import { useCanvasRelationSync } from "./useCanvasRelationSync";
import { useCanvasPresentation } from "./CanvasPresentation";
import { useCanvasCardNavigation } from "./CanvasCardList";
import { useCanvasNoteAccess } from "./useCanvasNoteAccess";
import { NoteDrawer } from "./NoteDrawer";
import { getCanvasNoteIds, findNoteElement, buildNoteCardElements, eid } from "./canvas-cards";
import { paintableCanvasElements } from "./canvas-scene";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Real-time collaborative whiteboard — Excalidraw bound to a Yjs
 * `Y.Map<id, element>` ("elements"). Self-hosted Miro: every shape is one map
 * entry, so concurrent edits to different elements merge, and re-seeding is
 * idempotent (set-by-id, no duplication).
 *
 * Beyond freeform drawing it embeds **Parachute notes as cards** (a rectangle
 * carrying `customData.prismNoteId`), restoring the data-connected canvas from
 * the offline `CanvasRenderer`: a note drawer to drop cards, "Open note" for a
 * selected card, and arrow⇄Parachute-link sync. Embedded cards are ordinary
 * Excalidraw elements, so they ride the existing Y.Map and sync to every peer
 * with no protocol change. Vault access goes through the `useVaultClient` seam,
 * so this works identically in the desktop and web shells.
 *
 * Loop safety is two-layered:
 *  1. onChange only writes an element to the map when its Excalidraw `version`
 *     is newer than the stored one (versions are monotonic), so re-applying a
 *     remote scene produces no new writes.
 *  2. local writes use a LOCAL origin; the map observer ignores those and only
 *     repaints for remote transactions.
 *
 * Link-visualization arrows (drawn by "Show links") are a derived overlay: they
 * carry `customData.prismLinkViz` and are deliberately NOT persisted to the map
 * (so the canonical doc stays clean and they never re-create the links they
 * depict). appState (zoom/scroll/selection) is per-viewer and NOT synced.
 */
const LOCAL = Symbol("local-canvas-edit");

export function CollabCanvas({
  ydoc,
  provider,
  user,
  editable = true,
  noteId,
}: {
  ydoc: Y.Doc;
  provider: AwarenessProvider;
  user: CollabUser;
  editable?: boolean;
  noteId?: string;
}) {
  const apiRef = useRef<any>(null);
  const theme = useEffectiveTheme();
  const isDark = theme === "dark";
  const client = useVaultClient();
  const access = useCanvasNoteAccess();
  const relations = useCanvasRelationSync(noteId, editable);
  const connectionMode = useCanvasConnectionMode(apiRef, editable);
  const presentation = useCanvasPresentation();
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const openTab = useUIStore((s) => s.openTab);

  const [showDrawer, setShowDrawer] = useState(false);
  const {updateCards, cardList, browseCards, close: closeCardList} = useCanvasCardNavigation(apiRef, access.read, () => setShowDrawer(false));
  const [showLinks, setShowLinks] = useState(false);
  const [includeBody, setIncludeBody] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  // Per-viewer derived overlay IDs, never used as deletion authority.
  const linkArrowIds = useRef<Set<string>>(new Set()); // ids of derived "Show links" arrows
  // Per-element version we've already reconciled with the CRDT (Excalidraw's collab
  // pattern). Updated both when we APPLY a remote element and when we PERSIST a
  // local one — so a repaint's echo onChange is a no-op instead of re-writing the
  // element with a bumped version, which is what inflated versions and made remote
  // moves/updates get dropped by updateScene's version reconciliation.
  const syncedVersions = useRef<Map<string, number>>(new Map());

  const elementsMap = useCallback(() => ydoc.getMap<any>("elements"), [ydoc]);
  const sceneElements = useCallback(() => Array.from(elementsMap().values()), [elementsMap]);

  useEffect(() => {
    const map = elementsMap();
    const awareness = provider.awareness as any;

    // Merge remote CRDT state into the live scene via Excalidraw's own collab
    // reconciliation (handles version/versionNonce so a remote update wins unless
    // we're actively editing that element). Raw updateScene alone dropped remote
    // moves once per-client version counters drifted. We still guard against the
    // fractional-index drop the old raw path avoided: if reconcile returns fewer
    // elements than the local∪remote id set, fall back to the raw map values.
    //
    // A repaint NEVER throws: it runs from a Yjs observer and from the first-paint
    // timer, where an exception is not caught by any error boundary — it used to
    // leave the canvas blank and the timer retrying every 50 ms until Excalidraw
    // happened to accept the scene ("creating a canvas crashed, then it loaded").
    // Whatever Excalidraw refuses (an API still initialising, an element without a
    // valid fractional index from a remote/IndexedDB merge) is retried with the raw
    // map values, then left for the next change; the CRDT is never touched here.
    const repaint = (): boolean => {
      const api = apiRef.current;
      if (!api) return false;
      const remote = paintableCanvasElements(Array.from(map.values()));
      let local: any[];
      try {
        local = api.getSceneElementsIncludingDeleted() ?? [];
      } catch {
        return false; // the API exists but its scene is not ready yet
      }
      let next: any[];
      try {
        next = reconcileElements(local, remote as any, api.getAppState());
      } catch {
        next = remote;
      }
      const unionIds = new Set<string>([...local.map((e: any) => e.id), ...remote.map((e: any) => e.id)]);
      if (next.length < unionIds.size) next = remote;
      try {
        api.updateScene({ elements: next });
      } catch (first) {
        if (next === remote) {
          console.warn("Canvas: the scene could not be painted yet", first);
          return false;
        }
        try {
          api.updateScene({ elements: remote });
        } catch (second) {
          console.warn("Canvas: the scene could not be painted yet", second);
          return false;
        }
      }
      // Record the versions Excalidraw actually holds now, so the onChange this
      // repaint triggers recognizes these as already-synced and doesn't re-write
      // them (which would inflate versions and break the next remote update).
      try {
        for (const el of api.getSceneElementsIncludingDeleted()) syncedVersions.current.set(el.id, el.version ?? 0);
      } catch {
        /* recorded on the next repaint */
      }
      return true;
    };

    // Remote changes only (skip our own LOCAL-origin writes — already on screen).
    const onMap = (_e: Y.YMapEvent<any>, tr: Y.Transaction) => {
      if (tr.origin === LOCAL) return;
      repaint();
    };
    map.observe(onMap);

    // Live collaborator cursors via awareness.
    const onAwareness = () => {
      const api = apiRef.current;
      if (!api || !awareness) return;
      const collaborators = new Map<string, any>();
      awareness.getStates().forEach((state: any, clientId: number) => {
        if (clientId === awareness.clientID) return;
        const u = state.user;
        if (!u) return;
        collaborators.set(String(clientId), {
          username: u.name,
          color: { background: u.color, stroke: u.color },
          pointer: state.pointer,
          button: state.button ?? "up",
        });
      });
      try {
        api.updateScene({ collaborators });
      } catch {
        /* older API shapes ignore collaborators — non-fatal */
      }
    };
    awareness?.on("change", onAwareness);

    // First paint once both the API and the synced map are ready (covers either
    // ordering of "API mounts" vs "initial sync arrives"). A paint Excalidraw
    // refuses is retried for a while (~5 s), then left to the next map change.
    let paintTries = 0;
    const initialPaint = setInterval(() => {
      if (!apiRef.current) return;
      if (repaint() || ++paintTries >= 100) {
        clearInterval(initialPaint);
        onAwareness();
      }
    }, 50);

    return () => {
      clearInterval(initialPaint);
      map.unobserve(onMap);
      awareness?.off("change", onAwareness);
    };
  }, [elementsMap, provider]);

  // ─── Embed a vault note as a card ───────────────────────────
  const handleAddNoteCard = useCallback(
    async (noteToAdd: Note) => {
      if (!editableRef.current) throw Error("Canvas is read-only");
      const fullNote = await access.read(noteToAdd.id);
      if (!editableRef.current) throw Error("Canvas is read-only");
      const map = elementsMap();
      const elements = Array.from(map.values());
      if (findNoteElement(elements, noteToAdd.id)) return;

      const newElements = buildNoteCardElements({
        note: fullNote,
        includeBody,
        isDark,
        existingCount: getCanvasNoteIds(elements).size,
      });

      // Write to the CRDT so the card syncs + persists; LOCAL so our own observer
      // skips it (we paint it directly below).
      ydoc.transact(() => {
        for (const el of newElements) if (el?.id) map.set(el.id, el);
      }, LOCAL);
      apiRef.current?.updateScene({ elements: paintableCanvasElements(Array.from(map.values())) });
    },
    [elementsMap, ydoc, access.read, includeBody, isDark],
  );

  // ─── Open the selected card's note in a tab ─────────────────
  const handleOpenSelected = useCallback(() => {
    if (!selectedNoteId) return;
    access.read(selectedNoteId).then((n) => {
      const title = (typeof n.metadata?.title === "string" && n.metadata.title) || n.path?.split("/").pop() || "Untitled";
      openTab(n.id, title, inferContentType(n));
    }).catch(() => { /* visible error from access.read */ });
  }, [selectedNoteId, access.read, openTab]);

  // ─── Show / hide arrows for existing Parachute links ────────
  const toggleLinks = useCallback(async () => {
    const map = elementsMap();

    if (showLinks) {
      // Viz arrows are local-only (never in the map), so the map already holds
      // the clean scene — repaint from it to drop them.
      apiRef.current?.updateScene({ elements: paintableCanvasElements(Array.from(map.values())) });
      linkArrowIds.current.clear();
      setShowLinks(false);
      return;
    }

    const elements = Array.from(map.values());
    const noteIds = getCanvasNoteIds(elements);
    if (noteIds.size === 0) {
      setShowLinks(true);
      return;
    }

    const allLinks: Array<{ sourceId: string; targetId: string; relationship: string }> = [];
    for (const nid of noteIds) {
      try {
        const links = await client.getLinks(nid);
        for (const link of links) {
          if (noteIds.has(link.sourceId) && noteIds.has(link.targetId)) {
            if (!allLinks.some((l) => l.sourceId === link.sourceId && l.targetId === link.targetId && l.relationship === link.relationship)) {
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
      // Tag every produced element (arrow + its label) as derived so onChange
      // never persists them and the arrow-sync loop never re-creates links.
      for (const el of converted) {
        (el as any).customData = { ...(el as any).customData, prismLinkViz: true };
        linkArrowIds.current.add((el as any).id);
      }
      apiRef.current?.updateScene({ elements: [...paintableCanvasElements(elements), ...converted] });
    }
    setShowLinks(true);
  }, [showLinks, isDark, client, elementsMap]);

  // ─── Scene change → persist, track selection, sync arrows ───
  const onChange = useCallback(
    (elements: readonly any[], appState?: any) => {
      updateCards(elements);
      connectionMode.observe(elements, appState);
      if (!editable) return;
      const map = elementsMap();

      // 1. Persist authored elements to the CRDT (skip the derived link-viz
      //    overlay so the canonical doc stays clean). Gate on syncedVersions, not
      //    the map's stored version: a repaint echo arrives with the version we
      //    just recorded, so it's skipped, while a genuine local edit bumps the
      //    version past it and writes through. This is what stops the inflation
      //    ping-pong that was dropping remote moves.
      ydoc.transact(() => {
        for (const el of elements) {
          if (!el?.id || el.customData?.prismLinkViz) continue;
          if ((syncedVersions.current.get(el.id) ?? -1) >= (el.version ?? 0)) continue;
          map.set(el.id, el);
          syncedVersions.current.set(el.id, el.version ?? 0);
        }
      }, LOCAL);

      // 2. Track a selected note card for the "Open note" button.
      const selectedIds = appState?.selectedElementIds || {};
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
    },
    [editable, elementsMap, ydoc, updateCards, relations.observe, connectionMode.observe],
  );

  const onPointerUpdate = (payload: any) => {
    const awareness = provider.awareness as any;
    if (!awareness) return;
    awareness.setLocalStateField("user", { name: user.name, color: user.color });
    awareness.setLocalStateField("pointer", payload?.pointer);
    awareness.setLocalStateField("button", payload?.button ?? "up");
  };

  return (
    // touch-action:none lets Excalidraw own pinch-zoom/two-finger-pan on mobile
    // instead of the browser zooming/scrolling the page behind the canvas.
    <div ref={presentation.ref} role={presentation.expanded ? "dialog" : undefined} aria-modal={presentation.expanded || undefined} aria-label={presentation.expanded ? "Focused canvas" : undefined} onKeyDown={presentation.onKeyDown} className="prism-canvas-workspace" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", touchAction: "none", ...presentation.style }}>
      <div
          className="prism-canvas-toolbar"
          style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
        >
          {presentation.expanded && <div className="prism-canvas-heading"><h2>Canvas</h2><p>Map your notes, ideas, and connections.</p></div>}
          <div className="prism-canvas-actions">
          {editable && <>
          <button
            onClick={() => { setShowDrawer((v) => !v); closeCardList(); }}
            className="focus-ring flex min-h-control items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: showDrawer ? "var(--color-accent)" : "var(--text-secondary)" }}
            title="Note drawer"
            aria-expanded={showDrawer}
            data-canvas-primary="true"
          >
            {showDrawer ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
            Add notes
          </button>
          <button
            onClick={toggleLinks}
            className="focus-ring flex min-h-control items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: showLinks ? "var(--color-accent)" : "var(--text-secondary)" }}
            title={showLinks ? "Hide existing links" : "Show existing links"}
            aria-pressed={showLinks}
          >
            {showLinks ? <Link2Off size={13} /> : <Link2 size={13} />}
            {showLinks ? "Hide links" : "Show links"}
          </button>
          <label className="prism-canvas-copy flex min-h-control items-center gap-2 px-3 py-1.5 cursor-pointer" style={{ color: "var(--text-muted)" }}>
            <input type="checkbox" checked={includeBody} onChange={(e) => setIncludeBody(e.target.checked)} className="cursor-pointer" />
            Copy preview
          </label>
          {selectedNoteId && (
            <button
              onClick={handleOpenSelected}
              className="focus-ring flex min-h-control items-center gap-2 px-3 py-1.5 rounded-lg transition-colors"
              style={{ background: "var(--action-bg, var(--color-accent))", color: "var(--action-fg, #fff)" }}
            >
              <ExternalLink size={11} />
              Open note
            </button>
          )}
          </>}
          {connectionMode.control}
          {browseCards}
          {presentation.control}
          {!editable && <span className="prism-canvas-view-only">View only</span>}
          </div>
        </div>

      {relations.status}
      {access.error && <p role="alert" className="px-4 py-2 text-sm">{access.error}</p>}
      <div className="prism-canvas-body relative flex-1 flex min-h-0">
        {cardList}
        {editable && showDrawer && (
          <NoteDrawer onClose={() => setShowDrawer(false)} onAddNote={handleAddNoteCard} canvasNoteIds={getCanvasNoteIds(sceneElements())} />
        )}
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <Excalidraw
            excalidrawAPI={(api: any) => (apiRef.current = api)}
            onChange={onChange as any}
            onPointerUpdate={onPointerUpdate}
            viewModeEnabled={!editable}
            theme={isDark ? "dark" : "light"}
            initialData={{ elements: paintableCanvasElements(sceneElements()), scrollToContent: true }}
          />
        </div>
      </div>
    </div>
  );
}
