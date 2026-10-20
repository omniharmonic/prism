import { useCallback, useLayoutEffect, type RefObject } from "react";

/** Resize the existing field without replacing its DOM node, selection or draft. */
export function useComposerAutosize(ref: RefObject<HTMLTextAreaElement | null>, text: string, minHeight = 44) {
  const resize = useCallback(() => {
    const input = ref.current;
    if (!input || !input.isConnected || input.clientWidth === 0) return;
    const scrollTop = input.scrollTop;
    const style = getComputedStyle(input);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    // Measuring collapses the field. Hold its parent at the current height meanwhile:
    // otherwise a neighbouring scroller grows for that one layout, the browser clamps
    // its scrollTop, and a thread read at the end jumps up by the draft's height.
    const parent = input.parentElement;
    const parentMinHeight = parent?.style.minHeight ?? "";
    if (parent) parent.style.minHeight = `${parent.getBoundingClientRect().height}px`;
    input.style.height = "0px";
    const needed = input.scrollHeight + (Number.isFinite(border) ? border : 0);
    input.style.height = `${Math.max(minHeight, Math.min(160, needed))}px`;
    if (parent) parent.style.minHeight = parentMinHeight;
    input.style.overflowY = needed > 160 ? "auto" : "hidden";
    // Keep an internally scrolled long draft stable while measuring it.
    if (needed > 160) input.scrollTop = scrollTop;
  }, [ref, minHeight]);

  useLayoutEffect(resize, [resize, text]);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let width = input.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      // Height-only notifications are our own resize, not a new measurement.
      if (nextWidth === width) return;
      width = nextWidth;
      resize();
    });
    observer.observe(input);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [ref, resize]);
}
