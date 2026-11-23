/**
 * The /commons landing — a short orientation and the two doors into the commons.
 */
import { CommonsNav } from "./CommonsNav";

const card: React.CSSProperties = {
  display: "block",
  textDecoration: "none",
  color: "inherit",
  border: "1px solid rgba(128,128,128,0.3)",
  borderRadius: 14,
  padding: 22,
  margin: "16px 0",
  background: "rgba(128,128,128,0.04)",
};

export function CommonsLanding() {
  return (
    <div>
      <CommonsNav active="landing" />
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "32px 20px 80px", fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: "0 0 6px" }}>The Commons</h1>
        <p style={{ opacity: 0.75, marginTop: 0 }}>
          A bioregional knowledge commons: a cybernetic layer for sensing the health and threats of a place and
          coordinating the response — governed as a commons, not owned.
        </p>

        <a href="/bioregion" style={card}>
          <div style={{ fontSize: 20, fontWeight: 650 }}>🗺️ Bioregion →</div>
          <div style={{ opacity: 0.75, marginTop: 4 }}>
            Browse what's in the commons — ecological entities, species, watersheds, resources, and signals — on a map
            and by type. Filter by the cleavage: does it help us <b>sense</b> or <b>respond</b>?
          </div>
        </a>

        <a href="/governance" style={card}>
          <div style={{ fontSize: 20, fontWeight: 650 }}>⚖️ Governance →</div>
          <div style={{ opacity: 0.75, marginTop: 4 }}>
            The constitution and its lifecycle: roles, policies, and members; propose → sign off → apply; approval is
            distinct from publishing; a full audit trail. Once enabled, governance governs itself — even the owner.
          </div>
        </a>
      </div>
    </div>
  );
}
