/**
 * Heading slugs for `#h-<slug>` links — the pure half of `headingLinks.ts` (no DOM, no imports:
 * `lib/tiptap/prismLinks.ts` reads it, and that module is loaded by Node-side specs).
 */

/** The wiki's rule: lower-case, drop everything but word characters, spaces and hyphens, spaces → "-". */
export function headingSlug(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-") || "section";
}

/** Slugs for headings in document order; a repeated slug gets `-1`, `-2` … (skipping any taken). */
export function headingSlugs(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  return texts.map((text) => {
    const base = headingSlug(text);
    let slug = base;
    for (let i = 1; seen.has(slug); i++) slug = `${base}-${i}`;
    seen.add(slug);
    return slug;
  });
}

/** `#h-<slug>` → slug. Strict shape: the fragment comes from a URL anyone can write. */
export function parseHeadingHash(hash: string | null | undefined): string | null {
  const m = /^#h-([\w-]{1,400})$/.exec(hash ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

