/**
 * "Customize…" on the property bar: which of a tag's properties every page with
 * that tag shows at the top, and in what order. Stored as the tag's `pinned`
 * presentation hint (owner-only on the server; nothing on any page is written).
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, SlidersHorizontal } from "lucide-react";
import { MAX_PINNED, propertyFromField, type SchemaMap } from "../../lib/database/schema";
import { isSystemKey } from "../../lib/database/schema";
import { Popover } from "./Popover";

export function CustomizeProperties({ tags, schemas, onSave }: {
  /** The page's tags that have properties to choose from. */
  tags: string[];
  schemas: SchemaMap;
  onSave: (tag: string, pinned: string[]) => Promise<unknown>;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState(tags[0] ?? "");
  const active = tags.includes(tag) ? tag : tags[0] ?? "";
  const fields = Object.entries(schemas[active]?.fields ?? {})
    .filter(([k, f]) => !f.deleted && !isSystemKey(k))
    .map(([k, f]) => propertyFromField(k, f, active));
  const stored = (schemas[active]?.pinned ?? []).filter((k) => fields.some((f) => f.key === k));
  // The list being edited; the server's answer replaces it (through `schemas`) once a save lands.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const saves = useRef(0);
  useEffect(() => { setDraft(null); setError(""); }, [active, open]);
  // A saved draft is let go only once the schema read shows it (the cache update lands a tick
  // after the save resolves — dropping the draft at once flashed the previous layout).
  const storedKey = stored.join("\n");
  useEffect(() => { setDraft((d) => (d && d.join("\n") === storedKey ? null : d)); }, [storedKey]);
  const pinned = draft ?? stored;
  const rows = [...pinned.map((k) => fields.find((f) => f.key === k)!), ...fields.filter((f) => !pinned.includes(f.key))];
  const full = pinned.length >= MAX_PINNED;

  const save = (next: string[], said: string) => {
    setDraft(next);
    setError("");
    setStatus(said);
    const mine = ++saves.current;
    onSave(active, next).then(
      () => undefined,
      (e: unknown) => {
        if (saves.current !== mine) return;
        setDraft(null);
        setError(e instanceof Error && !/failed: \d{3}/.test(e.message) ? e.message : "The layout could not be saved.");
      },
    );
  };
  const labelOf = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  const move = (key: string, to: number) => {
    const from = pinned.indexOf(key);
    if (from < 0 || to < 0 || to >= pinned.length || to === from) return;
    const next = pinned.filter((k) => k !== key);
    next.splice(to, 0, key);
    save(next, `${labelOf(key)} moved to position ${to + 1} of ${next.length}`);
  };

  return (
    <>
      <button ref={anchor} type="button" className="db-ghost focus-ring" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SlidersHorizontal size={13} aria-hidden="true" /> Customize…
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Customize properties" width={340}>
        {tags.length > 1 && (
          <label className="db-field">
            <span>Pages tagged</span>
            <select aria-label="Tag to customize" value={active} onChange={(e) => setTag(e.target.value)}>
              {tags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        )}
        <p className="db-pop-heading">Show at the top of every “{active}” page</p>
        <ul className="db-pin-list" aria-label="Properties">
          {rows.map((p) => {
            const index = pinned.indexOf(p.key);
            const on = index >= 0;
            return (
              <li key={p.key} data-pinned={on} data-key={p.key} data-dragging={dragging === p.key || undefined}
                draggable={on}
                onDragStart={(e) => { setDragging(p.key); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", p.key); }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => { if (dragging && on && dragging !== p.key) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (dragging && on) move(dragging, index); setDragging(null); }}>
                <span className="db-pin-grip" aria-hidden="true">{on && <GripVertical size={13} />}</span>
                <label className="db-pin-check">
                  <input type="checkbox" checked={on} disabled={!on && full} aria-label={`Show ${p.label} at top`}
                    onChange={(e) => save(e.target.checked ? [...pinned, p.key] : pinned.filter((k) => k !== p.key), e.target.checked ? `${p.label} is shown at the top` : `${p.label} is no longer shown at the top`)} />
                  <span>{p.label}</span>
                </label>
                {on && (
                  <span className="db-pin-moves">
                    <button type="button" className="focus-ring" aria-label={`Move ${p.label} up`} aria-disabled={index === 0} onClick={() => move(p.key, index - 1)}><ArrowUp size={13} aria-hidden="true" /></button>
                    <button type="button" className="focus-ring" aria-label={`Move ${p.label} down`} aria-disabled={index === pinned.length - 1} onClick={() => move(p.key, index + 1)}><ArrowDown size={13} aria-hidden="true" /></button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="db-pin-note">
          {pinned.length === 0
            ? "Nothing is chosen, so each page shows every property that has a value."
            : full ? `At most ${MAX_PINNED} properties can be shown at the top.` : "Other properties stay one click away under “more properties”."}
        </p>
        {error && <p className="db-error" role="alert">{error}</p>}
        <span className="sr-only" aria-live="polite">{status}</span>
        {pinned.length > 0 && (
          <button type="button" className="db-pop-clear" onClick={() => save([], "Every property with a value is shown")}>Show every filled property instead</button>
        )}
      </Popover>
    </>
  );
}
