/**
 * ONE "New property" form (A), shared by the page's "+ Add property" popover and
 * the database table's "+" column. A property is created in ONE step: its name,
 * its type and everything that type needs — options with colours (and status
 * groups), a number format, a relation's target (a tag or a folder) and whether it
 * holds one page or several — go out as a single additive schema write
 * (`buildNewPropertyPatch`): the vault field plus Prism's presentation hints. Never
 * "create, then fix it in the editor".
 *
 * Schema writes are the workspace owner's (the server decides: `canEdit` from
 * `GET /api/schemas`). Without that, the form offers what a page-only ("free")
 * property can be — text, number, checkbox, URL — and says why.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import {
  buildNewPropertyPatch,
  inferRelationTarget,
  keyFromLabel,
  NUMBER_FORMAT_LABELS,
  NUMBER_FORMATS,
  OPTION_COLORS,
  optionColor,
  PROPERTY_KIND_LABELS,
  PROPERTY_KINDS,
  STATUS_GROUP_LABELS,
  STATUS_GROUPS,
  type NumberFormat,
  type OptionColor,
  type PropertyKind,
  type SchemaPatch,
  type StatusGroup,
} from "../../lib/database/schema";

export const FREE_KINDS: PropertyKind[] = ["text", "number", "checkbox", "url"];

type Opt = { value: string; color: OptionColor; group?: StatusGroup };
const STATUS_DEFAULTS: Opt[] = [
  { value: "Not started", color: "gray", group: "todo" },
  { value: "In progress", color: "blue", group: "in_progress" },
  { value: "Done", color: "green", group: "complete" },
];
/** "Projects", "Attendees" read as several; "Status", "Address" do not. */
const pluralName = (name: string) => /[^s]s$/i.test(name.trim());

