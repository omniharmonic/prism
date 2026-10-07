/**
 * Links to a heading (NOTION-GAP-DISCOVERY C.2): `<page link>#h-<slug>`.
 *
 * No block ids and nothing stored: the slug is derived from the heading's text, with the same
 * rule the published wiki uses for its table of contents (`apps/web/src/publish/templates/
 * wiki-utils.ts` `slugify` + `-1`, `-2` … for repeats, in document order), so the same fragment
 * names the same heading in the app and on a published page. Consequences, by design: renaming a
 * heading changes its link; a link whose heading is gone opens the page at the top.
 *
 * DOM only (no editor import): this module is on the app's boot path (`App` reads the hash).
 */
import { focusAnchor } from "../notifications/anchor";
import { pageLink } from "./pageLink";
import { headingSlugs } from "./headingSlug";

export { headingSlug, headingSlugs, parseHeadingHash } from "./headingSlug";

const HEADINGS = "h1, h2, h3";
const EDITOR = ".ProseMirror";

/** Every linkable heading of the editor(s) under `root`, with its slug. Empty headings have no link. */
export function headingAnchors(root: ParentNode): Array<{ el: HTMLElement; slug: string }> {
  const editor = (root as Element).matches?.(EDITOR) ? [root as Element] : [...root.querySelectorAll(EDITOR)];
  // A page shows one document; a nested editor (none today) would be numbered with its host.
  const host = editor.find((e) => !e.parentElement?.closest(EDITOR));
  if (!host) return [];
  const els = [...host.querySelectorAll<HTMLElement>(HEADINGS)].filter((h) => (h.textContent ?? "").trim());
  const slugs = headingSlugs(els.map((h) => (h.textContent ?? "").trim()));
  return els.map((el, i) => ({ el, slug: slugs[i]! }));
}

/** The slug of one heading element inside an editor, or null (not a heading, or it has no text). */
export function headingSlugOf(el: Element | null): string | null {
  const heading = el?.closest<HTMLElement>(HEADINGS);
  const host = heading?.closest(EDITOR);
  if (!heading || !host) return null;
  return headingAnchors(host).find((h) => h.el === heading)?.slug ?? null;
}

/** The shareable address of a heading on a page. */
export function headingLink(noteId: string, slug: string): string {
  return `${pageLink(noteId)}#h-${slug}`;
}

/**
 * Scroll to the heading `slug` of the page `noteId` once that page's editor is on screen (the
 * notification deep-link mechanism, without its flash: the editor owns a heading's attributes). In the workspace the document must be the one
 * for `noteId` (`<main data-note-id>`): right after `openTab` the previous page is still mounted,
 * and it may have a heading of the same name.
 */
export function focusHeading(slug: string, noteId?: string | null, waitMs?: number): Promise<boolean> {
  return focusAnchor((scope) => {
    const main = (scope as Element).id === "workspace-document" ? (scope as HTMLElement) : null;
    if (main && noteId && main.dataset.noteId !== noteId) return null;
    return headingAnchors(scope).find((h) => h.slug === slug)?.el ?? null;
  }, undefined, { block: "start", waitMs, flash: false });
}

/** Copy the heading's link. Resolves false when the clipboard refused or the element is no linkable heading. */
export async function copyHeadingLink(noteId: string, heading: Element | null): Promise<boolean> {
  const slug = headingSlugOf(heading);
  if (!slug) return false;
  try { await navigator.clipboard.writeText(headingLink(noteId, slug)); return true; } catch { return false; }
}
