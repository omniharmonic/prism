import React from "react";

/** Approved broad prism silhouette with golden-ratio subdivisions inside.
 * The reference informs the interior pattern, not the outer proportions. */
const phi = (1 + Math.sqrt(5)) / 2;
const apex = [16, 3] as const;
const left = [2, 29] as const;
const right = [30, 29] as const;
type Point = readonly [number, number];
const divide = (a: Point, b: Point): Point => [a[0] + (b[0] - a[0]) / phi, a[1] + (b[1] - a[1]) / phi];
const point = (p: Point) => p.map(n => Number(n.toFixed(4))).join(" ");
const d = divide(apex, right);
const e = divide(left, d);
const f = divide(right, e);
const g = divide(d, f);
const h = divide(e, g);
export function PrismMark({ monochrome = false, decorative = false, compact: compactOverride, ...props }: React.SVGProps<SVGSVGElement> & { monochrome?: boolean; decorative?: boolean; compact?: boolean }) {
  const compact = compactOverride ?? (typeof props.width === "number" && props.width <= 32);
  const colors = monochrome ? ["currentColor", "currentColor", "currentColor"] : ["#92a9d6", "#7c96ce", "#b4a4ce"];
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 34" width={28} height={30}
    role={decorative ? undefined : "img"} aria-label={decorative ? undefined : "Prism — many sources, one workspace"}
    aria-hidden={decorative || undefined} fill="none" {...props}>
    <g strokeWidth={compact ? 1.6 : 1.15} strokeLinejoin="round" strokeLinecap="round">
      <path d={`M${point(apex)} ${point(right)} ${point(left)}Z`} stroke={colors[0]} />
      <path d={`M${point(left)} ${point(d)}M${point(right)} ${point(e)}`} stroke={colors[1]} />
      <path d={`M${point(d)} ${point(f)}M${point(e)} ${point(g)}M${point(f)} ${point(h)}`} stroke={colors[2]} />
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
