import { initialsOf } from "../../lib/history/attribution";

const TONES = ["#3b82f6", "#22a06b", "#a855f7", "#e2763b", "#0ea5b7", "#d6457a", "#6366f1"];

/** A stable tone per identity (name/email), so a person is the same colour everywhere. */
export function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length]!;
}

/**
 * A person's avatar: their uploaded image (a small data: URL from their profile)
 * or initials on a stable tone. Decorative by default — pass `label` when the
 * avatar is the only thing naming the person.
 */
export function PersonAvatar({
  name,
  avatar,
  seed,
  size = 28,
  color,
  label,
}: {
  name: string | null | undefined;
  avatar?: string | null;
  /** Identity for the tone (defaults to the name). */
  seed?: string | null;
  size?: number;
  /** Explicit colour (live presence uses the collaborator's caret colour). */
  color?: string;
  label?: string;
}) {
  const safe = avatar && avatar.startsWith("data:image/") ? avatar : null;
  const tone = color ?? toneFor(seed || name || "?");
  return (
    <span
      className="prism-person-avatar"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: 999,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        fontSize: Math.max(8, Math.round(size * (size < 22 ? 0.5 : 0.4))),
        fontWeight: 650,
        letterSpacing: "0.01em",
        // Initials stay AA on their own tint in both themes: the tone, pulled toward the reading colour.
        color: `color-mix(in srgb, ${tone} 55%, var(--text-primary, #292a30))`,
        background: `color-mix(in srgb, ${tone} 16%, var(--bg-surface, #fff))`,
        border: `1px solid color-mix(in srgb, ${tone} 28%, transparent)`,
        boxSizing: "border-box",
        flexShrink: 0,
      }}
    >
      {safe ? <img src={safe} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : size < 22 ? initialsOf(name).slice(0, 1) : initialsOf(name)}
    </span>
  );
}
