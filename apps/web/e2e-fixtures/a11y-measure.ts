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
 *  (b) its effective hit area is ≥ 44×44 (hit-slop: the points 21 px from its centre still land on it), or
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
      // (b) hit-slop
      const pts = [[-21, 0], [21, 0], [0, -21], [0, 21]];
      const slop = pts.every(([dx, dy]) => {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= vw || y >= vh) return true; // at the screen edge: nothing else can be there
        return mine(document.elementFromPoint(x, y));
      });
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
