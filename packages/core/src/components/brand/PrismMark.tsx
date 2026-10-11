import React from "react";

/** Faceted outline from the approved Concept 02; optical weight for small sizes. */
export function PrismMark({ monochrome = false, decorative = false, compact: compactOverride, ...props }: React.SVGProps<SVGSVGElement> & { monochrome?: boolean; decorative?: boolean; compact?: boolean }) {
  const compact = compactOverride ?? (typeof props.width === "number" && props.width <= 32);
  const colors = monochrome ? ["currentColor", "currentColor", "currentColor"] : ["#92a9d6", "#7c96ce", "#b4a4ce"];
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 34" width={28} height={30}
    role={decorative ? undefined : "img"} aria-label={decorative ? undefined : "Prism — many sources, one workspace"}
    aria-hidden={decorative || undefined} fill="none" {...props}>
    <g strokeWidth={compact ? 1.6 : 1.15} strokeLinejoin="round" strokeLinecap="round">
      <path d="M16 3 30 29H2Z" stroke={colors[0]} />
      <path d="M8 18 28 26M6 22 24 14M12 10 20 29" stroke={colors[1]} />
      <path d="m2 29 19-8 11 8" stroke={colors[2]} />
    </g>
  </svg>;
}

// Large PWA/maskable exports retain the established safe inset. Tiny native
// icons and the favicon give the optically heavier mark a little more room.
export function PrismAppIcon({ size = 96, compact = size <= 48 }: { size?: number; compact?: boolean }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 96 96" role="img" aria-label="Prism">
    <rect width="96" height="96" rx="21" fill="#22242a" />
    <rect x=".5" y=".5" width="95" height="95" rx="20.5" fill="none" stroke="#ffffff" strokeOpacity=".1" />
    <PrismMark x={compact ? 15 : 19} y={compact ? 12 : 16} width={compact ? 66 : 58} height={compact ? 72 : 64} compact={compact} color="#faf9f6" decorative />
  </svg>;
}
