import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, ExternalLink, Maximize2, Minus, Plus } from "lucide-react";
import { useGraphNeighborhood } from "../../app/hooks/useGraphNeighborhood";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { VaultNeighborhood } from "../../data/VaultClient";

const ThreeGraph = lazy(() =>
  import("./GraphCanvas3D").then((module) => ({ default: module.GraphCanvas })),
);
const controlClass =
  "focus-ring rounded-lg border border-[var(--glass-border)] px-2.5 py-2 text-xs disabled:opacity-50";
type Mode = "2D" | "List" | "3D";

export function GraphExplorer({
  noteId,
  fullscreen = false,
}: {
  noteId: string;
  fullscreen?: boolean;
}) {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  return (
    <Explorer
      key={client.scope?.() ?? audience ?? "legacy"}
      noteId={noteId}
      fullscreen={fullscreen}
    />
  );
}
function Explorer({
  noteId,
  fullscreen,
}: {
  noteId: string;
  fullscreen: boolean;
}) {
  const client = useVaultClient();
  const [centers, setCenters] = useState([noteId]);
  const center = centers[centers.length - 1]!;
  const [depth, setDepth] = useState(1);
  const [mode, setMode] = useState<Mode>("2D");
  const [relation, setRelation] = useState("");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const query = useGraphNeighborhood(center, depth);
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 320, height: 320 });
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      setSize((old) =>
        old.width === width && old.height === height ? old : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const graph = query.data;
  const current = graph?.nodes.find((n) => n.id === center);
  const relations = useMemo(
    () => [...new Set(graph?.edges.map((e) => e.relationship) ?? [])].sort(),
    [graph],
  );
  const filtered = useMemo(() => {
    if (!graph || !relation) return graph;
    const edges = graph.edges.filter((e) => e.relationship === relation);
    const ids = new Set([
      center,
      ...edges.flatMap((e) => [e.source, e.target]),
    ]);
    return { ...graph, edges, nodes: graph.nodes.filter((n) => ids.has(n.id)) };
  }, [graph, relation, center]);
  function focus(id: string) {
    if (id === center) return;
    setCenters((old) => [...old, id]);
    setRelation("");
    setError("");
  }
  async function openDocument() {
    if (opening || !current) return;
    const scope = query.scope;
    setOpening(true);
    setError("");
    try {
      const note = await client.getNote(current.id);
      if ((client.scope?.() ?? useAgentChatStore.getState().scope) !== scope)
        return;
      useUIStore
        .getState()
        .openTab(
          note.id,
          note.path?.split("/").pop() || current.title,
          inferContentType(note),
        );
    } catch {
      setError("This document is unavailable or your access has changed.");
    } finally {
      setOpening(false);
    }
  }
  return (
    <section
      aria-label="Connected knowledge"
      className="flex h-full min-h-0 flex-col bg-[var(--bg-surface)] text-[var(--text-primary)]"
    >
      <header className="space-y-3 border-b border-[var(--glass-border)] p-3">
        <div className="flex items-center gap-2">
          {centers.length > 1 && (
            <button
              className={controlClass}
              aria-label="Previous graph focus"
              onClick={() => {
                setCenters((old) => old.slice(0, -1));
                setRelation("");
              }}
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs text-[var(--text-muted)]">Connections</p>
            <h3 className="truncate text-sm font-medium">
              {current?.title ?? "Explore this document"}
            </h3>
          </div>
          {!fullscreen && (
            <button
              className={controlClass}
              aria-label="Expand graph"
              onClick={() => useUIStore.getState().setGraphFullscreen(true)}
            >
              <Maximize2 size={15} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Graph view"
            className="inline-flex rounded-lg border border-[var(--glass-border)] p-0.5"
          >
            {(["2D", "List", "3D"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={mode === value}
                className="focus-ring rounded-md px-3 py-1.5 text-xs"
                style={{
                  background:
                    mode === value ? "var(--glass-active)" : undefined,
                }}
                onClick={() => setMode(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            Steps
            <select
              aria-label="Connection depth"
              className="rounded-md bg-[var(--bg-elevated)] p-1"
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        {relations.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            Relationship
            <select
              aria-label="Relationship filter"
              className="min-w-0 flex-1 rounded-md bg-[var(--bg-elevated)] p-1.5"
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
            >
              <option value="">All relationships</option>
              {relations.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
        {center !== noteId && (
          <button
            className="focus-ring text-xs text-[var(--color-accent)]"
            onClick={() => {
              setCenters([noteId]);
              setRelation("");
            }}
          >
            Return to document
          </button>
        )}
      </header>
      <div ref={frame} className="relative min-h-0 flex-1 overflow-auto">
        {query.isFetching && (
          <p role="status" className="p-5 text-sm text-[var(--text-secondary)]">
            Loading connections…
          </p>
        )}
        {query.isError && (
          <div role="alert" className="space-y-3 p-5 text-sm">
            <p>
              Couldn’t load these connections. The document may be unavailable
              or your access may have changed.
            </p>
            <button
              className={controlClass}
              onClick={() => void query.refetch()}
            >
              Try again
            </button>
          </div>
        )}
        {filtered && !filtered.nodes.length && (
          <p className="p-5 text-sm">No accessible connections.</p>
        )}
        {filtered && filtered.nodes.length > 0 && (
          <>
            {filtered.edges.length === 0 && (
              <p className="px-4 pt-4 text-sm text-[var(--text-secondary)]">
                No connections yet. Link this document to another note to start
                exploring.
              </p>
            )}
            {mode === "List" ? (
              <GraphList graph={filtered} center={center} onFocus={focus} />
            ) : mode === "2D" ? (
              <GraphMap
                graph={filtered}
                center={center}
                width={Math.max(260, size.width)}
                height={Math.max(280, size.height)}
                onFocus={focus}
              />
            ) : (
              <ThreeBoundary key={center} fallback={() => setMode("List")}>
                <Suspense
                  fallback={
                    <p role="status" className="p-4 text-sm">
                      Loading 3D view…
                    </p>
                  }
                >
                  <ThreeGraph
                    graphData={{
                      nodes: filtered.nodes.map((n) => ({
                        ...n,
                        path: n.path ?? undefined,
                      })),
                      links: filtered.edges.map((e) => ({ ...e })),
                    }}
                    width={Math.max(260, size.width)}
                    height={Math.max(280, size.height)}
                    centerId={center}
                    onNodeClick={(n) => focus(n.id)}
                  />
                </Suspense>
              </ThreeBoundary>
            )}
          </>
        )}
      </div>
      {graph && (
        <footer className="space-y-2 border-t border-[var(--glass-border)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-[var(--text-muted)]">
              {filtered?.nodes.length ?? 0} documents ·{" "}
              {filtered?.edges.length ?? 0} connections
            </span>
            <button
              className={controlClass}
              disabled={!current || opening}
              onClick={() => void openDocument()}
            >
              <ExternalLink size={12} className="mr-1 inline" />
              Open document
            </button>
          </div>
          {graph.truncated && (
            <p role="status" className="text-xs text-[var(--text-secondary)]">
              Showing a limited neighborhood. Focus a document to explore more.
            </p>
          )}
        </footer>
      )}
      {error && (
        <p role="alert" className="p-3 text-xs">
          {error}
        </p>
      )}
    </section>
  );
}

function GraphList({
  graph,
  center,
  onFocus,
}: {
  graph: VaultNeighborhood;
  center: string;
  onFocus: (id: string) => void;
}) {
  return (
    <ul aria-label="Connected documents" className="space-y-1 p-3">
      {graph.nodes.map((node) => {
        const labels = graph.edges
          .filter(
            (e) =>
              (e.source === center && e.target === node.id) ||
              (e.target === center && e.source === node.id),
          )
          .map(
            (e) =>
              `${e.source === center ? "Outgoing" : "Incoming"} · ${e.relationship}`,
          );
        return (
          <li key={node.id}>
            <button
              className="focus-ring w-full rounded-lg border border-[var(--glass-border)] p-3 text-left hover:bg-[var(--glass-hover)]"
              aria-label={`Focus ${node.title}`}
              aria-current={node.id === center ? "true" : undefined}
              onClick={() => onFocus(node.id)}
            >
              <span className="block break-words text-sm font-medium">
                {node.title}
              </span>
              <span className="block break-words text-xs text-[var(--text-muted)]">
                {node.path ?? node.id}
              </span>
              <span className="mt-1 block text-xs text-[var(--text-secondary)]">
                {node.id === center
                  ? "Current focus"
                  : labels.join(" · ") || "Connected note"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function GraphMap({
  graph,
  center,
  width,
  height,
  onFocus,
}: {
  graph: VaultNeighborhood;
  center: string;
  width: number;
  height: number;
  onFocus: (id: string) => void;
}) {
  const arrow = useId().replace(/:/g, "");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const maxNodes = width < 600 ? 11 : 31;
  const nodes = [...graph.nodes]
    .sort((a, b) =>
      a.id === center
        ? -1
        : b.id === center
          ? 1
          : a.title.localeCompare(b.title),
    )
    .slice(0, maxNodes);
  const h = Math.min(height, 720),
    radius = Math.min(width * 0.33, h * 0.32);
  const positions = new Map(
    nodes.map((node, i) => {
      const angle =
        ((i - 1) * Math.PI * 2) / Math.max(1, nodes.length - 1) - Math.PI / 2;
      return [
        node.id,
        {
          node,
          x: i === 0 ? width / 2 : width / 2 + Math.cos(angle) * radius,
          y: i === 0 ? h / 2 : h / 2 + Math.sin(angle) * radius,
        },
      ] as const;
    }),
  );
  return (
    <div className="relative">
      <div className="absolute right-3 top-3 z-10 flex gap-1">
        <button
          className={controlClass}
          aria-label="Zoom out"
          disabled={zoom <= 0.6}
          onClick={() => setZoom((z) => Math.max(0.6, z - 0.2))}
        >
          <Minus size={14} />
        </button>
        <button
          className={controlClass}
          aria-label="Zoom in"
          disabled={zoom >= 2}
          onClick={() => setZoom((z) => Math.min(2, z + 0.2))}
        >
          <Plus size={14} />
        </button>
        <button
          className={controlClass}
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
        >
          Reset view
        </button>
      </div>
      <svg
        role="group"
        aria-label="Document connection map"
        tabIndex={0}
        width="100%"
        height={h}
        style={{ touchAction: "none" }}
        viewBox={`${(width * (1 - 1 / zoom)) / 2 + pan.x} ${(h * (1 - 1 / zoom)) / 2 + pan.y} ${width / zoom} ${h / zoom}`}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[role="button"]')) return;
          drag.current = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            panX: pan.x,
            panY: pan.y,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (start?.id === e.pointerId)
            setPan({
              x: start.panX - (e.clientX - start.x) / zoom,
              y: start.panY - (e.clientY - start.y) / zoom,
            });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const delta: Record<string, [number, number]> = {
            ArrowLeft: [-30, 0],
            ArrowRight: [30, 0],
            ArrowUp: [0, -30],
            ArrowDown: [0, 30],
          };
          const step = delta[e.key];
          if (step) {
            e.preventDefault();
            setPan((p) => ({ x: p.x + step[0], y: p.y + step[1] }));
          }
        }}
      >
        <defs>
          <marker
            id={arrow}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
          </marker>
        </defs>
        {graph.edges.map((edge, i) => {
          const a = positions.get(edge.source),
            b = positions.get(edge.target);
          if (!a || !b || a === b) return null;
          const dx = b.x - a.x,
            dy = b.y - a.y,
            length = Math.hypot(dx, dy) || 1;
          return (
            <line
              key={i}
              x1={a.x + (dx / length) * 10}
              y1={a.y + (dy / length) * 10}
              x2={b.x - (dx / length) * 13}
              y2={b.y - (dy / length) * 13}
              stroke="var(--text-muted)"
              strokeOpacity=".35"
              strokeWidth="1.2"
              markerEnd={`url(#${arrow})`}
            >
              <title>
                {a.node.title} → {edge.relationship} → {b.node.title}
              </title>
            </line>
          );
        })}
        {[...positions.values()].map(({ node, x, y }) => (
          <g
            key={node.id}
            role="button"
            aria-label={`Focus ${node.title}`}
            tabIndex={0}
            className="focus-ring cursor-pointer"
            onClick={() => onFocus(node.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onFocus(node.id);
              }
            }}
          >
            <title>{node.path ?? node.title}</title>
            <circle cx={x} cy={y} r={22} fill="transparent" />
            <circle
              cx={x}
              cy={y}
              r={node.id === center ? 10 : 7}
              fill={
                node.id === center
                  ? "var(--color-accent)"
                  : "var(--bg-elevated)"
              }
              stroke="var(--color-accent)"
              strokeWidth={node.id === center ? 0 : 2}
            />
            <text
              x={x}
              y={y + 24}
              textAnchor="middle"
              fill="var(--text-primary)"
              fontSize="11"
              paintOrder="stroke"
              stroke="var(--bg-surface)"
              strokeWidth="4"
              strokeLinejoin="round"
            >
              {node.title.length > 22
                ? node.title.slice(0, 21) + "…"
                : node.title}
            </text>
          </g>
        ))}
      </svg>
      {graph.nodes.length > maxNodes && (
        <p className="px-4 pb-3 text-xs text-[var(--text-secondary)]">
          Map shows {maxNodes} of {graph.nodes.length} documents. List view
          includes all loaded documents.
        </p>
      )}
    </div>
  );
}

class ThreeBoundary extends Component<
  { children: ReactNode; fallback: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="space-y-3 p-4 text-sm">
        <p>3D is unavailable on this device.</p>
        <button className={controlClass} onClick={this.props.fallback}>
          Use list view
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
