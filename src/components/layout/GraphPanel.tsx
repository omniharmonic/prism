import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ForceGraph3D from "react-force-graph-3d";
import { Crosshair, Maximize2 } from "lucide-react";
import { useFullGraph, filterNeighborhood } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { Spinner } from "../ui/Spinner";

// Max nodes to render — prevents WebGL overload on dense neighborhoods
const MAX_GRAPH_NODES = 300;

// ─── Shared types & utils ─────────────────────────────────────────────

const PALETTE = [
  "#7C9FE8", "#6FCF97", "#F2C94C", "#EB5757", "#BB6BD9",
  "#56CCF2", "#F2994A", "#27AE60", "#E84393", "#00CEC9",
  "#A29BFE", "#FD79A8",
];

function tagToColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) | 0;
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
  backgroundColor = "#111114",
  isVisible = true,
}: GraphCanvasProps) {
  const graphRef = useRef<any>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  // Build neighbor set for hover highlighting
  const neighborSet = useMemo(() => {
    if (!hoveredNode) return null;
    const set = new Set<string>();
    set.add(hoveredNode.id);
    for (const link of graphData.links) {
      const src = typeof link.source === "string" ? link.source : link.source.id;
      const tgt = typeof link.target === "string" ? link.target : link.target.id;
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
      try { fg.zoomToFit(400); } catch { /* graph may not be ready */ }
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
    } catch { /* may not be initialized yet */ }
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
      } catch { /* renderer may already be gone */ }
    };
  }, []);

  const handleNodeColor = useCallback(
    (node: GraphNode) => {
      if (node.id === centerId) return "#7C9FE8";
      if (neighborSet && !neighborSet.has(node.id)) return "rgba(255,255,255,0.1)";
      if (node.tags?.[0]) return tagToColor(node.tags[0]);
      return "rgba(255,255,255,0.3)";
    },
    [centerId, neighborSet],
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
      backgroundColor={backgroundColor}
      nodeColor={handleNodeColor}
      nodeLabel={handleNodeLabel}
      nodeVal={(node: GraphNode) => (node.id === centerId ? 3 : 1)}
      nodeOpacity={0.9}
      nodeResolution={8}
      linkColor={() => "rgba(255,255,255,0.08)"}
      linkWidth={0.5}
      linkDirectionalArrowLength={3}
      linkDirectionalArrowRelPos={1}
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

// ─── GraphPanel (side panel tab) ──────────────────────────────────────

interface GraphPanelProps {
  noteId: string;
}

export default function GraphPanel({ noteId }: GraphPanelProps) {
  // Graph maintains its own center — doesn't chase active tab changes.
  const [centerId, setCenterId] = useState(noteId);
  const [depth, setDepth] = useState(2);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const openTab = useUIStore((s) => s.openTab);
  const contextPanelTab = useUIStore((s) => s.contextPanelTab);
  const setGraphFullscreen = useUIStore((s) => s.setGraphFullscreen);

  // Fetch the full graph once (cached 60s). Neighborhood filtering is client-side.
  const { data: fullGraph, isLoading } = useFullGraph();

  // Client-side BFS: extract neighborhood around centerId, capped to prevent WebGL overload
  const graphData = useMemo<GraphData>(() => {
    if (!fullGraph || fullGraph.nodes.length === 0) return { nodes: [], links: [] };
    const neighborhood = filterNeighborhood(fullGraph, centerId, depth);

    // Cap node count — too many nodes crashes WebGL / Three.js
    let nodes = neighborhood.nodes as GraphNode[];
    let edges = neighborhood.edges;
    if (nodes.length > MAX_GRAPH_NODES) {
      const nodeSet = new Set(nodes.slice(0, MAX_GRAPH_NODES).map((n) => n.id));
      nodes = nodes.slice(0, MAX_GRAPH_NODES);
      edges = edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target));
    }

    return {
      nodes,
      links: edges.map((e) => ({
        source: e.source,
        target: e.target,
        relationship: e.relationship,
      })),
    };
  }, [fullGraph, centerId, depth]);

  // Track container size with ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setDimensions({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Clicking a node opens the tab but does NOT re-center the graph.
  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (!node?.id) return;
      const title = node.path?.split("/").pop() || node.id;
      openTab(node.id, title, "document");
    },
    [openTab],
  );

  // Allow user to explicitly re-center the graph on the current note
  const handleRecenter = useCallback(() => {
    setCenterId(noteId);
  }, [noteId]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-full">
        <Spinner size={20} />
      </div>
    );
  }

  if (graphData.nodes.length === 0) {
    return (
      <div className="text-center pt-8 px-3" style={{ color: "var(--text-muted)" }}>
        No connections found for this note.
      </div>
    );
  }

  const isCenteredOnActive = centerId === noteId;

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs flex-shrink-0"
        style={{
          borderBottom: "1px solid var(--glass-border)",
          color: "var(--text-secondary)",
        }}
      >
        <label className="flex items-center gap-1.5">
          Depth
          <input
            type="range"
            min={1}
            max={5}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="w-16 accent-[var(--color-accent)]"
          />
          <span style={{ color: "var(--text-muted)", minWidth: 12 }}>{depth}</span>
        </label>

        {!isCenteredOnActive && (
          <button
            onClick={handleRecenter}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[var(--glass-hover)] transition-colors"
            title="Re-center on active note"
            style={{ color: "var(--color-accent)" }}
          >
            <Crosshair size={11} />
            <span>Re-center</span>
          </button>
        )}

        <span className="flex-1" />

        <span style={{ color: "var(--text-muted)" }}>
          {graphData.nodes.length} nodes
        </span>

        <button
          onClick={() => setGraphFullscreen(true)}
          className="p-1 rounded hover:bg-[var(--glass-hover)] transition-colors"
          title="Fullscreen"
        >
          <Maximize2 size={13} />
        </button>
      </div>

      {/* Graph canvas */}
      <div ref={containerRef} className="flex-1 min-h-0">
        {dimensions.width > 0 && dimensions.height > 0 && (
          <GraphErrorBoundary>
            <GraphCanvas
              graphData={graphData}
              width={dimensions.width}
              height={dimensions.height}
              centerId={centerId}
              onNodeClick={handleNodeClick}
              isVisible={contextPanelTab === "graph"}
            />
          </GraphErrorBoundary>
        )}
      </div>
    </div>
  );
}

// ─── Error boundary for graph rendering ──────────────────────────────

class GraphErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center"
          style={{ color: "var(--text-muted)" }}
        >
          <p className="text-sm">Graph failed to render</p>
          <p className="text-xs" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 px-3 py-1 text-xs rounded hover:bg-[var(--glass-hover)] transition-colors"
            style={{ border: "1px solid var(--glass-border)" }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
