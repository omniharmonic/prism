import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { PubGraph } from "./types";

/**
 * A lightweight, dependency-free force-directed graph of the publication's notes.
 *
 * It renders ONLY the nodes/edges from the publication-scoped, leak-proof
 * `/api/p/:slug/graph` endpoint (passed in via `graph`) — never the owner's full
 * vault graph — so it can never surface an out-of-set node. We run a tiny spring
 * simulation in an SVG (no three.js / canvas deps; the public bundle stays slim).
 * Clicking a node navigates in-app, the same routing the nav tree uses.
 */

const W = 300; // viewBox units; the SVG scales to its container width
const H = 300;
const MAX_NODES = 200; // safety cap (a public wiki is small; never render the world)

interface Pt {
  id: string;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function WikiGraph({
  graph,
  activeId,
  onNavigate,
}: {
  graph: PubGraph;
  activeId: string | null;
  onNavigate: (id: string) => void;
}) {
  const nodes = useMemo(() => graph.nodes.slice(0, MAX_NODES), [graph.nodes]);
  const ids = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const edges = useMemo(
    () => graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    [graph.edges, ids],
  );

  const ptsRef = useRef<Pt[]>([]);
  const [, setTick] = useState(0);
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // (Re)seed positions whenever the node set changes — spread on a circle so the
  // simulation untangles deterministically.
  useEffect(() => {
    const n = nodes.length;
    ptsRef.current = nodes.map((node, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      return {
        id: node.id,
        title: node.title,
        x: W / 2 + Math.cos(a) * 90,
        y: H / 2 + Math.sin(a) * 90,
        vx: 0,
        vy: 0,
      };
    });
    setTick((t) => t + 1);
  }, [nodes]);

  // Run the spring simulation with a decaying alpha; stop once it settles (or a
  // drag re-heats it). rAF-driven, fully torn down on unmount.
  useEffect(() => {
    if (nodes.length === 0) return;
    let alpha = 1;
    let raf = 0;
    const adj = edges.map((e) => [e.source, e.target] as const);

    const step = () => {
      const pts = ptsRef.current;
      const byId = new Map(pts.map((p) => [p.id, p]));
      // Repulsion (every pair pushes apart).
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i];
          const b = pts[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 0.01;
          }
          const f = (700 * alpha) / d2;
          const dist = Math.sqrt(d2);
          const fx = (dx / dist) * f;
          const fy = (dy / dist) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      // Springs (edges pull toward a rest length).
      for (const [s, t] of adj) {
        const a = byId.get(s);
        const b = byId.get(t);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (dist - 60) * 0.02 * alpha;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      // Centering gravity + integrate + damping. The dragged node is pinned.
      const dragged = dragRef.current?.id;
      for (const p of pts) {
        if (p.id === dragged) {
          p.vx = 0;
          p.vy = 0;
          continue;
        }
        p.vx += (W / 2 - p.x) * 0.01 * alpha;
        p.vy += (H / 2 - p.y) * 0.01 * alpha;
        p.vx *= 0.85;
        p.vy *= 0.85;
        p.x = Math.max(10, Math.min(W - 10, p.x + p.vx));
        p.y = Math.max(10, Math.min(H - 10, p.y + p.vy));
      }
      alpha *= 0.96;
      setTick((tk) => tk + 1);
      if (alpha > 0.02 || dragRef.current) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [nodes, edges]);

  // Pointer → viewBox coordinates (so dragging tracks the cursor under scaling).
  const toLocal = (e: PointerEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onPointerDown = (e: PointerEvent, id: string) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { id, moved: false };
    setTick((t) => t + 1); // re-heat the sim loop guard
  };
  const onPointerMove = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const loc = toLocal(e);
    if (!loc) return;
    const p = ptsRef.current.find((q) => q.id === drag.id);
    if (!p) return;
    drag.moved = true;
    p.x = Math.max(10, Math.min(W - 10, loc.x));
    p.y = Math.max(10, Math.min(H - 10, loc.y));
    setTick((t) => t + 1);
  };
  const onPointerUp = (e: PointerEvent, id: string) => {
    const drag = dragRef.current;
    dragRef.current = null;
    // A click (no meaningful drag) navigates.
    if (drag && !drag.moved) onNavigate(id);
    setTick((t) => t + 1);
    void e;
  };

  if (nodes.length === 0) {
    return <p style={{ color: "var(--text-muted, #777)", margin: 0, fontSize: 12 }}>No graph yet.</p>;
  }

  const pts = ptsRef.current;
  const byId = new Map(pts.map((p) => [p.id, p]));

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      style={{ display: "block", touchAction: "none", userSelect: "none" }}
      onPointerMove={onPointerMove}
      role="img"
      aria-label="Publication graph"
    >
      {edges.map((e, i) => {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) return null;
        const lit = activeId != null && (e.source === activeId || e.target === activeId);
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={lit ? "var(--accent, #4f8cff)" : "var(--glass-border, rgba(255,255,255,0.18))"}
            strokeWidth={lit ? 1.4 : 0.8}
          />
        );
      })}
      {pts.map((p) => {
        const active = p.id === activeId;
        return (
          <g
            key={p.id}
            transform={`translate(${p.x},${p.y})`}
            style={{ cursor: "pointer" }}
            onPointerDown={(e) => onPointerDown(e, p.id)}
            onPointerUp={(e) => onPointerUp(e, p.id)}
          >
            <title>{p.title}</title>
            <circle
              r={active ? 5 : 3.5}
              fill={active ? "var(--accent, #4f8cff)" : "var(--text-secondary, #aaa)"}
              stroke="var(--bg, #0e0e10)"
              strokeWidth={1}
            />
          </g>
        );
      })}
    </svg>
  );
}
