/**
 * NP-AX measurements that run inside the page (touch targets, reflow, clipping, focus indicator).
 * Shared by `notion-a11y-touch.spec.ts`, `notion-a11y-reflow.spec.ts` and `notion-a11y-keyboard.spec.ts`.
 * Every function is self-contained (it is serialised into the page).
 */
import type { Page } from "@playwright/test";

export const CONTROLS = 'button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=tab], input, select, textarea, [tabindex]:not([tabindex="-1"])';
/** Third-party widgets (their own chrome) and inline links inside running text (WCAG 2.5.8 inline exception). */
export const NOT_OURS = ".excalidraw, .EmojiPickerReact, .maplibregl-map";

export type TargetOffender = { what: string; size: string; why: string };

/**
 * A control passes when
 *  (a) its box is ≥ 44×44, or
 *  (b) its effective hit area is ≥ 44×44 (hit-slop, measured outward from its centre; it need not be centred), or
 *  (c) its box is ≥ 24×24 and no OTHER control lies inside the 44×44 square centred on it (spacing).
 */
export function touchTargets(page: Page, scaffold: string[] = []): Promise<TargetOffender[]> {
  return page.evaluate(({ CONTROLS, NOT_OURS, scaffold }) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const visible = (el: Element) => {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility !== "visible" || st.pointerEvents === "none") return false;
      for (let p: Element | null = el; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.display === "none" || (p as HTMLElement).inert || p.getAttribute("aria-hidden") === "true") return false;
      }
      return true;
    };
    const box = (el: Element) => {
      let r = el.getBoundingClientRect();
      // A checkbox / radio / file input inside a label: the label is the target.
      const label = el.matches("input") ? el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null) : null;
      if (label) { const l = label.getBoundingClientRect(); if (l.width * l.height > r.width * r.height) r = l; }
      return r;
    };
    const all = Array.from(document.querySelectorAll<HTMLElement>(CONTROLS)).filter((el) => {
      if (el.closest(NOT_OURS)) return false;
      // Fixture scaffolding (buttons the test page adds around the product UI).
      if (scaffold.includes((el.getAttribute("aria-label") || el.textContent || "").trim()) && !el.className) return false;
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (el.matches("input[type=hidden]")) return false;
      // An opener whose popup is open sits beside/under its own popup; it is measured closed elsewhere.
      if (el.getAttribute("aria-expanded") === "true") return false;
      if (!visible(el)) return false;
      const r = box(el);
      if (r.width < 2 || r.height < 2) return false; // visually hidden (file inputs, sr-only)
      // Inline links in running text.
      if (el.matches("a[href]") && getComputedStyle(el).display.startsWith("inline") && el.closest("p, li, .ProseMirror, .tiptap, td, blockquote, dd")) return false;
      // The editor body and other big regions are not "controls".
      if (el.matches(".ProseMirror, .tiptap, [contenteditable=true]") && r.width > 200) return false;
      return true;
    });
    const boxes = all.map((el) => ({ el, r: box(el) }));
    const out: TargetOffender[] = [];
    for (const { el, r } of boxes) {
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      // Only what a person can reach right now: on screen and not covered by another layer.
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
      const hit = document.elementFromPoint(cx, cy);
      const mine = (h: Element | null) => !!h && (el.contains(h) || h.contains(el) && h.closest(CONTROLS) === el || (el.matches("input") && !!h.closest("label")?.contains(el)));
      if (!hit || !(el.contains(hit) || mine(hit))) continue; // covered (a dialog above it) or clipped by a scroller
      // (b) hit-slop: how far the hit area really extends from the centre, each way (it need not be
      // centred — the phone block handle grows to the left only, away from the text).
      const reach = (dx: number, dy: number) => {
        let d = 0;
        for (; d < 44; d += 2) {
          const x = cx + dx * (d + 2), y = cy + dy * (d + 2);
          if (x < 0 || y < 0 || x >= vw || y >= vh) return 44; // the screen edge: nothing else can be there
          if (!mine(document.elementFromPoint(x, y))) break;
        }
        return d;
      };
      const slop = reach(-1, 0) + reach(1, 0) >= 42 && reach(0, -1) + reach(0, 1) >= 42;
      if (slop) continue;
      // (c) spacing
      const sq = { l: cx - 22, t: cy - 22, r: cx + 22, b: cy + 22 };
      const crowd = boxes.find((o) => o.el !== el && !o.el.contains(el) && !el.contains(o.el) && o.r.left < sq.r && o.r.right > sq.l && o.r.top < sq.b && o.r.bottom > sq.t
        && (() => { const h = document.elementFromPoint(Math.min(vw - 1, Math.max(0, o.r.left + o.r.width / 2)), Math.min(vh - 1, Math.max(0, o.r.top + o.r.height / 2))); return !!h && (o.el.contains(h) || h.contains(o.el)); })());
      if (r.width >= 23.5 && r.height >= 23.5 && !crowd) continue;
      const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || (el as HTMLInputElement).placeholder || "").trim().replace(/\s+/g, " ").slice(0, 40);
      out.push({
        what: `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : ""} "${name}"`,
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        why: crowd ? `next to "${(crowd.el.getAttribute("aria-label") || crowd.el.textContent || crowd.el.tagName).trim().slice(0, 30)}"` : "smaller than 24x24",
      });
    }
    return out;
  }, { CONTROLS, NOT_OURS, scaffold });
}

