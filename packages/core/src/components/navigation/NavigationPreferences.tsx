import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";

export const TOOL_NAMES = { calendar: "Calendar", people: "People", automations: "Automations", map: "Map" } as const;
export type NavigationTool = keyof typeof TOOL_NAMES;
type Placement = "pinned" | "tools" | "hidden";
type Preferences = { version: 1; order: NavigationTool[]; placement: Record<NavigationTool, Placement>; density: "comfortable" | "compact" };
const KEY = "prism:navigation-preferences:v1";
const TOOL_IDS = Object.keys(TOOL_NAMES) as NavigationTool[];
const DEFAULT: Preferences = { version: 1, order: TOOL_IDS, placement: { calendar: "tools", people: "tools", automations: "tools", map: "tools" }, density: "comfortable" };
function read(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null");
    if (value?.version !== 1) return DEFAULT;
    const order = Array.isArray(value.order) ? value.order.filter((id: unknown): id is NavigationTool => typeof id === "string" && TOOL_IDS.includes(id as NavigationTool)) : [];
    return { version: 1, order: [...new Set<NavigationTool>([...order, ...TOOL_IDS])], density: value.density === "compact" ? "compact" : "comfortable",
      placement: Object.fromEntries(TOOL_IDS.map(id => [id, ["pinned", "tools", "hidden"].includes(value.placement?.[id]) ? value.placement[id] : "tools"])) as Preferences["placement"] };
  } catch { return DEFAULT; }
}

/** Device presentation only: static tool IDs, no note names, audiences or grants. */
export function useNavigationPreferences() {
  const [value, setValue] = useState(read);
  const latest = useRef(value);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === KEY || event.key === null) { latest.current = read(); setValue(latest.current); } };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const update = (change: (previous: Preferences) => Preferences) => {
    const next = change(latest.current);
    latest.current = next; setValue(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); setStorageError(false); } catch { setStorageError(true); }
  };
  return { value, storageError,
    setPlacement: (id: NavigationTool, placement: Placement) => update(old => ({ ...old, placement: { ...old.placement, [id]: placement } })),
    setDensity: (density: Preferences["density"]) => update(old => ({ ...old, density })),
    move: (id: NavigationTool, offset: number) => update(old => {
      const at = old.order.indexOf(id), to = at + offset;
      if (at < 0 || to < 0 || to >= old.order.length) return old;
      const order = [...old.order]; [order[at], order[to]] = [order[to]!, order[at]!]; return { ...old, order };
    }),
    reset: () => update(() => DEFAULT),
  };
}

export function NavigationPreferences({ preferences, onClose }: { preferences: ReturnType<typeof useNavigationPreferences>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => { element?.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="navigation-preferences-title" className="workspace-navigation-preferences"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose(); }}>
    <div className="flex items-start justify-between gap-4">
      <div><h2 id="navigation-preferences-title" className="text-lg font-semibold">Your sidebar</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">Keep your everyday tools close. These preferences stay on this device.</p></div>
      <button type="button" aria-label="Close sidebar preferences" className="focus-ring shrink-0 rounded p-2" onClick={onClose}><X size={18} /></button>
    </div>
    <label className="my-5 flex items-center justify-between gap-4 text-sm">Navigation spacing
      <select aria-label="Navigation spacing" value={preferences.value.density} onChange={event => preferences.setDensity(event.target.value as Preferences["density"])} className="min-h-control rounded-md border border-[var(--glass-border)] bg-[var(--bg-base)] px-3">
        <option value="comfortable">Comfortable</option><option value="compact">Compact</option>
      </select>
    </label>
    <div className="divide-y divide-[var(--glass-border)]">
      {preferences.value.order.map((id, index) => <div key={id} className="flex flex-wrap items-center gap-2 py-2">
        <span className="min-w-20 flex-1 text-sm">{TOOL_NAMES[id]}</span>
        <select aria-label={`${TOOL_NAMES[id]} placement`} value={preferences.value.placement[id]} onChange={event => preferences.setPlacement(id, event.target.value as Placement)} className="min-h-control rounded-md border border-[var(--glass-border)] bg-[var(--bg-base)] px-2 text-sm">
          <option value="pinned">Pinned</option><option value="tools">In Tools</option><option value="hidden">Hidden</option>
        </select>
        <div className="flex">
          <button type="button" aria-label={`Move ${TOOL_NAMES[id]} up`} disabled={index === 0} onClick={() => preferences.move(id, -1)} className="focus-ring flex h-8 coarse:h-11 w-9 items-center justify-center rounded"><ArrowUp size={15} /></button>
          <button type="button" aria-label={`Move ${TOOL_NAMES[id]} down`} disabled={index === preferences.value.order.length - 1} onClick={() => preferences.move(id, 1)} className="focus-ring flex h-8 coarse:h-11 w-9 items-center justify-center rounded"><ArrowDown size={15} /></button>
        </div>
      </div>)}
    </div>
    {preferences.storageError && <p role="status" className="mt-3 text-sm text-[var(--color-warning)]">Your sidebar changed, but could not be saved on this device.</p>}
    <div className="mt-5 flex items-center justify-between gap-3"><button type="button" className="focus-ring min-h-control rounded px-2 text-sm text-[var(--text-secondary)]" onClick={preferences.reset}>Restore defaults</button><button type="button" className="focus-ring min-h-control rounded-md bg-[var(--action-bg)] px-5 text-sm text-[var(--action-fg)]" onClick={onClose}>Done</button></div>
  </dialog>;
}
