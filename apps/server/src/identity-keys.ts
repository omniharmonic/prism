/**
 * Metadata keys that NAME a person (pure — no db/config imports, so export
 * engines like `worker/github-dir.ts` can use it). See `writer-stamp.ts`.
 */
export const IDENTITY_KEYS = ["prism_creator", "prism_last_writer", "prism_last_write_at", "prism_trashed_by"] as const;

/** A copy of `metadata` without anything that names a person (same object when none present). */
export function stripIdentity<T extends Record<string, unknown> | null | undefined>(metadata: T): T {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (!IDENTITY_KEYS.some((k) => k in metadata)) return metadata;
  const out: Record<string, unknown> = { ...metadata };
  for (const k of IDENTITY_KEYS) delete out[k];
  return out as T;
}