/**
 * NP-AX-07 below the first screenful: `touchTargets` judges only what a person can reach right
 * now (on screen, not covered). This scrolls every vertically scrolling region of the TOP layer
 * (the open dialog / sheet if there is one, else the page) a screenful at a time — keeping two
 * rows of overlap so nothing hides under a sticky bar — and measures again at each stop.
 * Offenders are reported once each. Scroll positions are put back.
 */
export async function touchTargetsBelowFold(page: Page, scaffold: string[] = [], maxSteps = 10): Promise<TargetOffender[]> {
  const count = await page.evaluate((NOT_OURS) => {
    const shown = (el: Element) => { const st = getComputedStyle(el); return st.display !== "none" && st.visibility === "visible" && el.getClientRects().length > 0; };
    const layers = Array.from(document.querySelectorAll<HTMLElement>("dialog[open], [role=dialog], .prism-mobile-sheet")).filter(shown);
    const root: Element = layers[layers.length - 1] ?? document.body;
    const candidates = [document.scrollingElement as Element, root, ...Array.from(root.querySelectorAll("*"))];
    const scrollers = candidates.filter((el, i) => {
      if (!el || candidates.indexOf(el) !== i || el.closest(NOT_OURS) || !shown(el)) return false;
      if (el.matches("textarea, input, select, .ProseMirror, .tiptap, pre, code")) return false;
      const st = getComputedStyle(el);
      const scrolls = el === document.scrollingElement || st.overflowY === "auto" || st.overflowY === "scroll";
      return scrolls && el.clientHeight >= 120 && el.scrollHeight > el.clientHeight + 40;
    });
    scrollers.forEach((el, i) => { el.setAttribute("data-a11y-scroller", String(i)); el.setAttribute("data-a11y-scroll-start", String(el.scrollTop)); });
    return scrollers.length;
  }, NOT_OURS);
  const found = new Map<string, TargetOffender>();
  for (let i = 0; i < count; i++) {
    for (let step = 0; step < maxSteps; step++) {
      const moved = await page.evaluate((i) => {
        const el = document.querySelector(`[data-a11y-scroller="${i}"]`);
        if (!el) return false;
        const before = el.scrollTop;
        el.scrollTop = before + Math.max(120, el.clientHeight - 96);
        return el.scrollTop > before + 1;
      }, i);
      if (!moved) break;
      await page.waitForTimeout(120); // lazy rows, sticky headers settling
      for (const o of await touchTargets(page, scaffold)) if (!found.has(o.what)) found.set(o.what, o);
    }
    // Back to where it was before the next scroller is tried (an outer scroller must not hide an inner one).
    await page.evaluate((i) => { const el = document.querySelector(`[data-a11y-scroller="${i}"]`); if (el) el.scrollTop = Number(el.getAttribute("data-a11y-scroll-start") ?? 0); }, i);
  }
  await page.evaluate(() => document.querySelectorAll("[data-a11y-scroller]").forEach((el) => { el.removeAttribute("data-a11y-scroller"); el.removeAttribute("data-a11y-scroll-start"); }));
  return [...found.values()];
}

