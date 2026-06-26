import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Mobile bottom sheet — a thumb-reachable action surface that slides up from the
 * bottom edge, matching the floating-glass aesthetic. Dismisses on backdrop tap,
 * Escape, or a downward swipe past a threshold. Honors iOS safe-area insets so
 * its last row clears the home indicator.
 *
 * Compose freely (custom children) or pass `items` for the canonical
 * icon + label action list with hairline-divided groups (Obsidian-style).
 */
export interface SheetItem {
  icon?: ReactNode;
  label: string;
  detail?: string;
  onClick: () => void;
  /** Visually separate this item from the previous one with a hairline divider. */
  startsGroup?: boolean;
  danger?: boolean;
  active?: boolean;
}

export function BottomSheet({
  open,
  onClose,
  title,
  header,
  items,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Optional control region rendered between the title and the rows. */
  header?: ReactNode;
  items?: SheetItem[];
  children?: ReactNode;
}) {
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset any in-progress drag when the sheet re-opens.
  useEffect(() => {
    if (open) setDragY(0);
  }, [open]);

  if (!open) return null;

  const onTouchStart = (e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startY.current === null) return;
    const dy = e.touches[0].clientY - startY.current;
    setDragY(Math.max(0, dy));
  };
  const onTouchEnd = () => {
    if (dragY > 90) onClose();
    else setDragY(0);
    startY.current = null;
  };

  return (
    <div
      className="fixed inset-0 flex flex-col justify-end"
      style={{ zIndex: "var(--z-modal)" as unknown as number }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="sheet-backdrop absolute inset-0"
        style={{ background: "rgba(0,0,0,0.45)" }}
        onClick={onClose}
      />
      <div
        className="sheet-panel glass-elevated relative"
        style={{
          // A floating rounded card, inset from every edge — reads as lifted
          // glass over the content rather than a slab welded to the screen.
          margin: "0 8px",
          marginBottom: "calc(env(safe-area-inset-bottom) + 8px)",
          borderRadius: "var(--radius-lg)",
          paddingBottom: 8,
          maxHeight: "82dvh",
          overflowY: "auto",
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: startY.current === null ? "transform var(--transition-base) ease-out" : "none",
        }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Grabber */}
        <div className="flex justify-center pt-2.5 pb-1.5" style={{ cursor: "grab" }}>
          <div
            style={{
              width: 36,
              height: 4,
              borderRadius: 999,
              background: "var(--glass-border-strong)",
            }}
          />
        </div>

        {title && (
          <div
            className="px-5 pt-1 pb-2 text-xs font-semibold uppercase tracking-wide truncate"
            style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
          >
            {title}
          </div>
        )}

        {header && (
          <div className="px-5 pb-2.5 pt-0.5" style={{ borderBottom: "1px solid var(--glass-border)", marginBottom: 4 }}>
            {header}
          </div>
        )}

        {items ? (
          <div className="pb-1">
            {items.map((item, i) => (
              <button
                key={`${item.label}-${i}`}
                onClick={() => {
                  item.onClick();
                }}
                className="interactive w-full flex items-center gap-3.5 px-5 text-left"
                style={{
                  minHeight: 50,
                  color: item.danger ? "var(--color-danger)" : "var(--text-primary)",
                  borderTop: item.startsGroup
                    ? "1px solid var(--glass-border)"
                    : undefined,
                  marginTop: item.startsGroup ? 4 : 0,
                  paddingTop: item.startsGroup ? 4 : 0,
                  fontWeight: 460,
                  fontSize: "0.95rem",
                  background: item.active ? "var(--surface-selected)" : undefined,
                }}
              >
                {item.icon && (
                  <span
                    className="flex items-center justify-center flex-shrink-0"
                    style={{
                      width: 22,
                      color: item.danger
                        ? "var(--color-danger)"
                        : item.active
                          ? "var(--color-accent)"
                          : "var(--text-secondary)",
                    }}
                  >
                    {item.icon}
                  </span>
                )}
                <span className="flex-1 min-w-0 truncate">{item.label}</span>
                {item.detail && (
                  <span className="text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>
                    {item.detail}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
