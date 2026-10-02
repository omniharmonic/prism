import { useCallback, useLayoutEffect, type RefObject } from "react";

/** Resize the existing field without replacing its DOM node, selection or draft. */
export function useComposerAutosize(ref: RefObject<HTMLTextAreaElement | null>, text: string) {
  const resize = useCallback(() => {
    const input = ref.current;
    if (!input || !input.isConnected || input.clientWidth === 0) return;
    const scrollTop = input.scrollTop;
    const style = getComputedStyle(input);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    input.style.height = "0px";
    const needed = input.scrollHeight + (Number.isFinite(border) ? border : 0);
    input.style.height = `${Math.max(44, Math.min(160, needed))}px`;
    input.style.overflowY = needed > 160 ? "auto" : "hidden";
    // Keep an internally scrolled long draft stable while measuring it.
    if (needed > 160) input.scrollTop = scrollTop;
  }, [ref]);

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