export type ReflowReport = { pageScroll: string[]; offscreen: string[]; overlap: string[] };

/** No horizontal page scroll, nothing pushed off the side, no control sitting on another control. */
export function reflow(page: Page): Promise<ReflowReport> {
  return page.evaluate(({ CONTROLS, NOT_OURS }) => {
    const vw = document.documentElement.clientWidth;
    const desc = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : ""} "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30)}"`;
    const pageScroll: string[] = [];
    const se = document.scrollingElement!;
    if (se.scrollWidth > se.clientWidth + 1) pageScroll.push(`document ${se.scrollWidth} > ${se.clientWidth}`);
    if (document.body.scrollWidth > vw + 1) pageScroll.push(`body ${document.body.scrollWidth} > ${vw}`);
    // Regions that must not scroll sideways as a whole (their inner tables/boards/code may).
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("main, [role=main], [role=dialog], dialog[open], nav, aside, [role=complementary]"))) {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility !== "visible" || !el.getClientRects().length) continue;
      if (el.scrollWidth > el.clientWidth + 1 && (st.overflowX === "auto" || st.overflowX === "scroll")) pageScroll.push(`${desc(el)} scrolls sideways ${el.scrollWidth} > ${el.clientWidth}`);
    }
    /** Inside something that scrolls (or deliberately clips) sideways on its own: allowed. */
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const st = getComputedStyle(p);
        if ((st.overflowX === "auto" || st.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1) return true;
        if (st.position === "fixed" && (st.overflowX === "hidden" || st.overflowX === "clip")) break;
      }
      return false;
    };
    const shown = (el: Element) => {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility !== "visible" || Number(st.opacity) === 0) return false;
      for (let p: Element | null = el; p; p = p.parentElement) if ((p as HTMLElement).inert || p.getAttribute("aria-hidden") === "true") return false;
      const r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2;
    };
    const controls = Array.from(document.querySelectorAll<HTMLElement>(CONTROLS)).filter((el) => !el.closest(NOT_OURS) && shown(el));
    const offscreen: string[] = [];
    const overlap: string[] = [];
    const top = (el: Element, x: number, y: number) => { const h = document.elementFromPoint(x, y); return !!h && (el.contains(h) || h.contains(el)); };
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if ((r.right > vw + 1 || r.left < -1) && !inScroller(el)) {
        // Off-canvas drawers that are closed sit fully outside on purpose.
        if (r.left >= vw || r.right <= 0) continue;
        offscreen.push(`${desc(el)} [${Math.round(r.left)}…${Math.round(r.right)}] of ${vw}`);
        continue;
      }
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cx >= vw || cy < 0 || cy >= window.innerHeight) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || el.contains(hit) || hit.contains(el)) continue;
      const other = hit.closest(CONTROLS);
      // Covered by ANOTHER control of the same layer (not by a dialog/backdrop above it).
      if (other && other !== el && !other.contains(el) && !el.contains(other) && !inScroller(el)) {
        const layer = (a: Element) => a.closest("[role=dialog], dialog, [role=menu], [role=listbox], .prism-mobile-sheet") ?? document.body;
        // Content that scrolls under a bar (sticky header, bottom navigation, composer) is not an overlap:
        // both controls must live in the same scroller, and neither may be pinned.
        const scroller = (a: Element) => { for (let p = a.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight + 1) return p; } return document.documentElement; };
        const pinned = (a: Element) => { for (let p: Element | null = a; p && p !== document.body; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === "fixed" || pos === "sticky") return true; } return false; };
        if (other.closest(NOT_OURS) || layer(el) !== layer(other) || scroller(el) !== scroller(other) || pinned(el) !== pinned(other)) continue;
        if (!top(el, r.left + 2, r.top + 2) && !top(el, r.right - 2, r.bottom - 2)) overlap.push(`${desc(el)} is under ${desc(other)}`);
      }
    }
    return { pageScroll, offscreen: offscreen.slice(0, 15), overlap: overlap.slice(0, 15) };
  }, { CONTROLS, NOT_OURS });
}

/** WCAG 1.4.12 text-spacing override. Returns the elements whose text is cut off only because of it. */
export async function textSpacingClips(page: Page): Promise<string[]> {
  const scan = () => page.evaluate((NOT_OURS) => {
    const out: Record<string, [number, number]> = {};
    let n = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      if (el.closest(NOT_OURS) || !el.getClientRects().length) continue;
      if (!Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.textContent!.trim())) continue;
      // The nearest box that clips this text.
      let clip: HTMLElement | null = el;
      for (; clip && clip !== document.body; clip = clip.parentElement) {
        const st = getComputedStyle(clip);
        if (st.overflowY === "hidden" || st.overflowY === "clip" || st.overflowX === "hidden" || st.overflowX === "clip") break;
      }
      if (!clip || clip === document.body) continue;
      const st = getComputedStyle(clip);
      const dy = (st.overflowY === "hidden" || st.overflowY === "clip") && !st.webkitLineClamp?.match(/\d/) ? clip.scrollHeight - clip.clientHeight : 0;
      const dx = (st.overflowX === "hidden" || st.overflowX === "clip") && st.textOverflow !== "ellipsis" && getComputedStyle(el).textOverflow !== "ellipsis" ? clip.scrollWidth - clip.clientWidth : 0;
      if (!clip.dataset.a11yProbe) clip.dataset.a11yProbe = String(++n) + ":" + `${clip.tagName.toLowerCase()}.${typeof clip.className === "string" ? clip.className.trim().split(/\s+/).slice(0, 3).join(".") : ""} "${(clip.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30)}"`;
      out[clip.dataset.a11yProbe] = [dx, dy];
    }
    return out;
  }, NOT_OURS);
  const before = await scan();
  await page.addStyleTag({ content: `* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }` });
  await page.waitForTimeout(150);
  const after = await scan();
  const clipped: string[] = [];
  for (const [key, [dx, dy]] of Object.entries(after)) {
    const was = before[key] ?? [0, 0];
    // Cut off by more than a hairline, and not already cut off before the override.
    if ((dy > 3 && was[1] <= 1) || (dx > 3 && was[0] <= 1)) clipped.push(`${key.replace(/^\d+:/, "")} clipped by ${Math.max(dx, 0)}x${Math.max(dy, 0)}`);
  }
  return clipped.slice(0, 20);
}

/** What the focused element shows for focus: an outline, a box-shadow ring, or a border/background change. */
export function focusIndicator(page: Page): Promise<{ what: string; visible: boolean; detail: string }> {
  return page.evaluate(() => {
    let el = document.activeElement as HTMLElement | null;
    // aria-activedescendant widgets show focus on the active descendant.
    const ad = el?.getAttribute("aria-activedescendant");
    const active = ad ? document.getElementById(ad) : null;
    const what = el ? `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30)}"` : "nothing";
    if (!el || el === document.body) return { what, visible: false, detail: "focus is on <body>" };
    const ring = (n: HTMLElement) => {
      const st = getComputedStyle(n);
      const outline = st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0 && st.outlineColor !== "rgba(0, 0, 0, 0)" && st.outlineColor !== "transparent";
      const shadow = st.boxShadow !== "none";
      return outline ? `outline ${st.outlineWidth} ${st.outlineStyle} ${st.outlineColor}` : shadow ? `box-shadow ${st.boxShadow.slice(0, 60)}` : "";
    };
    // Text fields and the editor show a caret; a ring on the field or on its wrapper also counts.
    const caret = el.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable=true], [contenteditable=''], select");
    let detail = ring(el) || (active ? ring(active) || (active.getAttribute("aria-selected") === "true" || active.matches("[data-active], [data-highlighted], .is-active, .active, .selected") ? "active descendant is marked" : "") : "");
    if (!detail) for (let p = el.parentElement, i = 0; p && i < 3 && !detail; p = p.parentElement, i++) if (p.matches(":focus-within")) { const r = ring(p); if (r && getComputedStyle(p).outlineStyle !== "none") detail = "wrapper " + r; }
    if (!detail && caret) detail = "caret";
    return { what, visible: !!detail, detail: detail || "no outline, no box-shadow" };
  });
}

