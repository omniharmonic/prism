import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Maximize2, Minimize2 } from "lucide-react";

/** Expand the existing scene in place: no portal/remount or second Yjs editor. */
export function useCanvasPresentation() {
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded || !ref.current) return;
    // Keep the rest of the workspace out of keyboard/screen-reader navigation.
    const siblings: Array<[HTMLElement, boolean]> = [];
    let child: HTMLElement = ref.current;
    while (child.parentElement && child !== document.body) {
      for (const node of child.parentElement.children) {
        if (node !== child && node instanceof HTMLElement) {
          siblings.push([node, node.inert]);
          node.inert = true;
        }
      }
      child = child.parentElement;
    }
    button.current?.focus();
    return () => {
      for (const [node, inert] of siblings) node.inert = inert;
      button.current?.focus();
    };
  }, [expanded]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!expanded || e.defaultPrevented) return;
    if (e.key === "Escape") {
      const target = e.target as HTMLElement;
      const editor = target.closest(
        "input,textarea,[contenteditable=true],[role=menu],[role=dialog]",
      );
      if (editor && editor !== ref.current) return;
      e.preventDefault();
      e.stopPropagation();
      setExpanded(false);
    }
    if (e.key === "Tab") {
      const items = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ) ?? []),
      ].filter((el) => el.getClientRects().length && !el.closest("[inert]"));
      const first = items[0],
        last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };
  const style: CSSProperties = expanded
    ? {
        position: "fixed",
        inset: 0,
        zIndex: 90,
        width: "100vw",
        height: "100dvh",
        background: "var(--bg-base, #151518)",
        transition: "none",
        padding:
          "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)",
        boxSizing: "border-box",
      }
    : {};
  const control = (
    <button
      ref={button}
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-label={expanded ? "Back to document" : "Focus canvas"}
      aria-pressed={expanded}
      className="focus-ring flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-xs hover:bg-[var(--glass-hover)]"
    >
      {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      <span>{expanded ? "Back to document" : "Focus canvas"}</span>
    </button>
  );
  return { ref, expanded, style, onKeyDown, control };
}
