import { useCallback, useState, type RefObject } from "react";
import { newElementWith, CaptureUpdateAction } from "@excalidraw/excalidraw";

/** The arrow remains on the drawing when its vault relationship is disabled. */
export function useCanvasConnectionMode(
  apiRef: RefObject<any>,
  editable: boolean,
) {
  const [selected, setSelected] = useState<{
    id: string;
    linked: boolean;
  } | null>(null);
  const observe = useCallback((elements: readonly any[], appState: any) => {
    const byId = new Map(elements.map((e) => [e.id, e]));
    const arrows = elements.filter(
      (e) =>
        e.type === "arrow" &&
        !e.isDeleted &&
        !e.customData?.prismLinkViz &&
        appState?.selectedElementIds?.[e.id] &&
        byId.get(e.startBinding?.elementId)?.customData?.prismNoteId &&
        byId.get(e.endBinding?.elementId)?.customData?.prismNoteId,
    );
    const next =
      arrows.length === 1
        ? {
            id: arrows[0].id,
            linked: arrows[0].customData?.prismRelationship !== false,
          }
        : null;
    setSelected((previous) =>
      previous?.id === next?.id && previous?.linked === next?.linked
        ? previous
        : next,
    );
  }, []);
  const control =
    editable && selected ? (
      <label className="prism-canvas-connection flex min-h-11 items-center gap-2 px-3 text-xs">
        <input
          type="checkbox"
          checked={selected.linked}
          onChange={(e) => {
            const api = apiRef.current;
            if (!api) return;
            const elements = api.getSceneElements();
            api.updateScene({
              elements: elements.map((el: any) =>
                el.id === selected.id
                  ? newElementWith(el, {
                      customData: {
                        ...el.customData,
                        prismRelationship: e.target.checked,
                      },
                    })
                  : el,
              ),
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            });
          }}
        />
        {selected.linked ? "Link this arrow to notes" : "Decorative arrow"}
      </label>
    ) : null;
  return { observe, control };
}
