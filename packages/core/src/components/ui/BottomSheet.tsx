import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import "./mobile-workspace.css";

export interface SheetItem {
  icon?: ReactNode;
  label: string;
  detail?: string;
  onClick: () => void;
  startsGroup?: boolean;
  danger?: boolean;
  active?: boolean;
}

/** A modal mobile action surface. Only the handle can dismiss by dragging;
 * scrolling a long document list never turns into an accidental dismissal. */
export function BottomSheet({
  open,
  onClose,
  title = "Page actions",
  header,
  items,
  children,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  header?: ReactNode;
  items?: SheetItem[];
  children?: ReactNode;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);
  const dragDistance = useRef(0);
  const [viewport, setViewport] = useState<{ height: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    setDragY(0);
    startY.current = null;
    dragDistance.current = 0;
    document.body.style.overflow = "hidden";
    element?.showModal();
    const vv = window.visualViewport;
    const update = () =>
      setViewport(
        vv ? { height: vv.height, bottom: Math.max(0, window.innerHeight - vv.height - vv.offsetTop) } : null,
      );
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      element?.close();
      document.body.style.overflow = overflow;
      const target = returnFocusRef?.current ?? previous;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open, returnFocusRef]);

  if (!open) return null;
  const resetDrag = () => {
    startY.current = null;
    dragDistance.current = 0;
    setDragY(0);
  };
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      tabIndex={-1}
      className="prism-mobile-sheet"
      style={{
        maxHeight: viewport ? `min(82dvh, ${Math.max(120, viewport.height - 16)}px)` : undefined,
        bottom: viewport?.bottom ?? 0,
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.target === event.currentTarget &&
          (event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom)
        )
          onClose();
      }}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("dialog") !== event.currentTarget) return;
        if (event.key === "Escape") event.stopPropagation();
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ),
        ).filter((control) => control.getClientRects().length > 0);
        event.preventDefault();
        if (!controls.length) {
          event.currentTarget.focus();
          return;
        }
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[
          event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length
        ]?.focus();
      }}
    >
      <div
        className="prism-mobile-sheet-panel"
        style={{ transform: dragY ? `translateY(${dragY}px)` : undefined }}
      >
        <div
          className="prism-mobile-sheet-handle"
          aria-hidden="true"
          onTouchStart={(event) => {
            startY.current = event.touches[0].clientY;
            dragDistance.current = 0;
          }}
          onTouchMove={(event) => {
            if (startY.current !== null) {
              dragDistance.current = Math.max(0, event.touches[0].clientY - startY.current);
              setDragY(dragDistance.current);
            }
          }}
          onTouchEnd={() => {
            const dismiss = dragDistance.current > 90;
            resetDrag();
            if (dismiss) onClose();
          }}
          onTouchCancel={resetDrag}
        >
          <span />
        </div>
        <header className="prism-mobile-sheet-heading">
          <h2 id={titleId}>{title || "Page actions"}</h2>
          <button type="button" aria-label="Close sheet" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="prism-mobile-sheet-content">
          {header && <div className="prism-mobile-sheet-context">{header}</div>}
          {items ? (
            <div className="prism-mobile-sheet-actions">
              {items.map((item, index) => (
                <button
                  // Keyed by label (+ occurrence), not position: a row arriving late (lock state
                  // once the page loads) must not remount the rows after it under a finger.
                  key={`${item.label}#${items.slice(0, index).filter((other) => other.label === item.label).length}`}
                  type="button"
                  onClick={item.onClick}
                  className={[
                    item.startsGroup ? "starts-group" : "",
                    item.danger ? "danger" : "",
                    item.active ? "active" : "",
                  ].join(" ")}
                >
                  {item.icon && <span className="prism-mobile-sheet-icon">{item.icon}</span>}
                  <span className="prism-mobile-sheet-label">{item.label}</span>
                  {item.detail && <span className="prism-mobile-sheet-detail">{item.detail}</span>}
                </button>
              ))}
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </dialog>
  );
}
