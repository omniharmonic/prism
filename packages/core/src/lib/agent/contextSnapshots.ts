/** Wire contract shared by browser/native and the admission service. */
export const MAX_CONTEXT_SNAPSHOTS = 3;
export const SNAPSHOT_MAX_CHARACTERS = 8000;
export interface AgentContextSnapshot {
  kind: "selection" | "document" | "file";
  label: string;
  noteId?: string;
  text: string;
  capturedAt: string;
  baseUpdatedAt?: string | null;
  truncated: boolean;
}
export function validContextSnapshots(
  value: unknown,
): value is AgentContextSnapshot[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CONTEXT_SNAPSHOTS &&
    value.every((s) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) return false;
      if (!["selection", "document", "file"].includes(s.kind)) return false;
      if (
        typeof s.label !== "string" ||
        !s.label.trim() ||
        s.label.length > 200
      )
        return false;
      if (
        typeof s.text !== "string" ||
        !s.text.trim() ||
        s.text.length > SNAPSHOT_MAX_CHARACTERS
      )
        return false;
      if (
        typeof s.capturedAt !== "string" ||
        s.capturedAt.length > 40 ||
        !Number.isFinite(Date.parse(s.capturedAt))
      )
        return false;
      if (typeof s.truncated !== "boolean") return false;
      if (
        s.baseUpdatedAt !== undefined &&
        s.baseUpdatedAt !== null &&
        (typeof s.baseUpdatedAt !== "string" || s.baseUpdatedAt.length > 100)
      )
        return false;
      return s.kind === "file"
        ? s.noteId === undefined
        : typeof s.noteId === "string" &&
            !!s.noteId &&
            s.noteId.length <= 200 &&
            !/[\s\x00-\x1f]/.test(s.noteId);
    })
  );
}
/** Copy explicit fields so arbitrary client objects cannot expand stored context. */
export function canonicalSnapshot(
  s: AgentContextSnapshot,
): AgentContextSnapshot {
  return {
    kind: s.kind,
    label: s.label,
    text: s.text,
    capturedAt: s.capturedAt,
    truncated: s.truncated,
    ...(s.noteId
      ? { noteId: s.noteId, baseUpdatedAt: s.baseUpdatedAt ?? null }
      : {}),
  };
}
