/**
 * Recent searches (NP-SR-04 brief / NP-SR-08): the last few queries the user
 * acted on, kept on this device per workspace scope. Never synced, never sent.
 */
const MAX = 8;
const key = (scope: string | null) => `prism:recent-searches:${scope ?? "default"}`;

export function recentSearches(scope: string | null): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key(scope)) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, MAX) : [];
  } catch { return []; }
}

export function rememberSearch(scope: string | null, query: string): void {
  const q = query.trim().slice(0, 200);
  if (!q) return;
  try {
    const next = [q, ...recentSearches(scope).filter((v) => v.toLowerCase() !== q.toLowerCase())].slice(0, MAX);
    localStorage.setItem(key(scope), JSON.stringify(next));
  } catch { /* storage unavailable: recents are a convenience */ }
}

export function clearRecentSearches(scope: string | null): void {
  try { localStorage.removeItem(key(scope)); } catch { /* ignore */ }
}
