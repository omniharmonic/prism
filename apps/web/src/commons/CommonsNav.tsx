/**
 * A minimal shared header for the commons surfaces (governance + bioregion), so
 * the two are reachable from each other and from a landing page without typing
 * URLs. Deliberately plain (the surfaces themselves are functional-first).
 */
const bar: React.CSSProperties = {
  display: "flex",
  gap: 4,
  alignItems: "center",
  padding: "10px 20px",
  borderBottom: "1px solid rgba(128,128,128,0.25)",
  position: "sticky",
  top: 0,
  background: "var(--bg, rgba(250,250,250,0.9))",
  backdropFilter: "blur(6px)",
  zIndex: 10,
  fontFamily: "system-ui, sans-serif",
};
const link = (active: boolean): React.CSSProperties => ({
  padding: "6px 12px",
  borderRadius: 8,
  textDecoration: "none",
  color: "inherit",
  fontWeight: active ? 700 : 500,
  background: active ? "rgba(128,128,128,0.15)" : "transparent",
});

export function CommonsNav({ active }: { active: "landing" | "bioregion" | "governance" }) {
  return (
    <nav style={bar} data-testid="commons-nav">
      <a href="/commons" style={{ ...link(active === "landing"), fontWeight: 700, marginRight: 8 }}>
        ⬡ Commons
      </a>
      <a href="/bioregion" style={link(active === "bioregion")}>
        Bioregion
      </a>
      <a href="/governance" style={link(active === "governance")}>
        Governance
      </a>
      <span style={{ flex: 1 }} />
      <a href="/" style={{ ...link(false), opacity: 0.7 }}>
        ← App
      </a>
    </nav>
  );
}