// ── NP-AX-04: non-text contrast (WCAG 1.4.11) ─────────────────────────────────────────────────

export type NonTextFinding = { what: string; ratio: number; colors: string };
export type NonTextReport = {
  /** Measured and below 3 : 1. */
  low: NonTextFinding[];
  /** Looked at and at or above 3 : 1. */
  ok: number;
  /** Could not be judged from computed colours (a gradient / image / blur behind it, a native control, a soft shadow). */
  unmeasured: string[];
};

/**
 * The in-page toolkit both measurements use. Serialised into the page, so it is one string-free
 * function returning its helpers. Colours are resolved by PAINTING them (any CSS colour syntax —
 * `color-mix`, `oklch`, `color(srgb …)` — comes back as RGBA), then composited over what is behind.
 */
function installContrastKit(): void {
  const w = window as unknown as { __a11yContrast?: unknown };
  if (w.__a11yContrast) return;
  type RGBA = [number, number, number, number];
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const cache = new Map<string, RGBA>();
  const parse = (color: string): RGBA => {
    const hit = cache.get(color);
    if (hit) return hit;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const out: RGBA = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    cache.set(color, out);
    return out;
  };
  const over = (top: RGBA, under: RGBA): RGBA => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a <= 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a).concat(a) as RGBA;
  };
  const lum = (c: RGBA) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a: RGBA, b: RGBA) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
  const hex = (c: RGBA) => "#" + [0, 1, 2].map((i) => Math.round(c[i]!).toString(16).padStart(2, "0")).join("");
  /** The colour painted behind `el`'s box (its ancestors, composited). `null` when a gradient, an image or a blur is part of it. */
  const behind = (el: Element | null): RGBA | null => {
    const layers: RGBA[] = [];
    for (let p: Element | null = el; p; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (st.backgroundImage !== "none" || (st.backdropFilter && st.backdropFilter !== "none")) return null;
      const c = parse(st.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 0.999) break;
    }
    // The canvas itself: white, or near-black under a dark colour scheme.
    let base: RGBA = getComputedStyle(document.documentElement).colorScheme.includes("dark") && !document.documentElement.classList.contains("light") ? [18, 18, 20, 1] : [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i]!, base);
    return base;
  };
  const name = (el: Element) => `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${(el as HTMLInputElement).type && el.tagName === "INPUT" ? `[type=${(el as HTMLInputElement).type}]` : ""}${typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} "${(el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32)}"`;
  w.__a11yContrast = { parse, over, ratio, hex, behind, name };
}

