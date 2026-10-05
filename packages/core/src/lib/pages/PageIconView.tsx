/**
 * Draws one page icon value (NP-PG-01): an emoji, the page's own uploaded image, or a
 * built-in line icon. No data hooks — safe in node views, menus and bare fixtures.
 * Everything that shows `metadata.icon` goes through here, so a value that is not an
 * icon (`parsePageIcon`) is never put on screen as text or as an <img src>.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BookOpen, Bookmark, Calendar, Camera, ChartColumn, CircleCheck, Clock, Code, Compass, FileText, Flag, Folder, Globe, Heart, House,
  Leaf, Lightbulb, ListChecks, Lock, Mail, Map as MapIcon, Moon, Music, Rocket, Sparkles, Star, Sun, Target, Users, Wrench, type LucideIcon,
} from "lucide-react";
import { PAGE_ICON_COLOR_CSS, parsePageIcon, type PageIconName } from "./iconValue";
import { loadIconImage, peekIconImage } from "./iconImages";

export const PAGE_ICON_GLYPHS: Record<PageIconName, LucideIcon> = {
  file: FileText, book: BookOpen, bookmark: Bookmark, star: Star, heart: Heart, flag: Flag, home: House, folder: Folder,
  calendar: Calendar, clock: Clock, check: CircleCheck, list: ListChecks, target: Target, bulb: Lightbulb, rocket: Rocket,
  compass: Compass, map: MapIcon, globe: Globe, leaf: Leaf, sun: Sun, moon: Moon, camera: Camera, music: Music, code: Code,
  chart: ChartColumn, users: Users, mail: Mail, lock: Lock, tool: Wrench, sparkles: Sparkles,
};

const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/**
 * The page's own image. Drawn from a per-attachment blob URL (`iconImages.ts`: one fetch
 * however many surfaces show the icon), asked for only once the icon is near the screen.
 * Until it is there the box is reserved; if it cannot be had, the default icon is shown.
 */
function IconImage({ src, box, fallback }: { src: string; box: CSSProperties; fallback: ReactNode }) {
  const [url, setUrl] = useState<string | null | undefined>(() => peekIconImage(src) ?? undefined);
  const holder = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let alive = true;
    const known = peekIconImage(src);
    setUrl(known ?? undefined);
    if (known !== undefined) return;
    const start = () => { void loadIconImage(src).then((got) => { if (alive) setUrl(got); }); };
    const el = holder.current;
    if (!el || typeof IntersectionObserver === "undefined") { start(); return () => { alive = false; }; }
    // Lazy: a long sidebar does not fetch the icons of rows nobody has scrolled to.
    const io = new IntersectionObserver((seen) => { if (seen.some((e) => e.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [src]);
  if (url === null) return <>{fallback}</>;
  if (url === undefined) return <span ref={holder} className="page-icon-img-pending" data-icon-src={src} style={{ display: "block", ...box }} />;
  return (
    <img
      src={url}
      data-icon-src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className="page-icon-img"
      // A blob that was evicted meanwhile, or bytes the browser cannot decode: the default icon.
      onError={() => setUrl(null)}
      style={{ display: "block", objectFit: "cover", ...box }}
    />
  );
}

export interface PageIconViewProps {
  /** The stored `metadata.icon` (anything; validated here). */
  value: unknown;
  /** Stamped as `data-page-icon` (the page the icon belongs to). */
  noteId?: string | null;
  /** Shown when there is no icon, the value is not one, or its image cannot be loaded. */
  fallback?: ReactNode;
  /** Pixel box for the large icon above a title; without it the icon follows the text size. */
  size?: number;
}

/** The icon, else `fallback`. Decorative: the page's name is always beside it. */
export function PageIconView({ value, noteId, fallback = null, size }: PageIconViewProps) {
  const icon = parsePageIcon(value);
  if (!icon) return <>{fallback}</>;
  const id = noteId ? { "data-page-icon": noteId } : {};
  if (icon.kind === "emoji") {
    return <span className="page-icon-emoji" {...id} aria-hidden="true" style={size ? { fontFamily: EMOJI_FONT, fontSize: Math.round(size * 0.8), lineHeight: 1 } : { fontFamily: EMOJI_FONT }}>{icon.text}</span>;
  }
  if (icon.kind === "glyph") {
    const Glyph = PAGE_ICON_GLYPHS[icon.name];
    return (
      <span className="page-icon-emoji page-icon-glyph" {...id} data-page-icon-kind="glyph" aria-hidden="true" style={{ display: "inline-flex", color: PAGE_ICON_COLOR_CSS[icon.color], lineHeight: 1 }}>
        <Glyph size={size ? Math.round(size * 0.8) : "1.15em"} aria-hidden="true" />
      </span>
    );
  }
  const box: CSSProperties = size
    ? { width: Math.round(size * 0.86), height: Math.round(size * 0.86), borderRadius: Math.max(4, Math.round(size / 7)) }
    : { width: "1.2em", height: "1.2em", borderRadius: "0.22em" };
  return (
    <span className="page-icon-emoji page-icon-image" {...id} data-page-icon-kind="image" aria-hidden="true" style={{ display: "inline-flex", flex: "0 0 auto", lineHeight: 1, verticalAlign: "-0.2em" }}>
      <IconImage key={icon.src} src={icon.src} box={box} fallback={fallback} />
    </span>
  );
}
