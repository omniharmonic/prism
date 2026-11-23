// Wire safety for Comms responses (final wave I2a). The Swift client decodes strictly:
// one lone UTF-16 surrogate anywhere (JSON.stringify writes it as "\ud83d") fails the
// whole page. Every text cut goes through clipText (grapheme, else code-point boundary)
// and every response passes wellFormedDeep on its way out.

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ANY_SURROGATE = /[\ud800-\udfff]/;
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** How far back from the cut we look for a grapheme boundary. */
const WINDOW = 32;

/** The string with every lone surrogate replaced by U+FFFD (String.prototype.toWellFormed). */
export function wellFormed(s: string): string {
  return ANY_SURROGATE.test(s) ? s.replace(LONE, "�") : s;
}

/** At most `n` UTF-16 units, cut on a grapheme boundary (an emoji, flag or ZWJ family is
 *  never split); a grapheme longer than the look-back window is cut on a code point. A
 *  trailing lone high surrogate (left by an earlier UTF-16 cut) is dropped. Well-formed. */
export function clipText(s: string, n: number): string {
  let out = s;
  if (s.length > n) {
    const start = Math.max(0, n - WINDOW);
    let cut = -1;
    for (const g of seg.segment(s.slice(start, Math.min(s.length, n + WINDOW)))) {
      const end = start + g.index + g.segment.length;
      if (end > n) break;
      cut = end;
    }
    if (cut <= start && start > 0) cut = -1; // no boundary inside the window
    if (cut < 0) {
      cut = n;
      const c = s.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
    }
    out = s.slice(0, cut);
  }
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return wellFormed(out);
}

/** A deep copy with every string made well-formed (keys included). Plain JSON data only. */
export function wellFormedDeep<T>(v: T): T {
  if (typeof v === "string") return wellFormed(v) as T;
  if (Array.isArray(v)) return v.map((x) => wellFormedDeep(x)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[wellFormed(k)] = wellFormedDeep(x);
    return out as T;
  }
  return v;
}
