/**
 * Who "the owner" is, for the identity layer: the owner's own person note plus
 * extra addresses and first-name aliases. Set by the server owner through
 * `PUT /api/admin/people/owner` and stored per vault in SQLite settings;
 * without a stored value the `PEOPLE_OWNER_*` environment is used. Nothing is
 * hardcoded — `OWNER_EMAIL` is always one of the owner's addresses.
 */
import { config } from "./config";
import { getWorkerCursor, setWorkerCursor } from "./db";
import type { OwnerConfig } from "./identity";

export interface OwnerSettings {
  /** The owner's person note: id or path. */
  person: string;
  emails: string[];
  aliases: string[];
}

const KEY = "people-owner";

export function storedOwnerSettings(vaultId: string): OwnerSettings | null {
  const raw = getWorkerCursor(vaultId, KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<OwnerSettings>;
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : []);
    return { person: typeof v.person === "string" ? v.person : "", emails: list(v.emails).map((e) => e.toLowerCase()), aliases: list(v.aliases) };
  } catch {
    return null;
  }
}

export function saveOwnerSettings(vaultId: string, s: OwnerSettings | null): void {
  setWorkerCursor(vaultId, KEY, s ? JSON.stringify(s) : "");
}

/** Stored settings, else the PEOPLE_OWNER_* environment. */
export function ownerSettings(vaultId: string): OwnerSettings & { source: "settings" | "env" } {
  const stored = storedOwnerSettings(vaultId);
  if (stored) return { ...stored, source: "settings" };
  return { person: config.peopleOwnerPerson, emails: [...config.peopleOwnerEmails], aliases: [...config.peopleOwnerAliases], source: "env" };
}

/** The matcher's view: OWNER_EMAIL + the configured addresses, person and aliases. */
export function ownerConfigFor(vaultId: string, extra: { matrixId?: string | null; emails?: string[] } = {}): OwnerConfig {
  const s = ownerSettings(vaultId);
  return {
    emails: [...new Set([config.ownerEmail, ...s.emails, ...(extra.emails ?? [])].map((e) => e.trim().toLowerCase()).filter(Boolean))],
    person: s.person,
    aliases: s.aliases,
    matrixId: extra.matrixId ?? null,
  };
}
