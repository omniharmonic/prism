import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VaultClient } from "../../data/VaultClient";
import { useVaultClient } from "../../data/VaultClientContext";
import { usePlatform } from "../../data/Platform";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useUIStore } from "../../app/stores/ui";
import { useSettingsStore, type RecentItem } from "../../app/stores/settings";
import { isVaultNoteId } from "../../lib/noteIdentity";
import { inferContentType } from "../../lib/schemas/content-types";
import { noteLinkTitle } from "../../lib/wikilinks";
import { PagesRequestError, preferenceOps, type PagePreferences, type PreferencesSnapshot } from "../../lib/pages/model";

const PREFIX = "prism:note-shortcuts:v1:";
type RecordValue = { version: 1; favorites: string[]; recents: string[]; legacyHandled: boolean };
const EMPTY: RecordValue = { version: 1, favorites: [], recents: [], legacyHandled: false };
function ids(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length <= 2048 && !/[\u0000-\u001f]/.test(id) && isVaultNoteId(id)))].slice(0, limit) : [];
}
async function freshNote(client: VaultClient, id: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const note = await Promise.race([client.getNote(id, { fresh: true }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("Shortcut access check timed out")), 12_000);
    })]);
    if (note.id !== id && !(id.startsWith("offline-") && isVaultNoteId(note.id))) throw Error("Shortcut identity changed");
    return note;
  } finally { clearTimeout(timer); }
}
function key(scope: string) { return PREFIX + encodeURIComponent(scope); }
function read(scope: string): RecordValue {
  try {
    const raw = localStorage.getItem(key(scope));
    if (!raw || raw.length > 100_000) return EMPTY;
    const value = JSON.parse(raw);
    return value?.version === 1 ? { version: 1, favorites: ids(value.favorites, 30), recents: ids(value.recents, 12), legacyHandled: value.legacyHandled === true } : EMPTY;
  } catch { return EMPTY; }
}
function legacy(): RecordValue {
  // Keep the original record available to the retired local host. Never display
  // or automatically assign its unscoped titles to a newly signed-in account.
  const old = useSettingsStore.getState();
  return { ...EMPTY, favorites: ids(Array.isArray(old.favorites) ? old.favorites.map(item => item?.id) : [], 30), recents: ids(Array.isArray(old.recents) ? old.recents.map(item => item?.id) : [], 12) };
}
interface Shortcuts {
  favorites: RecentItem[];
  recents: RecentItem[];
  favoriteIds: string[];
  toggleFavorite: (item: RecentItem) => void;
  unavailable: boolean;
  retry: () => void;
  recoverable: boolean;
  recovering: boolean;
  recover: () => void;
  dismissRecovery: () => void;
  storageUnavailable: boolean;
  recoveryMessage: string | null;
  /** True when favorites/recents/sidebar state sync across devices (GET/PUT /api/me/preferences). */
  synced: boolean;
  /** Collapsed sidebar sections ("favorites" | "recent" | "pages" | "tools"); null = use defaults. */
  collapsed: string[] | null;
  setCollapsed: (section: string, collapsed: boolean) => void;
}
const NO_SHORTCUTS: Shortcuts = { favorites: [], recents: [], favoriteIds: [], toggleFavorite: () => {}, unavailable: false, retry: () => {}, recoverable: false, recovering: false, recover: () => {}, dismissRecovery: () => {}, storageUnavailable: false, recoveryMessage: null, synced: false, collapsed: null, setCollapsed: () => {} };
const Context = createContext<Shortcuts>(NO_SHORTCUTS);
export function useNoteShortcuts() { return useContext(Context); }

export function NoteShortcutsProvider({ children }: { children: ReactNode }) {
  const client = useVaultClient();
  const platform = usePlatform();
  const audience = useAgentChatStore(state => state.scope);
  const scope = audience && client.scope?.() === audience ? audience : null;
  if (platform === "desktop" && !client.scope) return <LegacyShortcuts>{children}</LegacyShortcuts>;
  // Server-synced preferences when the shell can reach them; per-device storage otherwise.
  if (scope && client.getPreferences && client.savePreferences) return <SyncedOrLocal key={scope} scope={scope}>{children}</SyncedOrLocal>;
  return <ScopedShortcuts key={scope ?? "unconfirmed"} scope={scope}>{children}</ScopedShortcuts>;
}

