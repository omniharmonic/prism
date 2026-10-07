/**
 * Property management for the people who may change a tag's schema (the server
 * says who: `GET /api/schemas` → `canEdit`). NP-DB-11.
 *
 * The vault tag schema is shared by every note with the tag and is only ever
 * EXTENDED. So everything here except "add an option" is a presentation hint
 * stored by the Prism Server — no stored value and no vault type ever changes:
 *
 *   rename            → `label`            (the metadata key stays)
 *   change type       → `kind`             (only between presentations of the same
 *                                            vault type; the preview shows how the
 *                                            current values will read)
 *   option rename     → `optionLabels`     (stored value → display name)
 *   option colour     → `colors`
 *   option reorder    → `optionOrder`
 *   option delete     → `hiddenOptions`    (refused by the server while a page uses it)
 *   number format     → `format`
 *   status groups     → `statusGroups`
 *   delete            → `deleted`          (hidden on every surface; restorable)
 *
 * The one data deletion is explicit: "remove the values from every page" runs
 * the owner-only server job (dry run first, one compare-and-set write per page).
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useUpdateSchema } from "../../lib/database/hooks";
import type { RemoveValuesResult } from "../../lib/database/wire";
import { parseFileRef } from "../../lib/media/attachments";
import {
  compatibleKinds,
  isBlank,
  looksLikeEmail,
  looksLikePhone,
  NUMBER_FORMAT_LABELS,
  NUMBER_FORMATS,
  OPTION_COLORS,
  optionColor,
  PROPERTY_KIND_LABELS,
  PROPERTY_KINDS,
  propertyFromField,
  STATUS_GROUP_LABELS,
  defaultOptionLabel,
  STATUS_GROUPS,
  statusGroupOf,
  type FieldHints,
  type NumberFormat,
  type OptionColor,
  type PropertyDef,
  type PropertyKind,
  type SchemaField,
  type StatusGroup,
} from "../../lib/database/schema";
import { OptionChip, PropertyDisplay } from "./PropertyValue";

/** The server's own explanation, when it gave one. */
function serverDetail(e: unknown, fallback: string): string {
  const raw = String((e as Error)?.message ?? "");
  const at = raw.indexOf("{");
  if (at >= 0) {
    try {
      const body = JSON.parse(raw.slice(at)) as { detail?: unknown; reason?: unknown };
      const text = typeof body.detail === "string" ? body.detail : typeof body.reason === "string" ? body.reason : "";
      if (text) return text.charAt(0).toUpperCase() + text.slice(1);
    } catch { /* not JSON */ }
  }
  return raw && !/failed: \d{3}/.test(raw) && at < 0 ? raw : fallback;
}

/** Does a stored value read correctly as `kind`? (Preview only — nothing is converted.) */
export function fitsKind(kind: PropertyKind, v: unknown): boolean {
  const parts = Array.isArray(v) ? v : [v];
  return parts.every((x) => {
    if (typeof x !== "string") return kind === "text";
    switch (kind) {
      case "url": return /^https?:\/\//i.test(x);
      case "email": return looksLikeEmail(x);
      case "phone": return looksLikePhone(x);
      case "date": return /^\d{4}-\d{2}-\d{2}/.test(x);
      case "person":
      case "relation": return x.startsWith("[[");
      case "files": return !!parseFileRef(x);
      default: return true;
    }
  });
}

