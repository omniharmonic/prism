/**
 * The bioregional commons browse surface (/bioregion): the map layer + a typed,
 * filterable list of what's in the commons. Reads through the gateway; renders
 * geometry as inline SVG. The `sensing_or_responding` filter makes the cleavage
 * — the reason a thing is in the commons — a first-class lens.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadBioregion, BIO_TAGS, type BioEntity, type BioTag } from "./api";
import { BioregionMap } from "./BioregionMap";

const s = {
  page: { maxWidth: 980, margin: "0 auto", padding: "32px 20px 80px", fontFamily: "system-ui, sans-serif" } as React.CSSProperties,
  h1: { fontSize: 26, fontWeight: 700, margin: "0 0 4px" } as React.CSSProperties,
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "12px 0" } as React.CSSProperties,
  chip: (on: boolean, color: string) =>
    ({ padding: "4px 12px", borderRadius: 999, border: `1px solid ${color}`, background: on ? color : "transparent", color: on ? "#fff" : "inherit", cursor: "pointer", fontSize: 13, fontWeight: 600 } as React.CSSProperties),
  li: { padding: "10px 0", borderTop: "1px solid rgba(128,128,128,0.18)", display: "flex", gap: 10, alignItems: "baseline" } as React.CSSProperties,
  tag: (color: string) => ({ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.4, minWidth: 128 } as React.CSSProperties),
  mono: { fontFamily: "ui-monospace, monospace", fontSize: 12, opacity: 0.7 } as React.CSSProperties,
};

const TAG_COLOR: Record<BioTag, string> = {
  "ecological-entity": "#2e7d32",
  species: "#00897b",
  watershed: "#1565c0",
  place: "#6a1b9a",
  signal: "#c62828",
  resource: "#ef6c00",
  event: "#455a64",
};

const SENSING = ["sense", "respond", "both"] as const;

export function BioregionPanel() {
  const [all, setAll] = useState<BioEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [tagFilter, setTagFilter] = useState<Set<BioTag>>(new Set());
  const [sensingFilter, setSensingFilter] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setAll(await loadBioregion());
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () =>
      all.filter(
        (e) =>
          (tagFilter.size === 0 || tagFilter.has(e.tag)) &&
          (sensingFilter.size === 0 || sensingFilter.has(e.sensing) || (e.sensing === "both" && sensingFilter.size > 0)),
      ),
    [all, tagFilter, sensingFilter],
  );

  const toggle = <T,>(set: Set<T>, v: T): Set<T> => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    return next;
  };

  if (loading) return <div style={s.page}>Loading the bioregion…</div>;

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Bioregional Commons</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        {all.length} entities · a cybernetic layer for sensing &amp; responding. Filter by type or by why it's in the commons.
      </p>

      <div style={s.row} data-testid="type-filters">
        {BIO_TAGS.map((t) => (
          <button key={t} style={s.chip(tagFilter.has(t), TAG_COLOR[t])} onClick={() => setTagFilter((f) => toggle(f, t))}>
            {t}
          </button>
        ))}
      </div>
      <div style={s.row} data-testid="sensing-filters">
        <span style={{ opacity: 0.6, fontSize: 13 }}>lens:</span>
        {SENSING.map((v) => (
          <button key={v} style={s.chip(sensingFilter.has(v), "#37474f")} onClick={() => setSensingFilter((f) => toggle(f, v))}>
            {v}
          </button>
        ))}
      </div>

      <BioregionMap entities={filtered} />

      <div style={{ marginTop: 20 }} data-testid="entity-list">
        <div style={{ fontWeight: 650, opacity: 0.75 }}>
          Showing <span data-testid="entity-count">{filtered.length}</span> of {all.length}
        </div>
        {filtered.map((e) => (
          <div key={e.id} style={s.li} data-entity-row={e.id}>
            <span style={s.tag(TAG_COLOR[e.tag])}>{e.tag}</span>
            <span style={{ flex: 1 }}>
              <b>{e.name}</b>
              {e.status ? <span style={{ ...s.mono, marginLeft: 8 }}>{e.status}</span> : null}
            </span>
            {e.sensing ? <span style={s.mono}>{e.sensing}</span> : null}
          </div>
        ))}
        {filtered.length === 0 && <p style={{ opacity: 0.6 }}>Nothing matches these filters.</p>}
      </div>
    </div>
  );
}
