/**
 * Database page templates (Notion's "+ New ▾").
 *
 * A template is an ordinary vault note under the database page's folder
 * (`<db>/Templates/<name>`) that does NOT carry the source tags — so it is never
 * a row, a task, or a search hit for the view. Its BODY is the new row's body;
 * `metadata.prism_template_props` holds the property values a new row starts
 * with. The database note lists them in `prism_database.templates` (+ an
 * optional `defaultTemplate` that plain "+ New" uses).
 */
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, FileText, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { queryKeys } from "../../lib/parachute/queries";
import { isFieldKey } from "../../lib/database/query";
import { isSystemKey, type PropertyDef } from "../../lib/database/schema";
import type { Note } from "../../lib/types";
import { Popover } from "./Popover";
import { PropertyValue } from "./PropertyValue";
import { newViewId, TEMPLATE_FOR_KEY, TEMPLATE_PROPS_KEY, type DatabaseConfig, type DatabaseTemplate } from "./config";

/** The property values a template gives a new row (only real property keys). */
export function templateProps(note: Pick<Note, "metadata"> | null | undefined): Record<string, unknown> {
  const raw = note?.metadata?.[TEMPLATE_PROPS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k, v]) => isFieldKey(k) && !isSystemKey(k) && v !== null && v !== undefined));
}

/** "+ New" with its template menu. `onNew(templateId|null)` creates a row. */
export function NewButton({ config, canManage, onNew, onCreateTemplate, onEdit, onSetDefault, onRemove }: {
  config: DatabaseConfig;
  canManage: boolean;
  onNew: (templateId: string | null) => void;
  onCreateTemplate: (name: string) => Promise<void>;
  onEdit: (t: DatabaseTemplate) => void;
  onSetDefault: (id: string | undefined) => void;
  onRemove: (t: DatabaseTemplate) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const templates = config.templates ?? [];
  const close = () => { setOpen(false); setNaming(false); setName(""); setError(""); };
  return (
    <span className="db-split">
      <button type="button" className="db-primary db-split-main" onClick={() => onNew(config.defaultTemplate ?? null)}><Plus size={14} aria-hidden="true" /> New</button>
      <button ref={anchor} type="button" className="db-primary db-split-more" aria-label="New page from a template" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><ChevronDown size={14} aria-hidden="true" /></button>
      <Popover anchor={anchor} open={open} onClose={close} label="Templates" width={300}>
        <p className="db-pop-heading">New page</p>
        <div className="db-menu" role="menu" aria-label="Templates">
          <button type="button" role="menuitem" onClick={() => { close(); onNew(null); }}><FileText size={14} aria-hidden="true" /> Empty page {!config.defaultTemplate && <Check size={13} className="db-pop-tick" aria-label="default" />}</button>
          {templates.map((t) => (
            <div key={t.id} className="db-template-row">
              <button type="button" role="menuitem" onClick={() => { close(); onNew(t.id); }}>
                <FileText size={14} aria-hidden="true" /> <span className="db-pop-title">{t.name}</span>
                {config.defaultTemplate === t.id && <Check size={13} className="db-pop-tick" aria-label="default" />}
              </button>
              {canManage && <>
                <button type="button" className="db-icon-btn" aria-label={`Make ${t.name} the default`} title="Use for + New" onClick={() => { onSetDefault(config.defaultTemplate === t.id ? undefined : t.id); }}><Star size={13} /></button>
                <button type="button" className="db-icon-btn" aria-label={`Edit template ${t.name}`} onClick={() => { close(); onEdit(t); }}><Pencil size={13} /></button>
                <button type="button" className="db-icon-btn" aria-label={`Remove template ${t.name}`} onClick={() => onRemove(t)}><Trash2 size={13} /></button>
              </>}
            </div>
          ))}
        </div>
        {canManage && (naming ? (
          <form className="db-new-prop" onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || busy) return;
            setBusy(true);
            setError("");
            void onCreateTemplate(name.trim()).then(close).catch((err: unknown) => setError(err instanceof Error && !/failed: \d{3}/.test(err.message) ? err.message : "The template could not be created.")).finally(() => setBusy(false));
          }}>
            <label className="db-field"><span>Template name</span><input aria-label="Template name" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bug report" /></label>
            {error && <p className="db-error" role="alert">{error}</p>}
            <button type="submit" className="db-primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create template"}</button>
          </form>
        ) : templates.length < 20 && (
          <button type="button" className="db-pop-create" onClick={() => setNaming(true)}><Plus size={14} aria-hidden="true" /> New template</button>
        ))}
      </Popover>
    </span>
  );
}

