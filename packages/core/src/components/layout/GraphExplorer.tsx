import { leafTitle } from "../../lib/pages/containerTitle";
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
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ArrowLeft,
  ExternalLink,
  FileText,
  Maximize2,
  Minus,
  Plus,
  Search,
} from "lucide-react";
import { useGraphNeighborhood } from "../../app/hooks/useGraphNeighborhood";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { VaultNeighborhood } from "../../data/VaultClient";

import "./graph-explorer.css";
import {
  defaultGraphCamera,
  readGraphView,
  saveGraphView,
  type GraphCamera,
  type GraphView,
} from "./graphViews";

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
  const clientScope = client.scope?.();
  const scope = clientScope || audience;
  const savedKey = scope
    ? JSON.stringify([clientScope ?? null, audience, noteId])
    : null;
  return (
    <Explorer
      key={JSON.stringify([clientScope, audience, noteId])}
      savedKey={savedKey}
      noteId={noteId}
      fullscreen={fullscreen}
    />
  );
}
function Explorer({
  noteId,
  fullscreen,
  savedKey,
}: {
  noteId: string;
  fullscreen: boolean;
  savedKey: string | null;
}) {
  const client = useVaultClient();
  const [centers, setCenters] = useState([noteId]);
  const center = centers[centers.length - 1]!;
  const [depth, setDepth] = useState(1);
  const [mode, setMode] = useState<Mode>("2D");
  const [relation, setRelation] = useState("");
  const [search, setSearch] = useState("");
  const [camera, setCamera] = useState(defaultGraphCamera);
  const [saved, setSaved] = useState<GraphView | null>(null);
  const [viewNotice, setViewNotice] = useState("");
  useEffect(() => {
    const refresh = () => {
      try {
        setSaved(savedKey ? readGraphView(savedKey) : null);
      } catch {
        setSaved(null);
        setViewNotice(
          "Saved views are unavailable on this device. You can still explore.",
        );
      }
    };
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener("prism:graph-view-changed", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("prism:graph-view-changed", refresh);
    };
  }, [savedKey]);
  function audienceCurrent() {
    return (
      !!savedKey &&
      savedKey ===
        JSON.stringify([
          client.scope?.() ?? null,
          useAgentChatStore.getState().scope,
          noteId,
        ])
    );
  }
  function saveView(clear = false) {
    if (!audienceCurrent()) return;
    try {
      saveGraphView(
        savedKey!,
        clear
          ? null
          : {
              centers: centers.slice(-50),
              depth,
              mode,
              relation,
              search,
              camera,
            },
      );
      setViewNotice(
        clear
          ? "Saved view removed from this device."
          : "View saved on this device.",
      );
    } catch {
      setViewNotice(
        "This view could not be saved. Check browser storage and try again; your current view is unchanged.",
      );
    }
  }
  function restoreView() {
    if (!audienceCurrent()) return;
    try {
      const value = readGraphView(savedKey!);
      if (!value) {
        setSaved(null);
        setViewNotice("No saved view is available for this document.");
        return;
      }
      setCenters(value.centers);
      setDepth(value.depth);
      setMode(value.mode);
      setRelation(value.relation);
      setSearch(value.search);
      setCamera(value.camera);
      setViewNotice(
        "Saved settings restored. Connections are checked against your current access.",
      );
      void query.refetch();
    } catch {
      setViewNotice(
        "The saved view could not be read. Your current view is unchanged.",
      );
    }
  }
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
    if (!graph) return graph;
    const relatedEdges = relation
      ? graph.edges.filter((edge) => edge.relationship === relation)
      : graph.edges;
    const relatedIds = new Set([
      center,
      ...relatedEdges.flatMap((edge) => [edge.source, edge.target]),
    ]);
    const term = search.trim().toLocaleLowerCase();
    const nodes = graph.nodes.filter(
      (node) =>
        (!relation || relatedIds.has(node.id)) &&
        (node.id === center ||
          !term ||
          `${node.title} ${node.path ?? ""} ${node.tags.join(" ")}`
            .toLocaleLowerCase()
            .includes(term)),
    );
    const ids = new Set(nodes.map((node) => node.id));
    return {
      ...graph,
      nodes,
      edges: relatedEdges.filter(
        (edge) => ids.has(edge.source) && ids.has(edge.target),
      ),
    };
  }, [graph, relation, search, center]);
  function focus(id: string) {
    if (id === center) return;
    setCenters((old) => [...old.slice(-49), id]);
    setCamera(defaultGraphCamera());
    setRelation("");
    setSearch("");
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
          leafTitle(note.path, note.metadata) || current.title,
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
      data-no-edge-swipe
      className={`prism-graph flex h-full min-h-0 flex-col bg-[var(--bg-surface)] text-[var(--text-primary)] ${fullscreen ? "prism-graph--full" : ""}`}
    >
      <header className="prism-graph__header">
        <div className="flex items-center gap-2">
          {centers.length > 1 && (
            <button
              className={controlClass}
              aria-label="Previous graph focus"
              onClick={() => {
                setCenters((old) => old.slice(0, -1));
                setCamera(defaultGraphCamera());
                setRelation("");
                setSearch("");
              }}
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="prism-graph__eyebrow">Connected knowledge</p>
            <h3 className="prism-graph__title">
              {current?.title ?? "Explore this document"}
            </h3>
          </div>
          {!fullscreen && (
            <button
              className={controlClass}
              aria-label="Expand graph"
              onClick={(event) => {
                event.currentTarget.focus();
                useUIStore.getState().setGraphFullscreen(true);
              }}
            >
              <Maximize2 size={15} />
            </button>
          )}
        </div>
        <div className="prism-graph__toolbar">
          <div
            role="group"
            aria-label="Graph view"
            className="prism-graph__views"
          >
            {(["2D", "List", "3D"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={mode === value}
                className="focus-ring"
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
        <div className="prism-graph__filters">
          <label className="prism-graph__search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="Search loaded connections"
              placeholder="Find in these connections…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
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
        </div>
        <details className="prism-graph__saved">
          <summary>Saved view</summary>
          <p>
            Keep this document’s focus, filters and 2D position on this device.
            Connections stay live. Up to 50 document views are kept.
          </p>
          <div>
            <button
              className={controlClass}
              disabled={!savedKey || !graph?.nodes.length}
              onClick={() => saveView()}
            >
              Save current view
            </button>
            <button
              className={controlClass}
              disabled={!saved}
              onClick={restoreView}
            >
              Restore saved view
            </button>
            {saved && (
              <button className={controlClass} onClick={() => saveView(true)}>
                Remove saved view
              </button>
            )}
          </div>
          {!savedKey && (
            <p>Saving views needs a known workspace and account.</p>
          )}
          {viewNotice && <p role="status">{viewNotice}</p>}
        </details>
        {search.trim() && (
          <p className="prism-graph__search-hint">
            Searching loaded titles, paths and tags. Current focus stays
            visible.
          </p>
        )}
        {center !== noteId && (
          <button
            className="focus-ring text-xs text-[var(--color-accent)]"
            onClick={() => {
              setCenters([noteId]);
              setCamera(defaultGraphCamera());
              setRelation("");
              setSearch("");
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
                {search.trim() || relation
                  ? "No connections match these filters. Clear the search or choose another relationship."
                  : "No connections yet. Link this document to another note to start exploring."}
              </p>
            )}
            {mode === "List" ? (
              <GraphList graph={filtered} center={center} onFocus={focus} />
            ) : mode === "2D" ? (
              <GraphMap
                camera={camera}
                setCamera={setCamera}
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
          {mode === "2D" &&
            filtered &&
            filtered.nodes.length > (size.width < 600 ? 5 : 9) && (
              <p className="text-xs text-[var(--text-secondary)]">
                Map shows {size.width < 600 ? 5 : 9} of {filtered.nodes.length}{" "}
                documents. List view includes all loaded documents.
              </p>
            )}
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
              className="prism-graph__row focus-ring"
              aria-label={`Focus ${node.title}`}
              aria-current={node.id === center ? "true" : undefined}
              onClick={() => onFocus(node.id)}
            >
              <FileText
                size={18}
                className="prism-graph__row-icon"
                aria-hidden="true"
              />
              <span className="prism-graph__row-content">
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
                {node.tags.length > 0 && (
                  <span className="prism-graph__tags">
                    {node.tags.map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function narrowNodeLabel(title: string): string[] {
  if (title.length <= 14) return [title];
  const space = title.lastIndexOf(" ", 14);
  const cut = space > 0 ? space : 14;
  const rest = title.slice(cut).trimStart();
  return [
    title.slice(0, cut),
    rest.length > 16 ? rest.slice(0, 15) + "…" : rest,
  ];
}

function GraphMap({
  camera,
  setCamera,
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
  camera: GraphCamera;
  setCamera: Dispatch<SetStateAction<GraphCamera>>;
}) {
  const arrow = useId().replace(/:/g, "");
  const h = Math.max(460, Math.min(height, 900));
  const zoom = camera.zoom;
  const pan = { x: camera.x * width, y: camera.y * h };
  const setZoom = (next: number | ((value: number) => number)) =>
    setCamera((old) => ({
      ...old,
      zoom: typeof next === "function" ? next(old.zoom) : next,
    }));
  const setPan = (
    next:
      | { x: number; y: number }
      | ((value: { x: number; y: number }) => { x: number; y: number }),
  ) =>
    setCamera((old) => {
      const value =
        typeof next === "function"
          ? next({ x: old.x * width, y: old.y * h })
          : next;
      return {
        ...old,
        x: Math.max(-20, Math.min(20, value.x / width)),
        y: Math.max(-20, Math.min(20, value.y / h)),
      };
    });
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const maxNodes = width < 600 ? 5 : 9;
  const nodes = [...graph.nodes]
    .sort((a, b) =>
      a.id === center
        ? -1
        : b.id === center
          ? 1
          : a.title.localeCompare(b.title),
    )
    .slice(0, maxNodes);
  const radius = Math.max(85, Math.min(width * 0.31, (h - 100) * 0.42));
  const positions = new Map(
    nodes.map((node, i) => {
      const angle =
        ((i - 1) * Math.PI * 2) / Math.max(1, nodes.length - 1) -
        (width < 600 && nodes.length > 3 ? Math.PI / 4 : Math.PI / 2);
      return [
        node.id,
        {
          node,
          x: i === 0 ? width / 2 : width / 2 + Math.cos(angle) * radius,
          y:
            i === 0
              ? h / 2
              : h / 2 +
                Math.sin(angle) *
                  (width < 600 ? Math.min((h - 130) * 0.43, 220) : radius),
        },
      ] as const;
    }),
  );
  return (
    <div className="prism-graph__map relative">
      <div className="prism-graph__map-controls absolute right-3 top-3 z-10 flex gap-1">
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
            <g key={i}>
              <line
                x1={a.x + (dx / length) * 26}
                y1={a.y + (dy / length) * 26}
                x2={b.x - (dx / length) * 29}
                y2={b.y - (dy / length) * 29}
                stroke="var(--text-muted)"
                strokeOpacity=".35"
                strokeWidth="1.2"
                markerEnd={`url(#${arrow})`}
              >
                <title>
                  {a.node.title} → {edge.relationship} → {b.node.title}
                </title>
              </line>
              {graph.edges.length <= 8 && width >= 600 && (
                <text
                  x={(a.x + b.x) / 2}
                  y={(a.y + b.y) / 2 - 7}
                  textAnchor="middle"
                  fill="var(--text-secondary)"
                  fontSize="11"
                  paintOrder="stroke"
                  stroke="var(--bg-surface)"
                  strokeWidth="5"
                  strokeLinejoin="round"
                >
                  {edge.relationship.length > 24
                    ? edge.relationship.slice(0, 23) + "…"
                    : edge.relationship}
                </text>
              )}
            </g>
          );
        })}
        {[...positions.values()].map(({ node, x, y }) => (
          <g
            key={node.id}
            role="button"
            aria-label={`Focus ${node.title}`}
            tabIndex={0}
            className="prism-graph__node focus-ring cursor-pointer"
            onClick={() => onFocus(node.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onFocus(node.id);
              }
            }}
          >
            <title>{node.path ?? node.title}</title>
            <circle cx={x} cy={y} r={27} fill="var(--bg-surface)" />
            <circle
              cx={x}
              cy={y}
              r={node.id === center ? 25 : 22}
              fill={
                node.id === center
                  ? "color-mix(in srgb, var(--color-accent) 12%, var(--bg-surface))"
                  : "var(--bg-elevated)"
              }
              stroke={
                node.id === center
                  ? "var(--color-accent)"
                  : "var(--glass-border)"
              }
              strokeWidth={node.id === center ? 2 : 1}
            />
            <g
              transform={`translate(${x - 9} ${y - 10})`}
              fill="none"
              stroke={
                node.id === center
                  ? "var(--color-accent)"
                  : "var(--text-secondary)"
              }
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 0h8l4 4v16H3z M11 0v5h4 M6 10h6 M6 14h6" />
            </g>
            <text
              x={x}
              y={y + 43}
              textAnchor="middle"
              fill="var(--text-primary)"
              fontSize="12"
              fontWeight={node.id === center ? 600 : 400}
              paintOrder="stroke"
              stroke="var(--bg-surface)"
              strokeWidth="4"
              strokeLinejoin="round"
            >
              {width < 600 && node.id !== center
                ? narrowNodeLabel(node.title).map((line, index) => (
                    <tspan key={index} x={x} dy={index ? 16 : 0}>
                      {line}
                    </tspan>
                  ))
                : node.title.length > 25
                  ? node.title.slice(0, 24) + "…"
                  : node.title}
            </text>
          </g>
        ))}
      </svg>
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
