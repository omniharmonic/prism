import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { CaseSensitive, ChevronDown } from "lucide-react";
import { useCoarsePointer } from "./KeyboardToolbar";
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

/**
 * The ONE chrome row of a page, above its body: [status] [Outline] [Formatting] … [mode / review] [trailing].
 * Formatting is optional chrome; document mode and review actions are not.
 *  - `status` / `trailing`: what a host would otherwise stack as strips of its own. On a phone the live
 *    page passes its connection state and its Comments button, and both editors pass the backlinks
 *    count, so a page has one row (`data-chrome="row"`: no wrapping, icon-only Outline / Formatting).
 *  - `formatting={false}`: a page that cannot be edited — the row without the formatting commands.
 *  - Touch devices: the Formatting commands are not offered here. The keyboard toolbar is the one
 *    formatting surface there (`KeyboardToolbar`), and two would be open at once.
 */
export function FormattingBar({ children, reviewControls, navigation, status, trailing, formatting = true }: {
  children?: ReactNode; reviewControls?: ReactNode; navigation?: ReactNode;
  status?: ReactNode; trailing?: ReactNode; formatting?: boolean;
}) {
  const id = useId();
  const always = useSyncExternalStore(subscribe, snapshot, () => false);
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const touch = useCoarsePointer();
  const commands = formatting && !touch;
  const open = commands && (expanded ?? always);
  return <div className="document-formatting-bar" data-chrome={status || trailing ? "row" : undefined} data-reader={formatting ? undefined : ""}>
    <div className="document-formatting-entry">
      {status && <div className="document-chrome-status">{status}</div>}
      <div className="document-formatting-navigation">{navigation}{commands && <button type="button" className="document-formatting-toggle focus-ring" aria-expanded={open} aria-controls={id}
        onMouseDown={event => event.preventDefault()}
        onClick={() => setExpanded(!open)}>
        <CaseSensitive size={17} aria-hidden="true" /> <span>Formatting</span> <ChevronDown size={13} aria-hidden="true" />
      </button>}</div>
      {reviewControls && <div className="document-review-controls">{reviewControls}</div>}
      {trailing && <div className="document-chrome-trailing">{trailing}</div>}
    </div>
    {commands && <div id={id} hidden={!open}>
      <div className="document-formatting-commands" role="group" aria-label="Text formatting">{children}</div>
      <label className="document-formatting-preference"><input type="checkbox" checked={always}
        onChange={event => { setExpanded(true); setPreference(event.target.checked); }} />Always show formatting toolbar</label>
    </div>}
  </div>;
}
