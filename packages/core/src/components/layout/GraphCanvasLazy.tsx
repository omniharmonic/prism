import { lazy, Suspense } from "react";
import type { GraphCanvasProps } from "./GraphCanvas3D";
const Canvas = lazy(() =>
  import("./GraphCanvas3D").then((module) => ({ default: module.GraphCanvas })),
);
/** Compatibility export; loading the shared package need not load WebGL. */
export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <Suspense fallback={<p role="status">Loading 3D view…</p>}>
      <Canvas {...props} />
    </Suspense>
  );
}
