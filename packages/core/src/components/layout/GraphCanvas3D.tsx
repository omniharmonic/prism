import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
const PALETTE = [
  "#7C9FE8",
  "#6FCF97",
  "#F2C94C",
  "#EB5757",
  "#BB6BD9",
  "#56CCF2",
  "#F2994A",
  "#27AE60",
  "#E84393",
  "#00CEC9",
  "#A29BFE",
  "#FD79A8",
];

function tagToColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++)
    hash = (hash * 31 + tag.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export interface GraphNode {
  id: string;
  path?: string;
  tags?: string[];
  x?: number;
  y?: number;
  z?: number;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  relationship: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export { tagToColor, PALETTE };

// ─── Shared GraphCanvas ───────────────────────────────────────────────

export interface GraphCanvasProps {
  graphData: GraphData;
  width: number;
  height: number;
  centerId: string;
  onNodeClick: (node: GraphNode) => void;
  backgroundColor?: string;
  isVisible?: boolean;
}

export function GraphCanvas({
  graphData,
  width,
  height,
  centerId,
  onNodeClick,
  backgroundColor,
  isVisible = true,
}: GraphCanvasProps) {
  // Reactively detect light/dark mode from the html class
  const [isLight, setIsLight] = useState(() =>
    document.documentElement.classList.contains("light"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsLight(document.documentElement.classList.contains("light"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  const resolvedBg = backgroundColor ?? (isLight ? "#f4f4f6" : "#111114");
  const linkBaseColor = isLight ? "rgba(0,0,0,0.15)" : "rgba(255,255,255,0.2)";
  const arrowColor = isLight ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.3)";
  const graphRef = useRef<any>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  // Build neighbor set for hover highlighting
  const neighborSet = useMemo(() => {
    if (!hoveredNode) return null;
    const set = new Set<string>();
    set.add(hoveredNode.id);
    for (const link of graphData.links) {
      const src =
        typeof link.source === "string" ? link.source : link.source.id;
      const tgt =
        typeof link.target === "string" ? link.target : link.target.id;
      if (src === hoveredNode.id) set.add(tgt);
      if (tgt === hoveredNode.id) set.add(src);
    }
    return set;
  }, [hoveredNode, graphData.links]);

  // Zoom to fit when data actually changes (by node count + center)
  const dataFingerprint = `${graphData.nodes.length}-${centerId}`;
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || graphData.nodes.length === 0) return;
    const timer = setTimeout(() => {
      try {
        fg.zoomToFit(400);
      } catch {
        /* graph may not be ready */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [dataFingerprint]);

  // Pause/resume based on visibility
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    try {
      if (isVisible) fg.resumeAnimation?.();
      else fg.pauseAnimation?.();
    } catch {
      /* may not be initialized yet */
    }
  }, [isVisible]);

  // WebGL cleanup on unmount
  useEffect(() => {
    return () => {
      const fg = graphRef.current;
      if (!fg) return;
      try {
        fg.pauseAnimation();
        const renderer = fg.renderer();
        if (renderer) {
          renderer.dispose();
          renderer.forceContextLoss();
        }
      } catch {
        /* renderer may already be gone */
      }
    };
  }, []);

  const dimColor = isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.1)";
  const defaultNodeColor = isLight
    ? "rgba(0,0,0,0.2)"
    : "rgba(255,255,255,0.3)";
  const handleNodeColor = useCallback(
    (node: GraphNode) => {
      if (node.id === centerId) return "#7C9FE8";
      if (neighborSet && !neighborSet.has(node.id)) return dimColor;
      if (node.tags?.[0]) return tagToColor(node.tags[0]);
      return defaultNodeColor;
    },
    [centerId, neighborSet, dimColor, defaultNodeColor],
  );

  const handleNodeLabel = useCallback(
    (node: GraphNode) => node.path?.split("/").pop() || node.id,
    [],
  );

  // Defer the click callback to next frame so the library's internal
  // click handler finishes before any React state changes occur.
  // Also guard against nodes with uninitialized positions (simulation not ready).
  const handleClick = useCallback(
    (node: GraphNode) => {
      if (!node?.id || typeof node.x !== "number") return;
      requestAnimationFrame(() => onNodeClick(node));
    },
    [onNodeClick],
  );

  if (graphData.nodes.length === 0) return null;

  return (
    <ForceGraph3D
      ref={graphRef}
      graphData={graphData}
      width={width}
      height={height}
      backgroundColor={resolvedBg}
      nodeColor={handleNodeColor}
      nodeLabel={handleNodeLabel}
      nodeVal={(node: GraphNode) => (node.id === centerId ? 3 : 1)}
      nodeOpacity={0.9}
      nodeResolution={8}
      linkColor={() => linkBaseColor}
      linkWidth={0.8}
      linkDirectionalArrowLength={3}
      linkDirectionalArrowRelPos={1}
      linkDirectionalArrowColor={() => arrowColor}
      linkLabel={(link: GraphLink) => link.relationship}
      onNodeClick={handleClick}
      onNodeHover={(node: GraphNode | null) => {
        if (node && typeof node.x !== "number") return;
        setHoveredNode(node);
      }}
      controlType="orbit"
      enablePointerInteraction={true}
    />
  );
}
