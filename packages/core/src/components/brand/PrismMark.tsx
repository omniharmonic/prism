import React from "react";

/** Canonical geometry: five spectrum inputs converge into one outgoing ray. */
export function PrismMark({ monochrome = false, decorative = false, compact: compactOverride, ...props }: React.SVGProps<SVGSVGElement> & { monochrome?: boolean; decorative?: boolean; compact?: boolean }) {
  // Optical sizing keeps the same five-to-one silhouette at avatar/favicon size.
  const compact = compactOverride ?? (typeof props.width === "number" && props.width <= 32);
  const colors = monochrome ? Array(5).fill("currentColor") : ["#9371e8", "#438bd7", "#34a69e", "#dfa741", "#db796c"];
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 64" width={42} height={28}
      role={decorative ? undefined : "img"} aria-label={decorative ? undefined : "Prism — many sources, one workspace"}
      aria-hidden={decorative || undefined} fill="none" {...props}>
      <path d="M54 9 77 55H31Z" fill="currentColor" fillOpacity=".045" />
      {colors.map((color, i) => <path key={i} d={`M6 ${12 + i * 10} 54 32`} stroke={color} strokeWidth={compact ? 4 : monochrome ? 2.5 : 3} strokeLinecap="round" />)}
      <path d="M54 32H91" stroke="currentColor" strokeWidth={compact ? 4.8 : 3.2} strokeLinecap="round" />
      <path d="M54 9 77 55H31Z" stroke="currentColor" strokeWidth={compact ? 4 : 2.2} strokeLinejoin="round" />
      {!compact && <path d="M54 9V55M31 55 54 32 77 55" stroke="currentColor" strokeOpacity=".28" strokeWidth="1.5" strokeLinejoin="round" />}
    </svg>
  );
}

// Large PWA/maskable exports retain the established safe inset. Tiny native
// icons and the favicon give the optically heavier mark a little more room.
export function PrismAppIcon({ size = 96, compact = size <= 48 }: { size?: number; compact?: boolean }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 96 96" role="img" aria-label="Prism">
    <rect width="96" height="96" rx="21" fill="#22242a" />
    <rect x=".5" y=".5" width="95" height="95" rx="20.5" fill="none" stroke="#ffffff" strokeOpacity=".1" />
    <PrismMark x={compact ? 7 : 13} y={compact ? 20 : 25} width={compact ? 82 : 70} height={compact ? 55 : 47} compact={compact} color="#faf9f6" decorative />
  </svg>;
}
