import { useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Popover } from "./Popover";
import type { PropertyDef } from "../../lib/database/schema";

export function PropertyDisplay({ properties, visible, onChange, onReset }: {
  properties: PropertyDef[]; visible: string[]; onChange: (keys: string[]) => void; onReset: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={anchor} type="button" className="db-ghost focus-ring" aria-label="Display properties" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <SlidersHorizontal size={13} aria-hidden="true" /> Choose visible fields
    </button>
    <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Display properties" width={320}>
      <p className="db-pop-heading">Fields kept above the collapse</p>
      <ul className="db-pin-list">
        {properties.map(p => <li key={p.key}><label className="db-pin-check db-personal-property">
          <input type="checkbox" checked={visible.includes(p.key)} onChange={e => onChange(e.target.checked ? [...visible, p.key] : visible.filter(k => k !== p.key))} />
          <span>{p.label}</span>
        </label></li>)}
      </ul>
      <p className="db-pin-note">Choose which fields stay on the page. Other fields appear with “Show more”. This changes only your view, on this device.</p>
      <button type="button" className="db-pop-clear focus-ring" onClick={onReset}>Use shared defaults</button>
    </Popover>
  </>;
}
