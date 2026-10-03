import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * A small accessible menu for editor surfaces (block menu, Turn into, colour).
 * role=menu + roving focus: ↑/↓/Home/End move, Enter/Space activate, → opens a
 * submenu, ← / Escape go back or close. Focus returns to `returnFocus` on close.
 */
export interface EditorMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Opens a submenu instead of running. */
  submenu?: boolean;
  /** A visual group heading rendered before this item. */
  section?: string;
  onSelect: () => void;
}

export function EditorMenu({
  label,
  items,
  onClose,
  onBack,
  style,
  className,
  autoFocus = true,
}: {
  label: string;
  items: EditorMenuItem[];
  onClose: () => void;
  /** Present on a submenu: ← and the Back row return to the parent. */
  onBack?: () => void;
  style?: React.CSSProperties;
  className?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const focusables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);

  useLayoutEffect(() => {
    if (autoFocus) focusables()[0]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // Close on outside pointer down.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node) && !(event.target as HTMLElement)?.closest?.("[data-editor-menu-anchor]")) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const list = focusables();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { event.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    switch (event.key) {
      case "ArrowDown": go(at + 1); break;
      case "ArrowUp": go(at - 1); break;
      case "Home": go(0); break;
      case "End": go(list.length - 1); break;
      case "ArrowRight": {
        const item = items.find((it) => it.id === (document.activeElement as HTMLElement)?.dataset.itemId);
        if (item?.submenu) { event.preventDefault(); item.onSelect(); }
        break;
      }
      case "ArrowLeft":
        if (onBack) { event.preventDefault(); onBack(); }
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        if (onBack) onBack(); else onClose();
        break;
      case "Tab":
        event.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div ref={ref} role="menu" aria-label={label} className={`editor-menu ${className ?? ""}`} style={style} onKeyDown={onKeyDown}
      onMouseDown={(event) => event.preventDefault() /* keep the editor selection */}>
      {onBack && (
        <button type="button" role="menuitem" tabIndex={-1} className="editor-menu-item editor-menu-back" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden="true" /> <span>{label}</span>
        </button>
      )}
      {items.map((it) => {
        const role = it.checked === undefined ? "menuitem" : "menuitemradio";
        return (
          <div key={it.id} className="contents">
            {it.section && <div className="editor-menu-section" role="presentation">{it.section}</div>}
            <button
              type="button"
              role={role}
              tabIndex={-1}
              data-item-id={it.id}
              aria-checked={it.checked === undefined ? undefined : it.checked}
              aria-haspopup={it.submenu ? "menu" : undefined}
              aria-disabled={it.disabled || undefined}
              className={`editor-menu-item${it.danger ? " is-danger" : ""}`}
              onClick={() => { if (!it.disabled) it.onSelect(); }}
              onMouseEnter={(event) => (event.currentTarget as HTMLElement).focus({ preventScroll: true })}
            >
              {it.icon && <span className="editor-menu-icon" aria-hidden="true">{it.icon}</span>}
              <span className="editor-menu-label">{it.label}</span>
              {it.hint && <kbd className="editor-menu-hint">{it.hint}</kbd>}
              {it.checked && <Check size={14} aria-hidden="true" className="editor-menu-check" />}
              {it.submenu && <ChevronRight size={14} aria-hidden="true" className="editor-menu-chevron" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
