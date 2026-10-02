import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { CaseSensitive, ChevronDown } from "lucide-react";
import "./FormattingBar.css";

// Appearance only: shared by normal/live editors and across tabs, with a usable
// in-memory fallback when browser storage is unavailable.
const key = "prism:editor:full-toolbar:v1";
const listeners = new Set<() => void>();
let fallback = false;
let storageUnavailable = false;
function snapshot() {
  if (storageUnavailable) return fallback;
  try { return localStorage.getItem(key) === "true"; } catch { return fallback; }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
function setPreference(value: boolean) {
  fallback = value;
  try { localStorage.setItem(key, String(value)); } catch { storageUnavailable = true; }
  for (const listener of listeners) listener();
}

/** Formatting is optional chrome; document mode and review actions are not. */
export function FormattingBar({ children, reviewControls, navigation }: { children: ReactNode; reviewControls?: ReactNode; navigation?: ReactNode }) {
  const id = useId();
  const always = useSyncExternalStore(subscribe, snapshot, () => false);
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? always;
  return <div className="document-formatting-bar">
    <div className="document-formatting-entry">
      <div className="document-formatting-navigation">{navigation}<button type="button" className="document-formatting-toggle focus-ring" aria-expanded={open} aria-controls={id}
        onMouseDown={event => event.preventDefault()}
        onClick={() => setExpanded(!open)}>
        <CaseSensitive size={17} aria-hidden="true" /> Formatting <ChevronDown size={13} aria-hidden="true" />
      </button></div>
      {reviewControls && <div className="document-review-controls">{reviewControls}</div>}
    </div>
    <div id={id} hidden={!open}>
      <div className="document-formatting-commands" role="group" aria-label="Text formatting">{children}</div>
      <label className="document-formatting-preference"><input type="checkbox" checked={always}
        onChange={event => { setExpanded(true); setPreference(event.target.checked); }} />Always show formatting toolbar</label>
    </div>
  </div>;
}
