/**
 * What a URL property may hold — PURE, no DOM, also used by the server's CSV import.
 *
 * The rule is the editor's link rule (`normalizeLink` in SelectionActions.tsx, which
 * follows `prismLinks.linkTarget`), narrowed to web addresses:
 *
 *   - no backslash, control character, space or DEL anywhere (`/\evil.tld` and
 *     `/<TAB>/evil.tld` resolve to another origin);
 *   - `http://` or `https://` only — never `javascript:`, `data:`, `mailto:` (that is
 *     an Email property), an in-app path or an `#anchor`;
 *   - no `user:pass@` (never hand credentials to, or disguise, a host);
 *   - a bare domain (`example.com/page`) is accepted and stored as `https://example.com/page`;
 *   - at most {@link MAX_URL_LENGTH} characters.
 *
 * Everything else is REFUSED at entry with {@link URL_INVALID_HINT}; nothing that is
 * not a web address is stored in a URL property by an editor. A value already stored
 * that fails this rule (typed before the rule, or written by another tool) is shown as
 * plain text with {@link URL_NOT_LINK_HINT} and can be fixed or cleared.
 */

export const MAX_URL_LENGTH = 2048;
/** Said beside the editor when the text typed is not a web address. Nothing is saved. */
export const URL_INVALID_HINT = "That isn’t a web address. Use one like example.com or https://example.com/page.";
/** Said beside a stored value that is not a web address (so it is not drawn as a link). */
export const URL_NOT_LINK_HINT = "Not a link";

/** A backslash, any character ≤ 0x20 (controls, tab, newline, space) or DEL. Same rule as `prismLinks.hasUnsafeLinkChar`. */
function hasUnsafeChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

/** `example.com`, `docs.example.co.uk/a`, `example.com:8080`, `example.com?q=1` — a host with a dot and a letters-only last label. */
const BARE_DOMAIN = /^[A-Za-z0-9](?:[\w-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[\w-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?::\d{1,5})?(?:[/?#]|$)/;
const WEB_SCHEME = /^https?:\/\//i;

/** Is `text` (already trimmed, with a scheme) a web address we would follow? */
function validWebUrl(text: string): boolean {
  if (!text || text.length > MAX_URL_LENGTH || hasUnsafeChar(text) || !WEB_SCHEME.test(text)) return false;
  let url: URL;
  try { url = new URL(text); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return url.hostname.length > 0;
}

/**
 * The value to STORE for what a person typed into a URL property, or null when it is
 * not a web address. The text is kept as typed (trimmed); only a missing scheme is added.
 */
export function normalizeUrlValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH || hasUnsafeChar(text)) return null;
  if (WEB_SCHEME.test(text)) return validWebUrl(text) ? text : null;
  // Anything else with a scheme (`mailto:`, `javascript:`, `ftp:`) or a path / anchor is not a web address.
  if (!BARE_DOMAIN.test(text)) return null;
  const withScheme = `https://${text}`;
  return validWebUrl(withScheme) ? withScheme : null;
}

/** The address a STORED value links to, or null when it must be shown as plain text. Only a value that already carries its scheme is a link. */
export function storedWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return validWebUrl(text) ? text : null;
}
