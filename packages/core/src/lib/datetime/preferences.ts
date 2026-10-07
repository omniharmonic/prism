/**
 * Regional preferences (NP-AX-09): start of week, date format, 12/24-hour time.
 *
 * Read synchronously by `format.ts`, so they live on the device (localStorage) and are
 * mirrored into the synced preferences document (`PagePreferences.region`, see
 * `components/navigation/NoteShortcuts.tsx`) — newest `at` wins on every device.
 * "system" for all three = exactly what the app did before the setting existed.
 * No React here (the server's tests import this through `format.ts`); the hook is `useRegionPrefs.ts`.
 */
export type WeekStartPref = "system" | "sunday" | "monday";
/** iso = 2026-10-04 · dmy = 04/10/2026 · mdy = 10/04/2026 · long = Oct 4, 2026 */
export type DateFormatPref = "system" | "iso" | "dmy" | "mdy" | "long";
export type TimeFormatPref = "system" | "12" | "24";

export interface RegionPrefs {
  weekStart: WeekStartPref;
  dateFormat: DateFormatPref;
  timeFormat: TimeFormatPref;
}
/** What is stored and synced: only the non-system choices, plus when they were last changed. */
export interface StoredRegion {
  weekStart?: Exclude<WeekStartPref, "system">;
  dateFormat?: Exclude<DateFormatPref, "system">;
  timeFormat?: Exclude<TimeFormatPref, "system">;
  at?: number;
}

export const SYSTEM_REGION: RegionPrefs = Object.freeze({ weekStart: "system", dateFormat: "system", timeFormat: "system" }) as RegionPrefs;
export const WEEK_START_CHOICES: readonly WeekStartPref[] = ["system", "sunday", "monday"];
export const DATE_FORMAT_CHOICES: readonly DateFormatPref[] = ["system", "iso", "dmy", "mdy", "long"];
export const TIME_FORMAT_CHOICES: readonly TimeFormatPref[] = ["system", "12", "24"];

const pick = <T extends string>(choices: readonly T[], value: unknown): T =>
  typeof value === "string" && (choices as readonly string[]).includes(value) ? (value as T) : ("system" as T);

/** Coerce anything into valid stored preferences (also used for the synced document). Never throws. */
export function sanitizeRegion(raw: unknown): StoredRegion {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: StoredRegion = {};
  const weekStart = pick(WEEK_START_CHOICES, o.weekStart);
  const dateFormat = pick(DATE_FORMAT_CHOICES, o.dateFormat);
  const timeFormat = pick(TIME_FORMAT_CHOICES, o.timeFormat);
  if (weekStart !== "system") out.weekStart = weekStart;
  if (dateFormat !== "system") out.dateFormat = dateFormat;
  if (timeFormat !== "system") out.timeFormat = timeFormat;
  if (typeof o.at === "number" && Number.isSafeInteger(o.at) && o.at > 0) out.at = o.at;
  return out;
}

const expand = (s: StoredRegion): RegionPrefs => ({
  weekStart: s.weekStart ?? "system",
  dateFormat: s.dateFormat ?? "system",
  timeFormat: s.timeFormat ?? "system",
});

const KEY = "prism:region";
const listeners = new Set<() => void>();
let stored: StoredRegion | null = null;
let current: RegionPrefs = SYSTEM_REGION;

function load(): StoredRegion {
  if (stored) return stored;
  let raw: unknown = null;
  try { raw = JSON.parse((typeof localStorage !== "undefined" && localStorage.getItem(KEY)) || "null"); } catch { raw = null; }
  stored = sanitizeRegion(raw);
  current = expand(stored);
  return stored;
}

function commit(next: StoredRegion): void {
  stored = next;
  current = expand(next);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* private mode: this session only */ }
  listeners.forEach((fn) => fn());
}

/** The preferences in force on this device (a stable object until they change). */
export function getRegionPrefs(): RegionPrefs {
  load();
  return current;
}

/** The stored form, with its timestamp — what the sync bridge compares and sends. */
export function getStoredRegion(): StoredRegion {
  return load();
}

/** A choice made on this device. */
export function setRegionPrefs(patch: Partial<RegionPrefs>): void {
  commit({ ...sanitizeRegion({ ...expand(load()), ...patch }), at: Date.now() });
}

/** Take the synced copy when it is newer than what this device holds. Returns true when adopted. */
export function adoptSyncedRegion(remote: unknown): boolean {
  const next = sanitizeRegion(remote);
  if (!next.at || next.at <= (load().at ?? 0)) return false;
  commit(next);
  return true;
}

export function subscribeRegionPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tests only. */
export function resetRegionPrefsForTests(next: Partial<RegionPrefs> = {}): void {
  stored = sanitizeRegion({ ...SYSTEM_REGION, ...next });
  current = expand(stored);
  listeners.forEach((fn) => fn());
}
