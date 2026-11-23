export interface ThreadReadingIdentity {
  audience: string;
  conversation: string;
}
export interface ThreadReadingPosition {
  eventId: string | null;
  offset: number;
  atBottom: boolean;
}
interface Entry extends ThreadReadingPosition {
  conversation: string;
  savedAt: number;
}
const PREFIX = "prism:thread-reading:v1:";
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
function entries(identity: ThreadReadingIdentity): Entry[] {
  let raw;
  try {
    raw = JSON.parse(
      localStorage.getItem(PREFIX + identity.audience) || "null",
    );
  } catch {
    return [];
  }
  if (raw?.version !== 1 || !Array.isArray(raw.positions)) return [];
  const now = Date.now();
  return raw.positions
    .filter((value: unknown): value is Entry => {
      if (!value || typeof value !== "object") return false;
      const e = value as Entry;
      return (
        typeof e.conversation === "string" &&
        e.conversation.length <= 8192 &&
        (e.eventId === null ||
          (typeof e.eventId === "string" && e.eventId.length <= 4096)) &&
        typeof e.atBottom === "boolean" &&
        (e.atBottom || !!e.eventId) &&
        Number.isFinite(e.offset) &&
        Math.abs(e.offset) < 1_000_000 &&
        Number.isFinite(e.savedAt) &&
        e.savedAt <= now + 60_000 &&
        e.savedAt > now - MAX_AGE
      );
    })
    .sort((a: Entry, b: Entry) => b.savedAt - a.savedAt)
    .slice(0, 100);
}
export function loadReadingPosition(
  identity: ThreadReadingIdentity,
): ThreadReadingPosition | null {
  try {
    const entry = entries(identity).find(
      (e) => e.conversation === identity.conversation,
    );
    return entry
      ? {
          eventId: entry.eventId,
          offset: entry.offset,
          atBottom: entry.atBottom,
        }
      : null;
  } catch {
    return null;
  }
}
export function saveReadingPosition(
  identity: ThreadReadingIdentity,
  position: ThreadReadingPosition,
): void {
  try {
    const next: Entry = {
      conversation: identity.conversation,
      eventId: position.eventId,
      offset: position.offset,
      atBottom: position.atBottom,
      savedAt: Date.now(),
    };
    // Whitelist fields on every write: no body, sender, title or arbitrary stored data.
    const positions = [
      next,
      ...entries(identity).filter(
        (e) => e.conversation !== identity.conversation,
      ),
    ]
      .slice(0, 100)
      .map((e) => ({
        conversation: e.conversation,
        eventId: e.eventId,
        offset: e.offset,
        atBottom: e.atBottom,
        savedAt: e.savedAt,
      }));
    localStorage.setItem(
      PREFIX + identity.audience,
      JSON.stringify({ version: 1, positions }),
    );
  } catch {
    /* Reading remains usable when browser storage is unavailable. */
  }
}