/** A server without the preferences route (older Prism Server) or an offline start → per-device shortcuts. */
const unsupported = (e: unknown) => e instanceof PagesRequestError && [0, 404, 405, 501].includes(e.status);
const MIGRATED = "prism:prefs-migrated:v1:";

function SyncedOrLocal({ scope, children }: { scope: string; children: ReactNode }) {
  const client = useVaultClient();
  const query = useQuery({
    queryKey: ["vault", "preferences", scope],
    queryFn: () => client.getPreferences!(),
    retry: false,
    staleTime: 30_000,
  });
  // Both hooks always run (one provider, one subtree): switching to per-device
  // shortcuts must never remount the workspace below this provider.
  const local = query.isError && unsupported(query.error);
  const synced = useSyncedShortcuts(scope, query);
  const scoped = useScopedShortcuts(scope, local);
  return <Context.Provider value={local ? scoped : synced}>{children}</Context.Provider>;
}

function useSyncedShortcuts(scope: string, query: ReturnType<typeof useQuery<PreferencesSnapshot>>): Shortcuts {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  const key = ["vault", "preferences", scope];
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [saveFailed, setSaveFailed] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const current = () => live.current && client.scope?.() === scope && useAgentChatStore.getState().scope === scope;

  /** Apply `op` optimistically, then persist it with revision CAS (re-applied once on a conflict). */
  const apply = (op: (p: PagePreferences) => PagePreferences, item?: RecentItem) => {
    const snap = queryClient.getQueryData<PreferencesSnapshot>(key);
    if (!snap || !current()) return;
    const optimistic = op(snap.preferences);
    if (optimistic === snap.preferences) return;
    const items = item && !snap.items[item.id] ? { ...snap.items, [item.id]: { path: null, title: item.title, tags: [], type: item.type } } : snap.items;
    queryClient.setQueryData<PreferencesSnapshot>(key, { ...snap, preferences: optimistic, items });
    chain.current = chain.current.then(async () => {
      if (!current()) return;
      const base = queryClient.getQueryData<PreferencesSnapshot>(key) ?? snap;
      try {
        const saved = await client.savePreferences!(base.preferences, base.revision);
        if (current()) { queryClient.setQueryData(key, saved); setSaveFailed(false); }
      } catch (e) {
        if (e instanceof PagesRequestError && e.status === 409 && current()) {
          try {
            const fresh = await client.getPreferences!();
            const saved = await client.savePreferences!(op(fresh.preferences), fresh.revision);
            if (current()) { queryClient.setQueryData(key, saved); setSaveFailed(false); }
            return;
          } catch { /* fall through */ }
        }
        if (current()) { setSaveFailed(true); void queryClient.invalidateQueries({ queryKey: key }); }
      }
    });
  };

  // One-time, per device: carry this account's per-device shortcuts into the synced
  // record. The server filters every id to what the account can view on each read.
  useEffect(() => {
    if (!query.isSuccess || !current()) return;
    let flag: string | null = null;
    try { flag = localStorage.getItem(MIGRATED + encodeURIComponent(scope)); } catch { flag = "1"; }
    if (flag) return;
    const local = read(scope);
    try { localStorage.setItem(MIGRATED + encodeURIComponent(scope), "1"); } catch { /* best effort */ }
    if (local.favorites.length || local.recents.length) apply((p) => preferenceOps.merge(p, local));
  }, [query.isSuccess, scope]);

  const active = useUIStore(state => state.activeTabId);
  const tabs = useUIStore(state => state.openTabs);
  const selected = tabs.find(tab => tab.id === active);
  useEffect(() => {
    if (!query.isSuccess || !selected || !isVaultNoteId(selected.noteId) || selected.noteId.startsWith("offline-")) return;
    apply((p) => preferenceOps.pushRecent(p, selected.noteId), { id: selected.noteId, title: selected.title, type: selected.type });
  }, [selected?.noteId, query.isSuccess]);

  const snap = query.data;
  const toItem = (id: string): RecentItem | null => {
    const it = snap?.items[id];
    if (!it) return null;
    return { id, title: it.title, type: inferContentType({ path: it.path, tags: it.tags, metadata: { ...(it.type ? { type: it.type } : {}), ...(it.prismType ? { prism_type: it.prismType } : {}) } }) };
  };
  const list = (ids: string[], limit: number) => ids.flatMap((id) => { const i = toItem(id); return i ? [i] : []; }).slice(0, limit);
  return {
    ...NO_SHORTCUTS,
    synced: true,
    favorites: list(snap?.preferences.favorites ?? [], 100),
    recents: list(snap?.preferences.recents ?? [], 12),
    favoriteIds: snap?.preferences.favorites ?? [],
    toggleFavorite: (item) => { if (isVaultNoteId(item.id)) apply((p) => preferenceOps.toggleFavorite(p, item.id), item); },
    unavailable: query.isError,
    retry: () => { void query.refetch(); },
    storageUnavailable: saveFailed,
    collapsed: snap ? snap.preferences.sidebar.collapsed : null,
    setCollapsed: (section, collapsed) => apply((p) => preferenceOps.setCollapsed(p, section, collapsed)),
  };
}

