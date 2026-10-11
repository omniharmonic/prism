import { useCallback, useEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "../../lib/motion";

const easing = "cubic-bezier(.22,1,.36,1)";
/** Drag only chrome, never a text field or scrolling content. Position updates stay off React's render path. */
export function useSurfaceDismiss(ref: RefObject<HTMLElement | null>, enabled: boolean, handle: string, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closing = useRef(false);
  const animation = useRef<Animation | null>(null);
  const dismiss = useCallback(() => {
    const node = ref.current;
    if (closing.current) return;
    if (!enabled || !node || prefersReducedMotion()) { closeRef.current(); return; }
    closing.current = true;
    const from = getComputedStyle(node).transform;
    animation.current?.cancel();
    animation.current = node.animate([{ transform: from }, { transform: `translateY(${window.innerHeight - node.getBoundingClientRect().top + 32}px)` }], { duration: 240, easing, fill: "forwards" });
    void animation.current.finished.then(() => closeRef.current()).catch(() => {});
  }, [enabled, ref]);
  useEffect(() => {
    closing.current = false;
    const node = ref.current;
    if (!enabled || !node) return;
    let start: { x: number; y: number } | null = null;
    let distance = 0, claimed = false;
    const reset = () => {
      start = null;
      if (claimed) {
        const from = node.style.transform;
        node.style.transform = "";
        animation.current?.cancel();
        if (!prefersReducedMotion()) animation.current = node.animate([{ transform: from }, { transform: "translateY(0)" }], { duration: 240, easing });
      }
      claimed = false;
      distance = 0;
    };
    const begin = (event: TouchEvent) => {
      const target = event.target as Element;
      if (closing.current || event.touches.length !== 1 || !target.closest(handle) || target.closest("input, textarea, select, [contenteditable]")) return;
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1) { reset(); return; }
      const touch = event.touches[0], dy = touch.clientY - start.y, dx = Math.abs(touch.clientX - start.x);
      if (!claimed && dx > 12 && dx > Math.abs(dy)) { reset(); return; }
      if (!claimed && dy > 8 && dy > dx * 1.5) {
        claimed = true;
        node.getAnimations().forEach(item => item.cancel());
      }
      if (!claimed) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      distance = Math.max(0, dy);
      node.style.transform = `translateY(${distance}px)`;
    };
    const end = (event: TouchEvent) => {
      if (!claimed) { reset(); return; }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (distance >= 72) { start = null; claimed = false; dismiss(); }
      else reset();
    };
    node.addEventListener("touchstart", begin, { passive: true });
    node.addEventListener("touchmove", move, { passive: false });
    node.addEventListener("touchend", end, { passive: false });
    node.addEventListener("touchcancel", reset);
    return () => {
      animation.current?.cancel();
      node.style.transform = "";
      node.removeEventListener("touchstart", begin);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", reset);
    };
  }, [enabled, handle, ref, dismiss]);
  return dismiss;
}
