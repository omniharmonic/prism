import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Crosshair, X } from "lucide-react";
import { useFullGraph, filterNeighborhood } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { GraphCanvas, type GraphNode, type GraphData } from "./GraphPanel";

export function GraphFullscreen() {
  const graphFullscreen = useUIStore((s) => s.graphFullscreen);
  const setGraphFullscreen = useUIStore((s) => s.setGraphFullscreen);
  const openTabs = useUIStore((s) => s.openTabs);
  const activeTabId = useUIStore((s) => s.activeTabId);
  const openTab = useUIStore((s) => s.openTab);

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const activeNoteId = activeTab?.noteId ?? null;

  // Own center state — set when fullscreen opens, stable during interaction
  const [centerId, setCenterId] = useState<string | null>(activeNoteId);
  const [depth, setDepth] = useState(2);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // Sync centerId when fullscreen opens
  useEffect(() => {
    if (graphFullscreen && activeNoteId) {
      setCenterId(activeNoteId);
    }
  }, [graphFullscreen]);

  // Full graph (shared cache with panel)
  const { data: fullGraph } = useFullGraph();

  // Client-side BFS neighborhood filter, capped to prevent WebGL overload
  const MAX_NODES = 500; // Higher cap for fullscreen
  const graphData = useMemo<GraphData>(() => {
    if (!fullGraph || !centerId) return { nodes: [], links: [] };
    const neighborhood = filterNeighborhood(fullGraph, centerId, depth);

    let nodes = neighborhood.nodes as GraphNode[];
    let edges = neighborhood.edges;
    if (nodes.length > MAX_NODES) {
      const nodeSet = new Set(nodes.slice(0, MAX_NODES).map((n) => n.id));
      nodes = nodes.slice(0, MAX_NODES);
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

  // Track container size
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
  }, [graphFullscreen]);

  // Escape key to close
  useEffect(() => {
    if (!graphFullscreen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGraphFullscreen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [graphFullscreen, setGraphFullscreen]);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (!node?.id || typeof node.x !== "number") return;
      const title = node.path?.split("/").pop() || node.id;
      openTab(node.id, title, "document");
    },
    [openTab],
  );

  const handleRecenter = useCallback(() => {
    if (activeNoteId) setCenterId(activeNoteId);
  }, [activeNoteId]);

  if (!graphFullscreen) return null;

  const noteTitle = activeTab?.title ?? "Graph";
  const isCenteredOnActive = centerId === activeNoteId;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "var(--bg-base)" }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)" }}
      >
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {noteTitle}
        </span>

        <label
          className="flex items-center gap-1.5 text-xs"
          style={{ color: "var(--text-secondary)" }}
        >
          Depth
          <input
            type="range"
            min={1}
            max={5}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="w-20 accent-[var(--color-accent)]"
          />
          <span style={{ color: "var(--text-muted)" }}>{depth}</span>
        </label>

        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {graphData.nodes.length} nodes
        </span>

        {!isCenteredOnActive && (
          <button
            onClick={handleRecenter}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs hover:bg-[var(--glass-hover)] transition-colors"
            title="Re-center on active note"
            style={{ color: "var(--color-accent)" }}
          >
            <Crosshair size={11} />
            <span>Re-center</span>
          </button>
        )}

        <span className="flex-1" />

        <button
          onClick={() => setGraphFullscreen(false)}
          className="p-1.5 rounded hover:bg-[var(--glass-hover)] transition-colors"
          title="Exit fullscreen (Esc)"
        >
          <X size={16} style={{ color: "var(--text-secondary)" }} />
        </button>
      </div>

      {/* Graph */}
      <div ref={containerRef} className="flex-1 min-h-0">
        {dimensions.width > 0 && dimensions.height > 0 && centerId && (
          <GraphCanvas
            graphData={graphData}
            width={dimensions.width}
            height={dimensions.height}
            centerId={centerId}
            onNodeClick={handleNodeClick}
            backgroundColor="#09090b"
            isVisible={graphFullscreen}
          />
        )}
      </div>
    </div>
  );
}
