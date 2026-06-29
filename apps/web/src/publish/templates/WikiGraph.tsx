// WikiGraph — the published wiki's interactive knowledge graph.
//
// Uses the SAME 3D force graph (`react-force-graph-3d`) as the main Prism app,
// via the shared `GraphCanvas` from @prism/core, so the public site's graph
// looks and behaves like the in-app one. It renders ONLY the nodes/edges from
// the publication-scoped, leak-proof `/api/p/:slug/graph` endpoint (passed in as
// `graph`) — never the owner's full vault — so it can never surface an
// out-of-set node. GraphCanvas (and the three.js bundle it pulls in) is
// lazy-loaded so it costs nothing until the reader opens the graph panel.
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { GraphData, GraphNode } from "@prism/core";
import type { PubGraph } from "./types";

const GraphCanvas = lazy(() => import("@prism/core").then((m) => ({ default: m.GraphCanvas })));

const MAX_NODES = 600;

export function WikiGraph({
  graph,
  activeId,
  onNavigate,
}: {
  graph: PubGraph;
  activeId: string | null;
  onNavigate: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 0, height: 320 });

  // Map the leak-proof publication graph → the shared GraphData shape. `path`
  // carries the title so GraphCanvas's label (basename of path) shows the title.
  const data = useMemo<GraphData>(() => {
    const nodes = graph.nodes.slice(0, MAX_NODES).map((n) => ({ id: n.id, path: n.title }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = graph.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, relationship: "" }));
    return { nodes, links };
  }, [graph]);

  // Track the container width for the canvas.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setDims({ width: Math.round(r.width), height: 320 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (data.nodes.length === 0) return null;

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: 320,
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid var(--border, rgba(0,0,0,0.1))",
        background: "var(--bg, #111114)",
      }}
    >
      <Suspense fallback={<GraphLoading />}>
        {dims.width > 0 && (
          <GraphCanvas
            graphData={data}
            width={dims.width}
            height={dims.height}
            centerId={activeId ?? ""}
            onNodeClick={(node: GraphNode) => onNavigate(node.id)}
          />
        )}
      </Suspense>
    </div>
  );
}

function GraphLoading() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        color: "var(--text-secondary, #888)",
      }}
    >
      Loading graph…
    </div>
  );
}