/** Edit a template: name, starting property values, and (as a page) its body. */
export function TemplateEditor({ template, props, onRename, onOpenBody, onClose }: {
  template: DatabaseTemplate;
  props: PropertyDef[];
  onRename: (name: string) => void;
  onOpenBody: () => void;
  onClose: () => void;
}) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const [name, setName] = useState(template.name);
  const note = useQuery({ queryKey: queryKeys.vault.note(template.id), queryFn: () => client.getNote(template.id, { fresh: true }) });
  const values = templateProps(note.data);
  const editable = props.filter((p) => !p.system);
  const commit = (def: PropertyDef) => async (next: unknown) => {
    // Read-merge-write the whole props object against the revision just read (CAS).
    const fresh = await client.getNote(template.id, { fresh: true });
    const merged = { ...templateProps(fresh) };
    if (next === null) delete merged[def.key]; else merged[def.key] = next;
    const saved = await client.updateNote(template.id, { metadata: { [TEMPLATE_PROPS_KEY]: merged }, ifUpdatedAt: fresh.updatedAt ?? undefined });
    qc.setQueryData(queryKeys.vault.note(template.id), saved);
  };
  return (
    <div className="db-dialog-wrap" role="presentation" onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".db-popover")) { e.preventDefault(); onClose(); } }}>
      <div className="db-dialog" role="dialog" aria-modal="true" aria-label={`Template: ${template.name}`}>
        <header className="db-dialog-head"><h2>Edit template</h2><button type="button" className="db-icon-btn" aria-label="Close" onClick={onClose}>×</button></header>
        <label className="db-field"><span>Name</span><input aria-label="Template name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name.trim() !== template.name) onRename(name.trim()); }} /></label>
        <p className="db-pop-heading">New pages start with</p>
        {note.isLoading ? <p className="db-pop-empty">Loading…</p> : note.isError ? <p className="db-error" role="alert">The template could not be loaded.</p> : (
          <div className="db-props db-props-panel" role="group" aria-label="Template properties">
            {editable.map((def) => (
              <div className="db-prop" key={def.key} data-kind={def.kind}>
                <span className="db-prop-label">{def.label}</span>
                <PropertyValue def={def} value={values[def.key]} variant="panel" onCommit={commit(def)} />
              </div>
            ))}
            {!editable.length && <p className="db-pop-empty">This database has no properties yet.</p>}
          </div>
        )}
        <div className="db-settings-row">
          <button type="button" className="db-ghost" onClick={onOpenBody}><FileText size={13} aria-hidden="true" /> Edit the template’s page content</button>
          <button type="button" className="db-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** Create a template note for `db` and return its config entry. */
export async function createTemplateNote(client: { createNote: (p: { content: string; path?: string; tags?: string[]; metadata?: Record<string, unknown> }) => Promise<Note> }, db: Pick<Note, "id" | "path">, name: string): Promise<DatabaseTemplate> {
  const base = (db.path ?? "").replace(/\.[^./]+$/, "");
  const leaf = name.replace(/[\\/]/g, "-").slice(0, 80);
  const n = await client.createNote({
    content: "",
    path: `${base ? `${base}/` : ""}Templates/${leaf} ${newViewId().slice(1, 5)}`,
    tags: [],
    metadata: { title: name, [TEMPLATE_FOR_KEY]: db.id, [TEMPLATE_PROPS_KEY]: {} },
  });
  return { id: n.id, name };
}
