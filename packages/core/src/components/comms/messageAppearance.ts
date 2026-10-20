/** Stable initials and restrained color identify participants across the inbox and thread. */
export function messageInitials(name: string): string {
  return (
    name
      .replace(/^@/, "")
      .split(/[\s_]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?"
  );
}
export function messageColor(identity: string): string {
  const colors = [
    "#5185db",
    "#9275cc",
    "#479c87",
    "#b0844e",
    "#ad7097",
    "#6c8c9f",
  ];
  const hash = Array.from(identity).reduce(
    (value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0,
    2166136261,
  );
  return colors[hash % colors.length]!;
}
