/** Link previews are a local overlay, never authored canvas content. Older
 * canvases may contain preview labels without the flag on the label itself. */
export function authoredCanvasElements<T extends {
  id: string;
  containerId?: string | null;
  customData?: Record<string, unknown> | null;
  boundElements?: readonly { id: string; type: string }[] | null;
}>(elements: readonly T[]): T[] {
  const previews = new Set(elements.filter(e => e.customData?.prismLinkViz).map(e => e.id));
  for (const element of elements) {
    if (element.containerId && previews.has(element.containerId)) previews.add(element.id);
  }
  return elements.filter(e => !previews.has(e.id)).map(element => {
    if (!element.boundElements?.some(bound => previews.has(bound.id))) return element;
    return { ...element, boundElements: element.boundElements.filter(bound => !previews.has(bound.id)) };
  });
}
