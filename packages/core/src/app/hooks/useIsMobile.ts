import { useEffect, useState } from "react";

/**
 * Tracks whether the viewport is below a breakpoint (default 768px).
 * Used by the Shell to switch the sidebar/context panels between inline
 * columns (desktop) and overlay drawers (mobile / narrow windows).
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);

  return isMobile;
}