/**
 * The FOCUS INDICATOR of the focused element against what it is drawn on: an outline, or a hard
 * ring made with `box-shadow` (no blur) — the most visible of them. ≥ 3 : 1 passes. `caret` says
 * the element is a text-entry field, where the caret (text-coloured) shows focus as well.
 */
export async function focusIndicatorContrast(page: Page): Promise<{ what: string; ratio: number | null; colors: string; how: string; /** A text-entry field: its caret also shows focus. */ caret?: boolean }> {
  await page.evaluate(installContrastKit);
  return page.evaluate(async (NOT_OURS) => {
    type RGBA = [number, number, number, number];
    const kit = (window as any).__a11yContrast as { parse(c: string): RGBA; over(a: RGBA, b: RGBA): RGBA; ratio(a: RGBA, b: RGBA): number; hex(c: RGBA): string; behind(el: Element | null): RGBA | null; name(el: Element): string };
    const focused = document.activeElement as HTMLElement | null;
    if (!focused || focused === document.body) return { what: "body", ratio: null, colors: "", how: "nothing focused" };
    const ad = focused.getAttribute("aria-activedescendant");
    const candidates: HTMLElement[] = [focused, ...(ad && document.getElementById(ad) ? [document.getElementById(ad)!] : [])];
    for (let p = focused.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) if (p.matches(":focus-within")) candidates.push(p);
    if (focused.closest(NOT_OURS)) return { what: kit.name(focused), ratio: null, colors: "", how: "third-party widget" };
    // A ring that fades or grows in is judged when it has arrived, not part-way.
    const moving = candidates.flatMap((el) => el.getAnimations()).map((a) => a.finished.catch(() => undefined));
    if (moving.length) await Promise.race([Promise.all(moving), new Promise((r) => setTimeout(r, 500))]);
    // Every candidate ring (an outline; each hard `box-shadow` ring — a control can carry a 1 px
    // hairline shadow AND a focus ring): the indicator is the one that stands out most.
    let best: { ratio: number; colors: string; how: string } | null = null;
    let blind = "";
    for (const el of candidates) {
      const st = getComputedStyle(el);
      const rings: Array<{ color: RGBA; how: string; inside: boolean }> = [];
      if (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0) {
        const c = kit.parse(st.outlineColor);
        if (c[3] > 0) rings.push({ color: c, how: `outline ${st.outlineWidth}`, inside: parseFloat(st.outlineOffset) < 0 });
      }
      if (st.boxShadow !== "none") {
        // Computed form: "<color> <x> <y> <blur> <spread>[ inset], …" — a ring is 0 0 0 <spread>.
        for (const part of st.boxShadow.split(/,(?![^(]*\))/)) {
          const m = part.trim().match(/^(.*?)\s(-?[\d.]+)px\s(-?[\d.]+)px\s([\d.]+)px\s(-?[\d.]+)px(\sinset)?$/);
          if (!m) continue;
          const [, color, x, y, blur, spread, inset] = m;
          if (Number(x) === 0 && Number(y) === 0 && Number(blur) === 0 && Number(spread) >= 1) { const c = kit.parse(color!); if (c[3] > 0) rings.push({ color: c, how: `box-shadow ring ${spread}px`, inside: !!inset }); }
        }
      }
      for (const ring of rings) {
        const bg = ring.inside ? kit.behind(el) : kit.behind(el.parentElement);
        if (!bg) { blind = `${ring.how} over a gradient / image`; continue; }
        const drawn = kit.over(ring.color, bg);
        const ratio = Math.round(kit.ratio(drawn, bg) * 100) / 100;
        if (!best || ratio > best.ratio) best = { ratio, colors: `${kit.hex(drawn)} on ${kit.hex(bg)}`, how: ring.how };
      }
    }
    const caret = focused.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]), textarea, [contenteditable=true], [contenteditable='']");
    if (best) return { what: kit.name(focused), ...best, caret };
    if (blind) return { what: kit.name(focused), ratio: null, colors: "", how: blind };
    return { what: kit.name(focused), ratio: null, colors: "", how: "no outline or hard ring (caret, soft shadow or a change of fill)" };
  }, NOT_OURS);
}

