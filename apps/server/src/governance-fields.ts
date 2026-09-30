/**
 * The shared, dependency-free vocabulary of governance NOTES: the tag names and
 * the defensive metadata coercers.
 *
 * It exists as its own module so that the parsers (`governance-store.ts`) and the
 * integrity signer (`governance-integrity.ts`) read metadata through the SAME
 * coercion functions. That is load-bearing for the signature's security argument:
 * every parser is a function of these coerced values, the signature covers these
 * coerced values, so two notes with the same signed projection necessarily parse
 * to the same governance structure. Keep it that way — a parser must never read a
 * metadata key through anything other than the helpers below, and never read a
 * key the signed projection (`governance-integrity.ts` `authorityProjection`)
 * does not cover.
 */

// ── the governance tag names (single source, mirrors tag-schemas.json) ─────────
export const GOV_TAGS = {
  config: "governance-config",
  role: "governance-role",
  membership: "governance-membership",
  policy: "governance-policy",
  proposal: "governance-proposal",
  vote: "governance-vote",
  audit: "governance-audit",
  revision: "governance-revision",
} as const;

export type GovTag = (typeof GOV_TAGS)[keyof typeof GOV_TAGS];

export const GOV_TAG_LIST: readonly GovTag[] = Object.values(GOV_TAGS);

export const isGovTag = (t: string): t is GovTag => (GOV_TAG_LIST as readonly string[]).includes(t);

// ── defensive coercion ────────────────────────────────────────────────────────
export type Meta = Record<string, unknown> | null | undefined;

export const str = (m: Meta, k: string, def = ""): string => {
  const v = m?.[k];
  return typeof v === "string" ? v : v == null ? def : String(v);
};
export const num = (m: Meta, k: string, def = 0): number => {
  const v = m?.[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return def;
};
export const bool = (m: Meta, k: string, def = false): boolean => {
  const v = m?.[k];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  return def;
};
export const strArr = (m: Meta, k: string): string[] => {
  const v = m?.[k];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x !== "");
  if (typeof v === "string" && v.trim() !== "") return v.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
};
