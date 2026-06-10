/**
 * HTML sanitization for every place we render note-derived HTML via
 * `dangerouslySetInnerHTML`. Note content is NOT trusted: a collaborator with
 * an edit/suggest grant, or synced external sources (HTML emails, web clips),
 * can introduce markup. Without this, a crafted note could run script in the
 * app origin — most dangerously on the public, unauthenticated share page.
 *
 * We allow the rich formatting TipTap produces (headings, lists, tables, links,
 * images, code, task checkboxes, wikilink/suggestion data-attrs) and strip
 * everything executable: <script>/<iframe>/<object>/<form>, inline event
 * handlers, javascript: URLs, and inline styles.
 */
import DOMPurify from "dompurify";

const CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  // HTML only — no SVG/MathML, which widen the XSS surface.
  USE_PROFILES: { html: true },
  // Attributes TipTap/wikilinks/suggestions rely on, beyond DOMPurify's defaults.
  ADD_ATTR: ["target", "data-type", "data-target", "data-suggestion", "data-checked", "colspan", "rowspan"],
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["style", "onerror", "onload", "onclick", "onmouseover"],
};

/** Sanitize untrusted HTML for safe injection via dangerouslySetInnerHTML. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html ?? "", CONFIG) as string;
}