function LegacyShortcuts({ children }: { children: ReactNode }) {
  const favorites = useSettingsStore(state => state.favorites);
  const recents = useSettingsStore(state => state.recents);
  const toggleFavorite = useSettingsStore(state => state.toggleFavorite);
  const active = useUIStore(state => state.activeTabId);
  const tabs = useUIStore(state => state.openTabs);
  useEffect(() => {
    const tab = tabs.find(tab => tab.id === active);
    if (tab && isVaultNoteId(tab.noteId)) useSettingsStore.getState().pushRecent({ id: tab.noteId, title: tab.title, type: tab.type });
  }, [active, tabs]);
  return <Context.Provider value={{ ...NO_SHORTCUTS, favorites, recents, favoriteIds: favorites.map(item => item.id), toggleFavorite }}>{children}</Context.Provider>;
}

function ScopedShortcuts({ scope, children }: { scope: string | null; children: ReactNode }) {
  return <Context.Provider value={useScopedShortcuts(scope, true)}>{children}</Context.Provider>;
}

/** Per-device shortcuts (localStorage). Inert (`enabled` false) while preferences sync. */
function useScopedShortcuts(scopeArg: string | null, enabled: boolean): Shortcuts {
  const scope = enabled ? scopeArg : null;
  const client = useVaultClient();
  const [record, setRecord] = useState(() => scope ? read(scope) : EMPTY);
  const recordRef = useRef(record);
  useEffect(() => { if (scope) { const next = read(scope); recordRef.current = next; setRecord(next); } }, [scope]);
  const live = useRef(true);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const recoveryGeneration = useRef(0);
  const active = useUIStore(state => state.activeTabId);
  const tabs = useUIStore(state => state.openTabs);
  const current = () => live.current && !!scope && client.scope?.() === scope && useAgentChatStore.getState().scope === scope;
  const save = (next: RecordValue) => {
    if (!current()) return;
    recordRef.current = next; setRecord(next);
    try { localStorage.setItem(key(scope!), JSON.stringify(next)); setStorageUnavailable(false); }
    catch { setStorageUnavailable(true); }
  };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (scope && event.key === key(scope) && current()) { const next = read(scope); recordRef.current = next; setRecord(next); }
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, [scope, client]);

  const selected = tabs.find(tab => tab.id === active)?.noteId;
  useEffect(() => {
    if (!selected || !isVaultNoteId(selected) || !current()) return;
    let cancelled = false;
    // A tab title is not access evidence. Recheck before recording a recent,
    // including during soft vault switches and mapped offline-note creation.
    void freshNote(client, selected).then(note => {
      const state = useUIStore.getState();
      if (cancelled || !current() || state.openTabs.find(tab => tab.id === state.activeTabId)?.noteId !== selected) return;
      const prior = recordRef.current;
      if (prior.recents[0] !== note.id) save({ ...prior, recents: [note.id, ...prior.recents.filter(id => id !== note.id)].slice(0, 12) });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected, scope, client]);

  const requested = [...new Set([...record.favorites, ...record.recents])];
  const queries = useQueries({ queries: requested.map(id => ({
    // The standard per-note prefix receives existing targeted SSE invalidations;
    // the scope suffix prevents one audience from reusing another's projection.
    queryKey: ["vault", "notes", id, "shortcut", scope],
    queryFn: async () => {
      if (!current()) throw Error("Workspace changed");
      const note = await freshNote(client, id);
      if (!current()) throw Error("Workspace changed");
      return { id: note.id, title: noteLinkTitle(note), type: inferContentType(note) };
    },
    enabled: !!scope, retry: false, staleTime: 30_000, refetchOnMount: "always" as const,
  })) });
  useEffect(() => {
    if (!current()) return;
    const mapped = new Map(queries.flatMap((query, index) => query.isSuccess && query.data.id !== requested[index]
      ? [[requested[index], query.data.id] as const] : []));
    if (!mapped.size) return;
    const prior = recordRef.current;
    save({ ...prior, favorites: ids(prior.favorites.map(id => mapped.get(id) ?? id), 30), recents: ids(prior.recents.map(id => mapped.get(id) ?? id), 12) });
  }, [queries]);
  const visible = new Map(queries.flatMap((query, index) => query.isSuccess && !query.isFetching ? [[requested[index], query.data] as const] : []));
  const materialize = (values: string[]) => values.flatMap(id => visible.get(id) ? [visible.get(id)!] : []);
  const recover = async () => {
    if (!current() || recovering) return;
    const ticket = ++recoveryGeneration.current;
    setRecovering(true); setRecoveryMessage(null);
    const old = legacy();
    const accessible = new Set((await Promise.all([...new Set([...old.favorites, ...old.recents])].map(async id => {
      try { const note = await freshNote(client, id); return note.id === id ? id : null; } catch { return null; }
    }))).filter((id): id is string => !!id));
    if (!current() || ticket !== recoveryGeneration.current) return;
    const prior = recordRef.current;
    save({ version: 1, favorites: ids([...prior.favorites, ...old.favorites.filter(id => accessible.has(id))], 30), recents: ids([...prior.recents, ...old.recents.filter(id => accessible.has(id))], 12), legacyHandled: accessible.size === new Set([...old.favorites, ...old.recents]).size });
    setRecovering(false);
    setRecoveryMessage(`${accessible.size} accessible shortcuts recovered. Unavailable notes were left out.`);
  };
  const old = legacy();
  return scope ? {
    ...NO_SHORTCUTS,
    favorites: materialize(record.favorites), recents: materialize(record.recents), favoriteIds: record.favorites,
    toggleFavorite: item => {
      if (!isVaultNoteId(item.id)) return;
      const prior = recordRef.current;
      save({ ...prior, favorites: prior.favorites.includes(item.id) ? prior.favorites.filter(id => id !== item.id) : [item.id, ...prior.favorites].slice(0, 30) });
    },
    unavailable: queries.some(query => query.isError), retry: () => { for (const query of queries) void query.refetch(); },
    recoverable: !record.legacyHandled && !!(old.favorites.length || old.recents.length), recovering, recover: () => { void recover(); },
    dismissRecovery: () => { recoveryGeneration.current++; setRecovering(false); save({ ...recordRef.current, legacyHandled: true }); }, storageUnavailable, recoveryMessage,
  } : NO_SHORTCUTS;
}
