import { useEffect, useRef } from "react";
import * as Y from "yjs";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useSettingsStore } from "../../app/stores/settings";
import type { AwarenessProvider, CollabUser } from "./CollabEditor";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Real-time collaborative whiteboard — Excalidraw bound to a Yjs
 * `Y.Map<id, element>` ("elements"). Self-hosted Miro: every shape is one map
 * entry, so concurrent edits to different elements merge, and re-seeding is
 * idempotent (set-by-id, no duplication).
 *
 * Loop safety is two-layered:
 *  1. onChange only writes an element to the map when its Excalidraw `version`
 *     is newer than the stored one (versions are monotonic), so re-applying a
 *     remote scene produces no new writes.
 *  2. local writes use a LOCAL origin; the map observer ignores those and only
 *     repaints for remote transactions.
 *
 * appState (zoom/scroll/selection) is per-viewer and intentionally NOT synced;
 * only elements + live pointers are shared. Persisted as the scene JSON the
 * non-collab CanvasRenderer reads.
 */
const LOCAL = Symbol("local-canvas-edit");

export function CollabCanvas({
  ydoc,
  provider,
  user,
  editable = true,
}: {
  ydoc: Y.Doc;
  provider: AwarenessProvider;
  user: CollabUser;
  editable?: boolean;
}) {
  const apiRef = useRef<any>(null);
  const theme = useSettingsStore((s) => s.theme);

  useEffect(() => {
    const map = ydoc.getMap<any>("elements");
    const awareness = provider.awareness as any;

    // Paint the raw map values. We deliberately do NOT run Excalidraw's
    // restoreElements here: it silently DROPS valid elements when reconciling
    // fractional indices across a multi-element set. Excalidraw-authored elements
    // (every real canvas note) already carry the runtime props updateScene needs,
    // so raw values render correctly and completely.
    const sceneElements = () => Array.from(map.values());

    // Paint the current map into Excalidraw (remote → local).
    const repaint = () => {
      const api = apiRef.current;
      if (!api) return;
      api.updateScene({ elements: sceneElements() });
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
    // ordering of "API mounts" vs "initial sync arrives").
    const initialPaint = setInterval(() => {
      if (apiRef.current) {
        repaint();
        onAwareness();
        clearInterval(initialPaint);
      }
    }, 50);

    return () => {
      clearInterval(initialPaint);
      map.unobserve(onMap);
      awareness?.off("change", onAwareness);
    };
  }, [ydoc, provider]);

  const onChange = (elements: readonly any[]) => {
    if (!editable) return;
    const map = ydoc.getMap<any>("elements");
    ydoc.transact(() => {
      for (const el of elements) {
        if (!el?.id) continue;
        const cur = map.get(el.id);
        // Version-gate: only push genuinely newer elements (prevents echo loops).
        if (!cur || (cur.version ?? 0) < (el.version ?? 0)) {
          map.set(el.id, el);
        }
      }
    }, LOCAL);
  };

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
    <div style={{ position: "absolute", inset: 0, touchAction: "none" }}>
      <Excalidraw
        excalidrawAPI={(api: any) => (apiRef.current = api)}
        onChange={onChange}
        onPointerUpdate={onPointerUpdate}
        viewModeEnabled={!editable}
        theme={theme === "dark" ? "dark" : "light"}
        initialData={{ elements: Array.from(ydoc.getMap<any>("elements").values()), scrollToContent: true }}
      />
    </div>
  );
}
