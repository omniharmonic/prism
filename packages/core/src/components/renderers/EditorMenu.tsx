import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * A small accessible menu for editor surfaces (block menu, Turn into, colour).
 * role=menu + roving focus: ↑/↓/Home/End move, Enter/Space activate, → opens a
 * submenu, ← / Escape go back or close. Focus returns to `returnFocus` on close.
 *
 * `searchable` adds a search field (NP-ED-02). Focus still starts on the first
 * item — typing any character from an item moves into the field ("type to
 * search"), ↓ / Enter from the field go to / run the first match. While a query
 * is typed the menu lists matches from `searchItems` (e.g. submenu entries
 * flattened in), else from `items`.
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
  /** Extra words the search field matches (the label always matches). */
  keywords?: string;
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
  searchable = false,
  searchItems,
  searchLabel = "Search actions",
}: {
  label: string;
  items: EditorMenuItem[];
  onClose: () => void;
  /** Present on a submenu: ← and the Back row return to the parent. */
  onBack?: () => void;
  style?: React.CSSProperties;
  className?: string;
  autoFocus?: boolean;
  searchable?: boolean;
  searchItems?: EditorMenuItem[];
  searchLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = !searchable || !q ? items : (searchItems ?? items).filter((it) => !it.disabled && `${it.label} ${it.keywords ?? ""}`.toLowerCase().includes(q)).map((it) => ({ ...it, section: undefined }));
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
    const inSearch = searchable && document.activeElement === searchRef.current;
    if (inSearch) {
      // The field keeps text keys (←/→/Home/End edit the query); ↓/↑ leave it, Enter runs the first match.
      if (event.key === "ArrowDown") { go(0); return; }
      if (event.key === "ArrowUp") { go(list.length - 1); return; }
      if (event.key === "Enter") { event.preventDefault(); shown.find((it) => !it.disabled)?.onSelect(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (query) setQuery(""); else if (onBack) onBack(); else onClose(); return; }
      if (event.key === "Tab") { event.preventDefault(); onClose(); }
      return;
    }
    if (searchable && event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Type to search from any item.
      event.preventDefault();
      setQuery((v) => v + event.key);
      searchRef.current?.focus({ preventScroll: true });
      return;
    }
    switch (event.key) {
      case "ArrowDown": go(at + 1); break;
      case "ArrowUp": go(at - 1); break;
      case "Home": go(0); break;
      case "End": go(list.length - 1); break;
      case "ArrowRight": {
        const item = shown.find((it) => it.id === (document.activeElement as HTMLElement)?.dataset.itemId);
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

  // Roving tab stop: one enabled item is in the tab order, so a menu that scrolls is keyboard-reachable
  // by construction (Tab itself closes the menu; arrows move focus).
  const tabStop = shown.find((it) => !it.disabled)?.id;
  const rows = (
    <>
      {onBack && (
        <button type="button" role="menuitem" tabIndex={-1} className="editor-menu-item editor-menu-back" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden="true" /> <span>{label}</span>
        </button>
      )}
      {shown.map((it) => {
        const role = it.checked === undefined ? "menuitem" : "menuitemradio";
        return (
          <div key={it.id} className="contents">
            {it.section && <div className="editor-menu-section" role="presentation">{it.section}</div>}
            <button
              type="button"
              role={role}
              tabIndex={it.id === tabStop ? 0 : -1}
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
    </>
  );
  const frame = { ref, className: `editor-menu ${className ?? ""}`, style, onKeyDown,
    onMouseDown: (event: React.MouseEvent) => event.preventDefault() /* keep the editor selection */ };
  // A search field is not a menu item: with one, the popup is a plain container holding the field
  // and the menu (role="menu" may only own menu items).
  if (searchable) return (
    <div {...frame}>
      <input
        ref={searchRef}
        type="search"
        role="searchbox"
        aria-label={searchLabel}
        placeholder={`${searchLabel}…`}
        className="editor-menu-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onMouseDown={(event) => event.stopPropagation() /* let the field take focus */}
      />
      {q && shown.length === 0 && <div className="editor-menu-empty" role="status">No results</div>}
      {(shown.length > 0 || onBack) && <div role="menu" aria-label={label}>{rows}</div>}
    </div>
  );
  return <div {...frame} role="menu" aria-label={label}>{rows}</div>;
}
