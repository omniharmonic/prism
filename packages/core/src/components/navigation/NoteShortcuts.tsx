import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import type { VaultClient } from "../../data/VaultClient";
import { useVaultClient } from "../../data/VaultClientContext";
import { usePlatform } from "../../data/Platform";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useUIStore } from "../../app/stores/ui";
import { useSettingsStore, type RecentItem } from "../../app/stores/settings";
import { isVaultNoteId } from "../../lib/noteIdentity";
import { inferContentType } from "../../lib/schemas/content-types";
import { noteLinkTitle } from "../../lib/wikilinks";

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
}
const NO_SHORTCUTS: Shortcuts = { favorites: [], recents: [], favoriteIds: [], toggleFavorite: () => {}, unavailable: false, retry: () => {}, recoverable: false, recovering: false, recover: () => {}, dismissRecovery: () => {}, storageUnavailable: false, recoveryMessage: null };
const Context = createContext<Shortcuts>(NO_SHORTCUTS);
export function useNoteShortcuts() { return useContext(Context); }

export function NoteShortcutsProvider({ children }: { children: ReactNode }) {
  const client = useVaultClient();
  const platform = usePlatform();
  const audience = useAgentChatStore(state => state.scope);
  const scope = audience && client.scope?.() === audience ? audience : null;
  if (platform === "desktop" && !client.scope) return <LegacyShortcuts>{children}</LegacyShortcuts>;
  return <ScopedShortcuts key={scope ?? "unconfirmed"} scope={scope}>{children}</ScopedShortcuts>;
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
  const client = useVaultClient();
  const [record, setRecord] = useState(() => scope ? read(scope) : EMPTY);
  const recordRef = useRef(record);
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
  return <Context.Provider value={scope ? {
    favorites: materialize(record.favorites), recents: materialize(record.recents), favoriteIds: record.favorites,
    toggleFavorite: item => {
      if (!isVaultNoteId(item.id)) return;
      const prior = recordRef.current;
      save({ ...prior, favorites: prior.favorites.includes(item.id) ? prior.favorites.filter(id => id !== item.id) : [item.id, ...prior.favorites].slice(0, 30) });
    },
    unavailable: queries.some(query => query.isError), retry: () => { for (const query of queries) void query.refetch(); },
    recoverable: !record.legacyHandled && !!(old.favorites.length || old.recents.length), recovering, recover: () => { void recover(); },
    dismissRecovery: () => { recoveryGeneration.current++; setRecovering(false); save({ ...recordRef.current, legacyHandled: true }); }, storageUnavailable, recoveryMessage,
  } : NO_SHORTCUTS}>{children}</Context.Provider>;
}
