/**
 * What `metadata.icon` may hold (NP-PG-01). Pure and isomorphic: the server's tree
 * projection and icon write rule use the same parser as every surface that draws one.
 *
 *   emoji  a short string (≤ 32 chars) — what the emoji picker writes
 *   image  EXACTLY our own attachment path `/api/attachments/a_<22>` (an uploaded image
 *          of the page itself). Never a third-party URL, never `data:`, never any
 *          other same-origin path: the value becomes an <img src> on every surface.
 *   glyph  `icon:<name>:<color>` — a built-in line icon in a fixed colour; both parts
 *          come from the allowlists below.
 *
 * Anything else is not an icon: surfaces draw their default, the tree drops it.
 */
import { isOwnAttachment } from "../media/attachments";

/** Built-in line icons (drawn by `PageIconView`, which maps every name to a glyph). */
export const PAGE_ICON_NAMES = [
  "file", "book", "bookmark", "star", "heart", "flag", "home", "folder", "calendar", "clock",
  "check", "list", "target", "bulb", "rocket", "compass", "map", "globe", "leaf", "sun",
  "moon", "camera", "music", "code", "chart", "users", "mail", "lock", "tool", "sparkles",
] as const;
export type PageIconName = (typeof PAGE_ICON_NAMES)[number];

/** Colour tokens; the CSS value is chosen to read on both the light and the dark surface. */
export const PAGE_ICON_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export type PageIconColor = (typeof PAGE_ICON_COLORS)[number];
export const PAGE_ICON_COLOR_CSS: Record<PageIconColor, string> = {
  gray: "#8a8f98", red: "#e5484d", orange: "#e8833a", yellow: "#c99a17", green: "#3d9a50",
  teal: "#12a594", blue: "#3b82f6", purple: "#8b5cf6", pink: "#d6409f",
};

export type PageIconValue =
  | { kind: "emoji"; text: string }
  | { kind: "image"; src: string; attachmentId: string }
  | { kind: "glyph"; name: PageIconName; color: PageIconColor };

export const PAGE_ICON_EMOJI_MAX = 32;
const IMAGE_PREFIX = "/api/attachments/";
const ATTACHMENT_ID = /^a_[A-Za-z0-9_-]{22}$/;
const GLYPH_PREFIX = "icon:";

/** A character an emoji never needs and a path, URL, token or markup always has. */
function plainShort(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2f /* / */ || c === 0x5c /* \ */ || c === 0x3a /* : */ || c === 0x3c /* < */ || c === 0x3e /* > */) return false;
  }
  return true;
}

/** Linear; never throws; bounded by the 64-char look at the value. */
export function parsePageIcon(value: unknown): PageIconValue | null {
  if (typeof value !== "string" || value === "" || value.length > 64) return null;
  if (value.startsWith(IMAGE_PREFIX)) {
    const id = value.slice(IMAGE_PREFIX.length);
    return ATTACHMENT_ID.test(id) && isOwnAttachment(value) ? { kind: "image", src: value, attachmentId: id } : null;
  }
  if (value.startsWith(GLYPH_PREFIX)) {
    const parts = value.split(":");
    if (parts.length !== 3) return null;
    const name = parts[1] as PageIconName;
    const color = parts[2] as PageIconColor;
    return (PAGE_ICON_NAMES as readonly string[]).includes(name) && (PAGE_ICON_COLORS as readonly string[]).includes(color) ? { kind: "glyph", name, color } : null;
  }
  if (value.length > PAGE_ICON_EMOJI_MAX || value.trim() === "" || !plainShort(value)) return null;
  return { kind: "emoji", text: value };
}

/** The stored value when it is an icon, else null. */
export const pageIconOf = (value: unknown): string | null => (parsePageIcon(value) ? (value as string) : null);

/** The attachment an image icon names (the page's own upload), else null. */
export const pageIconAttachmentId = (value: unknown): string | null => {
  const icon = parsePageIcon(value);
  return icon?.kind === "image" ? icon.attachmentId : null;
};

export const glyphIconValue = (name: PageIconName, color: PageIconColor): string => `${GLYPH_PREFIX}${name}:${color}`;