export function NewPropertyForm({ tags, schemaBacked, knownTags, existing, heading, onCreateSchema, onCreateFree, onDone, submitLabel = "Add property", freeNote }: {
  /** Why only a page-only property is offered here (shown with the free form). */
  freeNote?: string;
  /** Tags a schema-backed property can be added to (the first is the default). */
  tags: string[];
  /** May this person change the schema here (owner, live server, a tag to add to)? */
  schemaBacked: boolean;
  /** Tags with a schema: relation targets the form proposes from the name. */
  knownTags: string[];
  /** Keys already used (a new property may not reuse one). */
  existing: string[];
  heading?: string;
  onCreateSchema: (tag: string, key: string, patch: SchemaPatch) => Promise<void>;
  /** A page-only property (no schema): the caller writes its first value. Absent = schema-backed only. */
  onCreateFree?: (label: string, kind: PropertyKind) => void;
  onDone?: () => void;
  submitLabel?: string;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PropertyKind>("text");
  const [tag, setTag] = useState(tags[0] ?? "");
  const [options, setOptions] = useState<Opt[]>([]);
  const [newOpt, setNewOpt] = useState("");
  const [format, setFormat] = useState<NumberFormat | "">("");
  const [targetMode, setTargetMode] = useState<"tag" | "folder">("tag");
  const [targetTag, setTargetTag] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [targetTouched, setTargetTouched] = useState(false);
  const [multiple, setMultiple] = useState(false);
  const [multipleTouched, setMultipleTouched] = useState(false);
  const [reverse, setReverse] = useState("");
  const [dateOnly, setDateOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const kinds = schemaBacked ? [...PROPERTY_KINDS] : FREE_KINDS;
  const key = keyFromLabel(name);
  const clash = !!name.trim() && existing.includes(key);
  const linkish = kind === "relation" || kind === "person";
  const optioned = kind === "select" || kind === "status" || kind === "multi_select";

  // The name proposes the target ("Projects" → #project) and one-or-several, until the person chooses.
  useEffect(() => {
    if (!targetTouched) setTargetTag(inferRelationTarget(name, knownTags) ?? (kind === "person" && knownTags.includes("person") ? "person" : ""));
    if (!multipleTouched) setMultiple(pluralName(name));
  }, [name, kind, knownTags, targetTouched, multipleTouched]);
  useEffect(() => {
    if (kind === "status" && !options.length) setOptions(STATUS_DEFAULTS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  const tagChoices = useMemo(() => [...new Set(knownTags)].sort(), [knownTags]);

  const addOption = () => {
    const v = newOpt.trim();
    if (!v) return;
    if (options.some((o) => o.value.toLowerCase() === v.toLowerCase())) { setError(`“${v}” is already an option.`); return; }
    setError("");
    setOptions((cur) => [...cur, { value: v, color: optionColor(v), ...(kind === "status" ? { group: "in_progress" as StatusGroup } : {}) }]);
    setNewOpt("");
  };
  const patchOpt = (i: number, p: Partial<Opt>) => setOptions((cur) => cur.map((o, j) => (j === i ? { ...o, ...p } : o)));
  const moveOpt = (i: number, d: -1 | 1) => setOptions((cur) => {
    const j = i + d;
    if (j < 0 || j >= cur.length) return cur;
    const next = [...cur];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });

  const submit = async () => {
    if (busy || !name.trim() || clash) return;
    setError("");
    if (!schemaBacked) {
      if (!onCreateFree) return;
      onCreateFree(name.trim(), kind);
      setName("");
      onDone?.();
      return;
    }
    // An option typed but not added yet is part of what the person meant.
    const opts = optioned && newOpt.trim() && !options.some((o) => o.value.toLowerCase() === newOpt.trim().toLowerCase())
      ? [...options, { value: newOpt.trim(), color: optionColor(newOpt.trim()) }] : options;
    const target = !linkish ? null : targetMode === "folder" ? (targetPath.trim() ? { pathPrefix: targetPath.trim() } : null) : (targetTag.trim() ? { tag: targetTag.trim().replace(/^#/, "") } : null);
    const built = buildNewPropertyPatch({
      label: name, kind,
      ...(optioned ? { options: opts } : {}),
      ...(kind === "number" && format ? { format } : {}),
      ...(linkish ? { target, multiple, reverseLabel: reverse } : {}),
      ...(kind === "date" ? { dateOnly } : {}),
    });
    if (!built.ok) { setError(built.error); return; }
    if (existing.includes(built.key)) { setError("That property already exists."); return; }
    setBusy(true);
    try {
      await onCreateSchema(tag, built.key, built.patch);
      setName("");
      setOptions([]);
      setNewOpt("");
      onDone?.();
    } catch (e) {
      setError(e instanceof Error && !/failed: \d{3}/.test(e.message) ? e.message : "The property could not be added.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="db-new-prop" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="db-pop-heading">{heading ?? (schemaBacked ? `New property on every “${tag}” page` : "New property on this page")}</p>
      <label className="db-field">
        <span>Name</span>
        <input aria-label="Property name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Estimate" />
      </label>
      <label className="db-field">
        <span>Type</span>
        <select aria-label="Property type" value={kind} onChange={(e) => setKind(e.target.value as PropertyKind)}>
          {kinds.map((k) => <option key={k} value={k}>{PROPERTY_KIND_LABELS[k]}</option>)}
        </select>
      </label>
      {schemaBacked && tags.length > 1 && (
        <label className="db-field">
          <span>Add to pages tagged</span>
          <select aria-label="Property applies to" value={tag} onChange={(e) => setTag(e.target.value)}>
            {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </select>
        </label>
      )}

      {schemaBacked && optioned && (
        <fieldset className="db-new-options">
          <legend className="db-field-legend">Options</legend>
          {options.length > 0 && (
            <ul className="db-new-option-list" aria-label="Options of the new property">
              {options.map((o, i) => (
                <li key={i} className="db-new-option">
                  <input aria-label={`Option ${i + 1}`} value={o.value} maxLength={80} onChange={(e) => patchOpt(i, { value: e.target.value })} />
                  <select aria-label={`Colour of option ${i + 1}`} value={o.color} onChange={(e) => patchOpt(i, { color: e.target.value as OptionColor })}>
                    {OPTION_COLORS.map((c) => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                  </select>
                  {kind === "status" && (
                    <select aria-label={`Group of option ${i + 1}`} value={o.group ?? "in_progress"} onChange={(e) => patchOpt(i, { group: e.target.value as StatusGroup })}>
                      {STATUS_GROUPS.map((g) => <option key={g} value={g}>{STATUS_GROUP_LABELS[g]}</option>)}
                    </select>
                  )}
                  <button type="button" className="db-icon-btn" aria-label={`Move option ${i + 1} up`} disabled={i === 0} onClick={() => moveOpt(i, -1)}><ArrowUp size={12} aria-hidden="true" /></button>
                  <button type="button" className="db-icon-btn" aria-label={`Move option ${i + 1} down`} disabled={i === options.length - 1} onClick={() => moveOpt(i, 1)}><ArrowDown size={12} aria-hidden="true" /></button>
                  <button type="button" className="db-icon-btn" aria-label={`Remove option ${o.value || i + 1}`} onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}><X size={12} aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
          <span className="db-new-option-add">
            <input aria-label="New option" value={newOpt} maxLength={80} placeholder="Add an option…" onChange={(e) => setNewOpt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addOption(); } }} />
            <button type="button" className="db-ghost" onClick={addOption} disabled={!newOpt.trim()}><Plus size={13} aria-hidden="true" /> Add option</button>
          </span>
        </fieldset>
      )}

      {schemaBacked && kind === "number" && (
        <label className="db-field">
          <span>Number format</span>
          <select aria-label="Number format" value={format} onChange={(e) => setFormat(e.target.value as NumberFormat | "")}>
            <option value="">Default</option>
            {NUMBER_FORMATS.map((f) => <option key={f} value={f}>{NUMBER_FORMAT_LABELS[f]}</option>)}
          </select>
        </label>
      )}

      {schemaBacked && kind === "date" && (
        <label className="db-radio"><input type="checkbox" checked={dateOnly} onChange={(e) => setDateOnly(e.target.checked)} /> One calendar day only (no time, no end date)</label>
      )}

      {schemaBacked && linkish && (
        <>
          <label className="db-field">
            <span>Links to</span>
            <select aria-label="Link target kind" value={targetMode} onChange={(e) => { setTargetMode(e.target.value as "tag" | "folder"); setTargetTouched(true); }}>
              <option value="tag">Pages with a tag</option>
              <option value="folder">Pages in a folder</option>
            </select>
          </label>
          {targetMode === "tag" ? (
            <label className="db-field">
              <span>Links to pages tagged</span>
              <input aria-label="Related database tag" list="db-new-prop-tags" value={targetTag} maxLength={128}
                onChange={(e) => { setTargetTag(e.target.value); setTargetTouched(true); }} placeholder={kind === "person" ? "person" : "e.g. project"} />
              <datalist id="db-new-prop-tags">{tagChoices.map((t) => <option key={t} value={t} />)}</datalist>
            </label>
          ) : (
            <label className="db-field">
              <span>Links to pages in the folder</span>
              <input aria-label="Related folder" value={targetPath} maxLength={200} onChange={(e) => { setTargetPath(e.target.value); setTargetTouched(true); }} placeholder="e.g. vault/projects" />
            </label>
          )}
          <label className="db-radio"><input type="checkbox" aria-label="Allow multiple" checked={multiple} onChange={(e) => { setMultiple(e.target.checked); setMultipleTouched(true); }} /> Allow several {kind === "person" ? "people" : "pages"}</label>
          {kind === "relation" && targetMode === "tag" && (
            <label className="db-field">
              <span>Show on those pages as (optional)</span>
              <input aria-label="Reverse property name" value={reverse} maxLength={80} disabled={!targetTag.trim()} onChange={(e) => setReverse(e.target.value)} placeholder={tag ? `e.g. ${tag}s` : "e.g. Tasks"} />
            </label>
          )}
        </>
      )}

      {!schemaBacked && freeNote && <p className="db-pop-path">{freeNote}</p>}
      {clash && <p className="db-error" role="alert">This page already has that property.</p>}
      {error && <p className="db-error" role="alert">{error}</p>}
      <button type="submit" className="db-primary" disabled={busy || !name.trim() || clash}>{busy ? "Adding…" : submitLabel}</button>
    </form>
  );
}
