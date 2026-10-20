import type { Note } from "./parachute";

export const isPerson = (note: Note) =>
  note.tags?.includes("person") || note.metadata?.type === "person";
const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
export function personSummary(note: Note) {
  const meta = note.metadata ?? {};
  const channels =
    meta.channels &&
    typeof meta.channels === "object" &&
    !Array.isArray(meta.channels)
      ? (meta.channels as Record<string, unknown>)
      : {};
  const identities = new Map<string, { kind: string; value: string }>();
  const add = (kind: string, values: unknown) => {
    for (const raw of strings(values)) {
      const value = raw.trim();
      if (value && value.length <= 320)
        identities.set(`${kind}:${value.toLowerCase()}`, { kind, value });
    }
  };
  for (const value of [
    meta.email,
    meta.emails,
    ...strings(meta.contact).filter((value) => value.includes("@")),
    channels.email,
  ])
    add("email", value);
  for (const value of [meta.matrix, meta.matrixId, channels.matrix])
    add("matrix", value);
  for (const kind of ["telegram", "signal", "whatsapp", "phone"])
    add(kind, channels[kind] ?? meta[kind]);
  const name =
    (typeof meta.name === "string" && meta.name.trim()) ||
    (typeof meta.title === "string" && meta.title.trim()) ||
    note.path?.split("/").pop() ||
    "Unnamed person";
  return {
    id: note.id,
    updatedAt: note.updatedAt,
    name,
    path: note.path,
    role: typeof meta.role === "string" ? meta.role.slice(0, 300) : null,
    identities: [...identities.values()].slice(0, 30),
  };
}
export function personCategory(
  note: Note,
): "conversations" | "meetings" | "tasks" | "notes" {
  const tags = new Set([...(note.tags ?? []), note.metadata?.type]);
  if (
    ["message-thread", "email", "matrix-thread", "telegram"].some((t) =>
      tags.has(t),
    )
  )
    return "conversations";
  if (["event", "meeting", "transcript"].some((t) => tags.has(t)))
    return "meetings";
  if (tags.has("task")) return "tasks";
  return "notes";
}

export type IdentityKind = "email" | "matrix";
export function normalizeIdentity(
  kind: IdentityKind,
  raw: string,
): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length > 320) return null;
  return (kind === "email"
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    : /^@[^\s:]+:[^\s]+$/
  ).test(value)
    ? value
    : null;
}
/** Delta only: preserve unrelated channel fields and legacy identity shapes. */
export function identityPatch(
  note: Note,
  kind: IdentityKind,
  value: string,
  action: "add" | "remove",
  decision: Record<string, unknown>,
) {
  const md = note.metadata ?? {};
  const channels =
    md.channels &&
    typeof md.channels === "object" &&
    !Array.isArray(md.channels)
      ? (md.channels as Record<string, unknown>)
      : {};
  const history = Array.isArray(md.prism_identity_history)
    ? md.prism_identity_history
    : [];
  if (history.length >= 1000) throw new Error("identity_history_limit");
  const matches = (v: string) => v.trim().toLowerCase() === value;
  const remove = (v: unknown): unknown =>
    typeof v === "string"
      ? matches(v)
        ? null
        : v
      : Array.isArray(v)
        ? v.filter((x) => typeof x !== "string" || !matches(x))
        : v;
  const patch: Record<string, unknown> = {
    prism_identity_history: [...history, decision],
  };
  if (action === "add") {
    patch.channels = {
      [kind]: [
        ...new Set([
          ...strings(channels[kind]).filter((v) => !matches(v)),
          value,
        ]),
      ],
    };
  } else {
    const fields =
      kind === "email"
        ? ["email", "emails", "contact"]
        : ["matrix", "matrixId", "matrixRoomIds"];
    for (const field of fields)
      if (md[field] !== undefined) patch[field] = remove(md[field]);
    const channelPatch: Record<string, unknown> = {};
    // Bridges may repeat the same Matrix identity under telegram/whatsapp.
    for (const [channel, stored] of Object.entries(channels))
      if (kind === "email" ? channel === "email" : channel !== "email")
        channelPatch[channel] = remove(stored);
    patch.channels = channelPatch;
  }
  return patch;
}
const identityLocks = new Map<string, Promise<unknown>>();
export async function withIdentityLock<T>(
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = identityLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  identityLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (identityLocks.get(key) === next) identityLocks.delete(key);
  }
}
