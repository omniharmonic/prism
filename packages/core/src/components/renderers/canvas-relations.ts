/** Portable authored-arrow intent. Derived overlays and decorative arrows never assert links. */
export interface CanvasRelation {
  arrowId: string;
  sourceId: string;
  targetId: string;
  relationship: string;
}
export function canvasRelations(elements: readonly any[]): CanvasRelation[] {
  if (!Array.isArray(elements) || elements.length > 50_000)
    throw Error("Canvas is too large to reconcile");
  const byId = new Map(
    elements.filter((e) => e && typeof e.id === "string").map((e) => [e.id, e]),
  );
  const labels = new Map(
    elements
      .filter(
        (e) =>
          e?.type === "text" &&
          !e.isDeleted &&
          typeof e.containerId === "string",
      )
      .map((e) => [e.containerId, e]),
  );
  const result: CanvasRelation[] = [];
  for (const el of elements) {
    if (
      el?.type !== "arrow" ||
      el.isDeleted ||
      el.customData?.prismLinkViz ||
      el.customData?.prismRelationship === false
    )
      continue;
    const from = byId.get(el.startBinding?.elementId),
      to = byId.get(el.endBinding?.elementId);
    if (
      from?.type !== "rectangle" ||
      to?.type !== "rectangle" ||
      from.isDeleted ||
      to.isDeleted
    )
      continue;
    const sourceId = from.customData?.prismNoteId,
      targetId = to.customData?.prismNoteId;
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const label = labels.get(el.id);
    const relationship =
      (label?.originalText ?? label?.text ?? "").trim() || "related";
    if (
      [el.id, sourceId, targetId].some(
        (v) =>
          typeof v !== "string" ||
          !v ||
          v.length > 2048 ||
          /[\u0000-\u001f]/.test(v),
      ) ||
      typeof relationship !== "string" ||
      relationship.length > 128 ||
      /[\u0000-\u001f]/.test(relationship)
    )
      throw Error("Invalid canvas relationship");
    result.push({ arrowId: el.id, sourceId, targetId, relationship });
  }
  if (
    result.length > 250 ||
    new Set(result.map((r) => r.arrowId)).size !== result.length
  )
    throw Error("Canvas relationship limit reached");
  return result.sort((a, b) => a.arrowId.localeCompare(b.arrowId));
}
export const canvasRelationFingerprint = (elements: readonly any[]) =>
  JSON.stringify(canvasRelations(elements));