export function PropertyEditor({ propertyKey, field, tag, rows, onClose }: {
  propertyKey: string;
  /** The field as `GET /api/schemas` returns it (vault definition + hints). */
  field: SchemaField;
  tag: string;
  /** Loaded pages, for the change-type preview (their values are never written here). */
  rows: Array<{ metadata?: Record<string, unknown> | null }>;
  onClose: () => void;
}) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const schema = useUpdateSchema();
  const def: PropertyDef = propertyFromField(propertyKey, field, tag);
  const [name, setName] = useState(def.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingKind, setPendingKind] = useState<PropertyKind | null>(null);
  const [newOption, setNewOption] = useState("");
  const [deleting, setDeleting] = useState<null | "keep" | "remove">(null);
  const [plan, setPlan] = useState<RemoveValuesResult | null>(null);

  const apply = async (hints: FieldHints, fields?: Record<string, { enum?: string[] }>): Promise<boolean> => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await schema.update(tag, { ...(fields ? { fields } : {}), ui: { [propertyKey]: hints } });
      return true;
    } catch (e) {
      setError(serverDetail(e, "That change could not be saved. Nothing was changed."));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const allowed = compatibleKinds(field.type);
  const hasOptions = def.kind === "select" || def.kind === "status" || def.kind === "multi_select";
  const optionLabels = field.optionLabels ?? {};
  const hiddenOptions = field.hiddenOptions ?? [];
  const order = def.options.map((o) => o.value);
  const withValue = rows.map((r) => r.metadata?.[propertyKey]).filter((v) => !isBlank(v));

  const renameOption = (value: string, label: string) => {
    const next = { ...optionLabels };
    const text = label.trim();
    // The default name ("In progress" for `in-progress`) is not a rename: no hint is written for it.
    if (text && text !== value && text !== defaultOptionLabel(value)) next[value] = text;
    else delete next[value];
    if (JSON.stringify(next) !== JSON.stringify(optionLabels)) void apply({ optionLabels: next });
  };
  const moveOption = (value: string, dir: -1 | 1) => {
    const i = order.indexOf(value);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void apply({ optionOrder: next });
  };
  const addOption = async () => {
    const v = newOption.trim();
    if (!v || def.options.some((o) => o.value === v) || hiddenOptions.includes(v)) return;
    // An enum-backed select extends the vault enum (additive); free selects and
    // multi-selects keep their option list in the colour hints.
    const ok = def.enumValues.length ? await apply({}, { [propertyKey]: { enum: [...def.enumValues, v] } }) : await apply({ colors: { [v]: optionColor(v) } });
    if (ok) setNewOption("");
  };

  const canRemoveValues = !!client.removePropertyValues;
  const checkRemoval = async () => {
    if (!client.removePropertyValues) return;
    setBusy(true);
    setError("");
    try {
      setPlan(await client.removePropertyValues(tag, propertyKey, { dryRun: true }));
    } catch (e) {
      setError(serverDetail(e, "Prism could not check which pages hold a value. Nothing was changed."));
    } finally {
      setBusy(false);
    }
  };
  const confirmDelete = async () => {
    if (deleting === "remove" && !plan) return void checkRemoval();
    if (!field.deleted && !(await apply({ deleted: true }))) return;
    if (deleting === "remove") await removeNow();
    else setDeleting(null);
  };

  const previewDef: PropertyDef | null = pendingKind ? propertyFromField(propertyKey, { ...field, kind: pendingKind }, tag) : null;
  const fit = pendingKind ? withValue.filter((v) => fitsKind(pendingKind, v)).length : 0;

  // Portaled: the editor is opened from inside a property bar / table header, and must not inherit their layout or roles.
  return createPortal(
    <div className="db-dialog-wrap" role="presentation" onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <div className="db-dialog" role="dialog" aria-modal="true" aria-label={`Edit property ${def.label}`}>
        <header className="db-dialog-head">
          <h2>Edit property</h2>
          <button type="button" className="db-icon-btn" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <p className="db-pop-empty">Applies to every page tagged <code>#{tag}</code>. Stored as <code>{propertyKey}</code>.</p>

        {field.deleted ? (
          <section className="db-settings" aria-label="Deleted property">
            <p>“{def.label}” is deleted: it is hidden on every page, view and filter. Its values are still stored on the pages that had one.</p>
            <div className="db-settings-row">
              <button type="button" className="db-primary" disabled={busy} onClick={() => void apply({ deleted: false })}><RotateCcw size={13} aria-hidden="true" /> Restore property</button>
              {canRemoveValues && !plan && <button type="button" className="db-ghost" disabled={busy} onClick={() => void checkRemoval()}>Remove its values…</button>}
            </div>
            {plan && (
              <div role="group" aria-label="Remove values" className="db-plan">
                <RemovalPlan plan={plan} label={def.label} tag={tag} />
                <div className="db-settings-row">
                  <button type="button" className="db-ghost" disabled={busy} onClick={() => setPlan(null)}>Cancel</button>
                  <button type="button" className="db-primary db-danger" disabled={busy || plan.total === 0} onClick={() => void removeNow()}>{busy ? "Removing…" : `Remove ${plan.total} ${plan.total === 1 ? "value" : "values"}`}</button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <>
            <form className="db-settings" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name.trim() !== def.label) void apply({ label: name.trim() }); }}>
              <label className="db-field">
                <span>Name</span>
                <input aria-label="Property name" value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} />
              </label>
              {name.trim() !== def.label && <button type="submit" className="db-primary" disabled={busy || !name.trim()}>Rename</button>}
            </form>

            <section className="db-settings" aria-label="Type">
              <label className="db-field">
                <span>Type</span>
                <select aria-label="Property type" value={pendingKind ?? def.kind} disabled={busy} onChange={(e) => setPendingKind(e.target.value === def.kind ? null : (e.target.value as PropertyKind))}>
                  {PROPERTY_KINDS.map((k) => <option key={k} value={k} disabled={!allowed.includes(k) && k !== def.kind}>{PROPERTY_KIND_LABELS[k]}{!allowed.includes(k) && k !== def.kind ? " — needs a new property" : ""}</option>)}
                </select>
              </label>
              <p className="db-pop-empty">
                This property is stored as {field.type ?? "text"} for every <code>#{tag}</code> page, so it can be shown as {allowed.map((k) => PROPERTY_KIND_LABELS[k]).join(", ")}. Other types would change stored values; Prism never does that — add a new property instead.
              </p>
              {pendingKind && previewDef && (
                <div className="db-plan" role="group" aria-label="Type change preview">
                  <p><strong>Preview:</strong> {withValue.length === 0
                    ? `no loaded page has a value yet; new values will be ${PROPERTY_KIND_LABELS[pendingKind]}.`
                    : `${fit} of ${withValue.length} ${withValue.length === 1 ? "value" : "values"} will show as ${PROPERTY_KIND_LABELS[pendingKind]}${fit < withValue.length ? `; ${withValue.length - fit} ${withValue.length - fit === 1 ? "does" : "do"} not look like one and will show as plain text` : ""}.`}
                    {" "}No stored value changes, so you can switch back.</p>
                  {withValue.length > 0 && (
                    <ul aria-label="Examples">
                      {withValue.slice(0, 3).map((v, i) => <li key={i}><PropertyDisplay def={previewDef} value={v} /></li>)}
                    </ul>
                  )}
                  <div className="db-settings-row">
                    <button type="button" className="db-ghost" disabled={busy} onClick={() => setPendingKind(null)}>Cancel</button>
                    <button type="button" className="db-primary" disabled={busy} onClick={() => void apply({ kind: pendingKind }).then((ok) => { if (ok) setPendingKind(null); })}>Change type to {PROPERTY_KIND_LABELS[pendingKind]}</button>
                  </div>
                </div>
              )}
            </section>

            {def.kind === "number" && (
              <label className="db-field">
                <span>Number format</span>
                <select aria-label="Number format" value={def.format ?? "comma"} disabled={busy} onChange={(e) => void apply({ format: e.target.value as NumberFormat })}>
                  {NUMBER_FORMATS.map((f) => <option key={f} value={f}>{NUMBER_FORMAT_LABELS[f]}</option>)}
                </select>
              </label>
            )}

            {hasOptions && (
              <section className="db-settings" aria-label="Option settings">
                <p className="db-pop-heading">Options</p>
                <ul className="db-option-list" aria-label="Options">
                  {def.options.map((o, i) => (
                    <li key={o.value}>
                      <OptionChip value={o.value} label={o.label} color={o.color} />
                      <input aria-label={`Name of option ${o.value}`} defaultValue={o.label} key={`${o.value}:${o.label}`} maxLength={80} disabled={busy}
                        onBlur={(e) => renameOption(o.value, e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
                      <select aria-label={`Colour of ${o.label}`} value={o.color} disabled={busy} onChange={(e) => void apply({ colors: { [o.value]: e.target.value as OptionColor } })}>
                        {OPTION_COLORS.map((c) => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                      </select>
                      {def.kind === "status" && (
                        <select aria-label={`Group of ${o.label}`} value={o.group ?? statusGroupOf(o.value, field.statusGroups)} disabled={busy}
                          onChange={(e) => void apply({ statusGroups: { ...(field.statusGroups ?? {}), [o.value]: e.target.value as StatusGroup } })}>
                          {STATUS_GROUPS.map((g) => <option key={g} value={g}>{STATUS_GROUP_LABELS[g]}</option>)}
                        </select>
                      )}
                      <button type="button" className="db-icon-btn" aria-label={`Move ${o.label} up`} disabled={busy || i === 0} onClick={() => moveOption(o.value, -1)}><ArrowUp size={13} aria-hidden="true" /></button>
                      <button type="button" className="db-icon-btn" aria-label={`Move ${o.label} down`} disabled={busy || i === def.options.length - 1} onClick={() => moveOption(o.value, 1)}><ArrowDown size={13} aria-hidden="true" /></button>
                      <button type="button" className="db-icon-btn" aria-label={`Delete option ${o.label}`} disabled={busy} onClick={() => void apply({ hiddenOptions: [...hiddenOptions, o.value] })}><Trash2 size={13} aria-hidden="true" /></button>
                    </li>
                  ))}
                  {!def.options.length && <li className="db-pop-empty">No options yet.</li>}
                </ul>
                <form className="db-settings-row" onSubmit={(e) => { e.preventDefault(); void addOption(); }}>
                  <input className="db-control" aria-label="New option" placeholder="New option" value={newOption} maxLength={80} disabled={busy} onChange={(e) => setNewOption(e.target.value)} />
                  <button type="submit" className="db-ghost" disabled={busy || !newOption.trim()}><Plus size={13} aria-hidden="true" /> Add option</button>
                </form>
                {hiddenOptions.length > 0 && (
                  <ul className="db-option-list" aria-label="Deleted options">
                    {hiddenOptions.map((v) => (
                      <li key={v}>
                        <span className="db-pop-empty" style={{ flex: 1 }}>{optionLabels[v] ?? defaultOptionLabel(v)} (deleted)</span>
                        <button type="button" className="db-ghost" disabled={busy} aria-label={`Restore option ${optionLabels[v] ?? defaultOptionLabel(v)}`} onClick={() => void apply({ hiddenOptions: hiddenOptions.filter((x) => x !== v) })}><RotateCcw size={12} aria-hidden="true" /> Restore</button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className="db-settings" aria-label="Delete">
              {deleting === null ? (
                <button type="button" className="db-ghost" style={{ color: "var(--color-danger)", justifySelf: "start" }} disabled={busy} onClick={() => setDeleting("keep")}><Trash2 size={13} aria-hidden="true" /> Delete property…</button>
              ) : (
                <div role="group" aria-label="Delete property" className="db-plan">
                  <p>Deleting hides “{def.label}” on every <code>#{tag}</code> page, view and filter. What should happen to its values?</p>
                  <label className="db-radio"><input type="radio" name="db-delete-mode" checked={deleting === "keep"} onChange={() => { setDeleting("keep"); setPlan(null); }} /> Keep the values (the property can be restored)</label>
                  <label className="db-radio"><input type="radio" name="db-delete-mode" checked={deleting === "remove"} disabled={!canRemoveValues} onChange={() => setDeleting("remove")} /> Remove the values from every page{!canRemoveValues ? " (not available here)" : ""}</label>
                  {deleting === "remove" && plan && <RemovalPlan plan={plan} label={def.label} tag={tag} />}
                  <div className="db-settings-row">
                    <button type="button" className="db-ghost" disabled={busy} onClick={() => { setDeleting(null); setPlan(null); }}>Cancel</button>
                    <button type="button" className="db-primary db-danger" disabled={busy} onClick={() => void confirmDelete()}>
                      {busy ? "Working…" : deleting === "keep" ? "Delete property" : plan ? `Delete and remove ${plan.total} ${plan.total === 1 ? "value" : "values"}` : "Check what would be removed"}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </>
        )}
        {notice && <p role="status" className="db-notice">{notice}</p>}
        {error && <p role="alert" className="db-error">{error}</p>}
      </div>
    </div>,
    document.body,
  );

  async function removeNow() {
    if (!client.removePropertyValues) return;
    setBusy(true);
    setError("");
    try {
      // Short requests: the server handles a few hundred pages (or ~20 s) per call and says
      // `more`; each call re-lists, so a page is never written twice.
      let removed = 0;
      let left = 0;
      for (let round = 0; round < 60; round++) {
        const out = await client.removePropertyValues(tag, propertyKey, { dryRun: false, limit: 500 });
        removed += out.removed ?? 0;
        left = (out.conflicts ?? 0) + (out.failed ?? 0);
        setNotice(`Removing… ${removed} ${removed === 1 ? "page" : "pages"} so far.`);
        if (!out.more || !(out.removed ?? 0)) break;
      }
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "vault" && (q.queryKey[1] === "notes" || q.queryKey[1] === "note") });
      setNotice(`Removed the value from ${removed} ${removed === 1 ? "page" : "pages"}.${left ? ` ${left} changed meanwhile or could not be written and still hold a value — remove values again to retry.` : ""}`);
      setPlan(null);
    } catch (e) {
      setError(serverDetail(e, "The values could not be removed. They are still stored on their pages."));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }
}

function RemovalPlan({ plan, label, tag }: { plan: RemoveValuesResult; label: string; tag: string }) {
  const kept = plan.skipped.shared + plan.skipped.trashed + plan.skipped.system + (plan.skipped.ingest ?? 0) + (plan.skipped.private ?? 0);
  return (
    <p role="status">
      <strong>{plan.total} {plan.total === 1 ? "page holds" : "pages hold"} a “{label}” value.</strong>{" "}
      Removing clears it from {plan.total === 1 ? "that page" : "those pages"} (tagged <code>#{tag}</code>); the page text is not touched. It can only be brought back page by page from version history.
      {kept > 0 && ` ${kept} ${kept === 1 ? "page is" : "pages are"} left alone (in the Trash, kept in sync by an integration, a system page, someone else’s private page, or the value also belongs to another tag’s property).`}
      {plan.truncated && " This tag is very large; only the first pages were counted."}
    </p>
  );
}