/**
 * The BOUNDARY of every visible form control (text field, select, textarea, custom checkbox /
 * switch / radio) against what is behind it: the best of its border and its own fill, also looking
 * at up to two wrappers that draw the box for it (a search field inside a bordered pill). ≥ 3 : 1
 * passes. Native checkboxes / radios / range inputs are drawn by the browser and not judged.
 */
export async function controlBoundaryContrast(page: Page): Promise<NonTextReport> {
  await page.evaluate(installContrastKit);
  return page.evaluate((NOT_OURS) => {
    type RGBA = [number, number, number, number];
    const kit = (window as any).__a11yContrast as { parse(c: string): RGBA; over(a: RGBA, b: RGBA): RGBA; ratio(a: RGBA, b: RGBA): number; hex(c: RGBA): string; behind(el: Element | null): RGBA | null; name(el: Element): string };
    const report: { low: Array<{ what: string; ratio: number; colors: string }>; ok: number; unmeasured: string[] } = { low: [], ok: 0, unmeasured: [] };
    const shown = (el: Element) => {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility !== "visible" || Number(st.opacity) < 0.05) return false;
      for (let p: Element | null = el; p; p = p.parentElement) if ((p as HTMLElement).inert || p.getAttribute("aria-hidden") === "true") return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
      return !!hit && (el.contains(hit) || hit.contains(el) || !!hit.closest("label")?.contains(el));
    };
    const controls = Array.from(document.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]):not([type=button]):not([type=submit]):not([type=reset]), textarea, select, [role=checkbox], [role=switch], [role=radio], [role=combobox]:not(input)'))
      .filter((el) => !el.closest(NOT_OURS) && !(el as HTMLInputElement).disabled && el.getAttribute("aria-disabled") !== "true" && shown(el));
    const seen = new Set<string>();
    for (const el of controls) {
      const what = kit.name(el);
      if (seen.has(what)) continue;
      seen.add(what);
      const rect = el.getBoundingClientRect();
      const boxes: Element[] = [el];
      // A wrapper that hugs the control may be the box a person sees.
      for (let p = el.parentElement, i = 0; p && i < 2; p = p.parentElement, i++) { const r = p.getBoundingClientRect(); if (r.height <= rect.height + 20 && r.width <= Math.max(rect.width * 3, rect.width + 120)) boxes.push(p); else break; }
      let best = 0, colors = "", blind = false;
      for (const box of boxes) {
        const bg = kit.behind(box.parentElement);
        if (!bg) { blind = true; continue; }
        const st = getComputedStyle(box);
        if (st.backgroundImage !== "none") { blind = true; continue; }
        const tries: Array<[string, RGBA]> = [];
        for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
          if (st[`border${side}Style` as "borderTopStyle"] !== "none" && parseFloat(st[`border${side}Width` as "borderTopWidth"]) > 0) tries.push(["border", kit.over(kit.parse(st[`border${side}Color` as "borderTopColor"]), bg)]);
        }
        if (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0) tries.push(["outline", kit.over(kit.parse(st.outlineColor), bg)]);
        tries.push(["fill", kit.over(kit.parse(st.backgroundColor), bg)]);
        for (const [how, c] of tries) { const r = kit.ratio(c, bg); if (r > best) { best = r; colors = `${how} ${kit.hex(c)} on ${kit.hex(bg)}`; } }
      }
      if (best === 0 && blind) { report.unmeasured.push(what); continue; }
      if (best >= 3) report.ok++;
      else report.low.push({ what, ratio: Math.round(best * 100) / 100, colors });
    }
    return report;
  }, NOT_OURS);
}

/** One box's BORDER against what is behind it (the composers show focus with their border, not a ring). */
export async function borderContrast(page: Page, selector: string): Promise<{ ratio: number | null; colors: string }> {
  await page.evaluate(installContrastKit);
  return page.evaluate((selector) => {
    type RGBA = [number, number, number, number];
    const kit = (window as any).__a11yContrast as { parse(c: string): RGBA; over(a: RGBA, b: RGBA): RGBA; ratio(a: RGBA, b: RGBA): number; hex(c: RGBA): string; behind(el: Element | null): RGBA | null };
    const el = document.querySelector(selector);
    const bg = el ? kit.behind(el.parentElement) : null;
    if (!el || !bg) return { ratio: null, colors: "" };
    const c = kit.over(kit.parse(getComputedStyle(el).borderTopColor), bg);
    return { ratio: Math.round(kit.ratio(c, bg) * 100) / 100, colors: `${kit.hex(c)} on ${kit.hex(bg)}` };
  }, selector);
}
