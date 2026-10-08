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

const LINEAR_TYPES = new Set(["line", "arrow", "freedraw"]);

/** Excalidraw's fractional order key (base62, the head letter gives the integer part's length). */
export function isValidOrderKey(key: unknown): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 200) return false;
  if (!/^[0-9A-Za-z]+$/.test(key)) return false;
  const head = key.charCodeAt(0);
  const intLength = head >= 97 && head <= 122 ? head - 97 + 2 : head >= 65 && head <= 90 ? 90 - head + 2 : 0;
  if (intLength === 0 || key.length < intLength) return false;
  return key.length === intLength || key[key.length - 1] !== "0";
}

/**
 * The elements of a live canvas, made safe to HAND to Excalidraw — never written
 * back. A collaborative map can hold what another client, an older version, an
 * agent or a hand-edited scene put there; Excalidraw 0.18 throws in its RENDER
 * loop on some of it ("invalid order key", a line without `points`, an element
 * without a type), where no try/catch reaches and the whole canvas fails to open.
 * Here: a non-object or an element with no string id/type is left out, a linear
 * element without a points array is left out, and an invalid `index` is dropped
 * so Excalidraw assigns a fresh one. The CRDT keeps every entry as it is.
 */
export function paintableCanvasElements(elements: readonly unknown[]): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as Record<string, unknown>;
    if (typeof el.id !== "string" || !el.id || typeof el.type !== "string" || !el.type) continue;
    if (LINEAR_TYPES.has(el.type) && !Array.isArray(el.points)) continue;
    if (el.index !== undefined && el.index !== null && !isValidOrderKey(el.index)) {
      const { index: _dropped, ...rest } = el; // eslint-disable-line @typescript-eslint/no-unused-vars
      out.push(rest);
      continue;
    }
    out.push(el);
  }
  return out;
}
