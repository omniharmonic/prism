import type { PublicationTheme } from "@prism/core";

/**
 * Sanitize an owner-set publication theme for rendering on a PUBLIC page.
 *
 * The theme is owner-authored but displayed to anonymous visitors, so every
 * value is re-validated here (the server already size-caps + shape-checks it;
 * this is the injection gate). Colors must match a strict CSS-color pattern and
 * the logo must be an http(s) URL — anything else is dropped. Values are only
 * ever applied as element `style` properties / `src` attributes, never as raw
 * HTML, so even a passing value can't break out of its CSS context.
 */

export interface SafeTheme {
  /** Validated http(s) logo URL, or null. */
  logoUrl: string | null;
  /** CSS custom properties to set on the wiki root (only the ones provided). */
  vars: Record<string, string>;
  /** Resolved body font-family, or null to keep the default. */
  fontFamily: string | null;
}

/** Accept hex (#rgb/#rgba/#rrggbb/#rrggbbaa), rgb()/rgba()/hsl()/hsla() with
 *  digits/dots/%/commas/spaces only, or a plain CSS named color. Deliberately
 *  narrow: no `url(...)`, no semicolons, no braces — nothing that could escape
 *  the CSS value context. */
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/]+\)$/i;
const NAMED_RE = /^[a-z]{3,20}$/i;

function safeColor(v: string | undefined): string | null {
  if (!v) return null;
  const c = v.trim();
  if (HEX_RE.test(c) || FUNC_RE.test(c) || NAMED_RE.test(c)) return c;
  return null;
}

function safeLogoUrl(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const FONT_STACKS: Record<NonNullable<PublicationTheme["font"]>, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
};

export function resolveTheme(theme: PublicationTheme | null | undefined): SafeTheme {
  const vars: Record<string, string> = {};
  const accent = safeColor(theme?.accent);
  const bg = safeColor(theme?.bg);
  const text = safeColor(theme?.text);

  if (accent) vars["--accent"] = accent;
  if (bg) {
    vars["--bg"] = bg;
    vars["--bg-surface"] = bg;
  }
  if (text) {
    vars["--text"] = text;
    vars["--text-primary"] = text;
  }

  const font = theme?.font && FONT_STACKS[theme.font] ? FONT_STACKS[theme.font] : null;

  return { logoUrl: safeLogoUrl(theme?.logoUrl), vars, fontFamily: font };
}
