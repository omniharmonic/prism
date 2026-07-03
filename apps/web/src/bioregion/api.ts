/**
 * Read client for the bioregional graph. Talks to the gateway (session cookie,
 * no token) — the owner gets full passthrough, a member gets their granted
 * slice, exactly like the rest of the web shell.
 */
export interface BioNote {
  id: string;
  content: string;
  path: string | null;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
}

/** The map/browse-worthy bioregional types (Plan 2 §2). */
export const BIO_TAGS = ["ecological-entity", "species", "watershed", "place", "signal", "resource", "event"] as const;
export type BioTag = (typeof BIO_TAGS)[number];

async function notesByTag(tag: string): Promise<BioNote[]> {
  const r = await fetch(`/api/notes?tag=${encodeURIComponent(tag)}&include_content=true`, { credentials: "include" });
  if (!r.ok) return [];
  const data = (await r.json()) as BioNote[];
  return Array.isArray(data) ? data : [];
}

export interface BioEntity {
  id: string;
  tag: BioTag;
  name: string;
  sensing: string; // sense | respond | both | ""
  geometry: unknown | null;
  geo: { lat: number; lon: number } | null;
  status: string;
}

const str = (m: Record<string, unknown> | null, k: string): string => {
  const v = m?.[k];
  return typeof v === "string" ? v : "";
};

/** Derive a display name from metadata/content/path. */
function nameOf(n: BioNote): string {
  const m = n.metadata;
  return (
    str(m, "name") ||
    str(m, "title") ||
    str(m, "scientificName") ||
    str(m, "hucName") ||
    n.content.split("\n")[0]?.replace(/^#\s*/, "").slice(0, 80) ||
    n.path?.split("/").pop() ||
    n.id
  );
}

function toEntity(n: BioNote, tag: BioTag): BioEntity {
  const m = n.metadata;
  const geo = m?.geo && typeof m.geo === "object" ? (m.geo as { lat?: number; lon?: number }) : null;
  return {
    id: n.id,
    tag,
    name: nameOf(n),
    sensing: str(m, "sensing_or_responding"),
    geometry: m?.geometry ?? m?.boundaryGeometry ?? m?.rangeGeometry ?? null,
    geo: geo && typeof geo.lat === "number" && typeof geo.lon === "number" ? { lat: geo.lat, lon: geo.lon } : null,
    status: str(m, "status") || str(m, "severity"),
  };
}

/** Load all in-scope bioregional entities across the mapped types. */
export async function loadBioregion(): Promise<BioEntity[]> {
  const lists = await Promise.all(BIO_TAGS.map(async (t) => (await notesByTag(t)).map((n) => toEntity(n, t))));
  // A note may carry several bio tags; keep the first (most specific by BIO_TAGS order).
  const seen = new Set<string>();
  const out: BioEntity[] = [];
  for (const e of lists.flat()) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}
