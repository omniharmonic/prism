/**
 * "New database" — Blank with schema. A database with its OWN new tag:
 *   name → a tag is minted from it (`reading-list`, `reading-list-2`… — only one the
 *   SERVER calls available: no pages, no properties, nobody shares or publishes it;
 *   shown and editable) → the properties it starts with (the one-step property form,
 *   several, reorderable; a Status starter is offered) → its first view → create.
 * Creating is `createBlankDatabase`: the page, then the tag's properties (`requireNew`
 * — the server checks the tag again), then the view; a failure keeps its progress so
 * "Try again" continues instead of starting over.
 *
 * Schema writes are the workspace owner's: anyone else is told so and offered
 * "Use an existing tag" (a database over a tag that already exists).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { buildNewPropertyPatch, PROPERTY_KIND_LABELS, type SchemaPatch } from "../../lib/database/schema";
import type { Note } from "../../lib/types";
import { VIEW_LABELS, VIEW_TYPES, type ViewType } from "./config";
import {
  blankDatabaseView,
  blankViewRefusal,
  createBlankDatabase,
  mintNewTag,
  NEW_TAG_NAME,
  NewDatabaseError,
  newTagAvailability,
  tagFromName,
  type NewDatabaseProgress,
  type NewDatabaseProperty,
} from "./createDatabase";
import { NewPropertyForm } from "./NewPropertyForm";

/** The Status property a new database is offered to start with (removable). */
export function starterStatusProperty(): NewDatabaseProperty {
  const built = buildNewPropertyPatch({
    label: "Status", kind: "status",
    options: [
      { value: "To do", color: "gray", group: "todo" },
      { value: "In progress", color: "blue", group: "in_progress" },
      { value: "Done", color: "green", group: "complete" },
    ],
  });
  if (!built.ok) throw new Error(built.error);
  return { key: built.key, field: built.patch.fields![built.key]!, ui: built.patch.ui![built.key]! };
}

type TagState = { state: "idle" | "checking" | "ok" | "refused" | "error"; detail?: string };

export function NewDatabaseDialog({ folder = "", initialName = "", initialView = "table", onClose, onCreated, onUseExistingTag }: {
  /** Folder for the new database page ("" = the top level). */
  folder?: string;
  initialName?: string;
  initialView?: ViewType;
  onClose: () => void;
  /** The new database page, once it exists and is configured (open it). */
  onCreated?: (note: Pick<Note, "id" | "path">, title: string) => void;
  /** The older path: a database over a tag that already exists. Absent = not offered. */
  onUseExistingTag?: () => void;
}) {
  const client = useVaultClient();
  const qc = useQueryClient();
  const schemas = useQuery({
    queryKey: ["vault", "schemas", "new-database"],
    queryFn: () => client.getSchemas!(),
    enabled: !!client.getSchemas,
    retry: false,
  });
  const [name, setName] = useState(initialName);
  const [tag, setTag] = useState("");
  const [tagEdited, setTagEdited] = useState(false);
  const [tagState, setTagState] = useState<TagState>({ state: "idle" });
  const [recheck, setRecheck] = useState(0);
  const [properties, setProperties] = useState<NewDatabaseProperty[]>(() => [starterStatusProperty()]);
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<ViewType>(initialView);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // What a failed attempt already made: a retry continues from there.
  const [progress, setProgress] = useState<NewDatabaseProgress | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const server = !!client.updateSchema && !!client.getSchemas;
  const owner = schemas.data?.canEdit === true;
  // Once the tag is claimed (schema written) it can no longer change.
  const tagLocked = !!progress?.schemaDone || !!progress?.schemaBatches;
  const knownTags = useMemo(() => Object.keys((schemas.data?.schemas ?? {}) as Record<string, unknown>), [schemas.data]);

  useEffect(() => { nameInput.current?.focus(); }, [owner]);

  // Mint (or check) the tag a moment after the name / tag stops changing.
  useEffect(() => {
    if (!server || !owner || tagLocked) return;
    const mine = ++seq.current;
    const typed = tag.trim();
    if (!tagEdited && !name.trim()) { setTag(""); setTagState({ state: "idle" }); return; }
    if (tagEdited && !typed) { setTagState({ state: "idle" }); return; }
    if (tagEdited && !NEW_TAG_NAME.test(typed)) { setTagState({ state: "refused", detail: "Use a tag name: letters, numbers, - or _." }); return; }
    setTagState({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        if (tagEdited) {
          const a = await newTagAvailability(client, typed);
          if (mine !== seq.current) return;
          setTagState(a.available ? { state: "ok" } : { state: "refused", detail: a.detail ?? `#${typed} is already in use` });
        } else {
          const m = await mintNewTag(client, tagFromName(name));
          if (mine !== seq.current) return;
          if (m.tag !== null) { setTag(m.tag); setTagState({ state: "ok" }); } else { setTag(tagFromName(name)); setTagState({ state: "refused", detail: m.detail }); }
        }
      } catch {
        if (mine === seq.current) setTagState({ state: "error", detail: "Prism could not check the tag." });
      }
    }, 350);
    return () => clearTimeout(t);
    // `tag` is a dependency only while the person types it (minting sets it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, tagEdited ? tag : "", tagEdited, server, owner, recheck, tagLocked]);

  const viewRefusal = blankViewRefusal(view, properties);
  const ready = !!name.trim() && (tagLocked || tagState.state === "ok") && !viewRefusal && !adding;

  const move = (i: number, d: -1 | 1) => setProperties((cur) => {
    const j = i + d;
    if (j < 0 || j >= cur.length) return cur;
    const next = [...cur];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });
  const addProperty = async (_tag: string, key: string, patch: SchemaPatch) => {
    // Nothing is written here: the properties go out with the database, in one claim of the tag.
    setProperties((cur) => [...cur, { key, field: patch.fields![key]!, ui: patch.ui![key]! }]);
  };

  const create = async () => {
    if (!ready || busy) return;
    const title = name.trim();
    const t = tag.trim();
    setBusy(true); setError("");
    try {
      const out = await createBlankDatabase(client, { tag: t, title, folder, properties, view: blankDatabaseView(view, properties)! }, progress ?? undefined);
      setProgress(null);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "vault" && (q.queryKey[1] === "notes" || q.queryKey[1] === "tree" || q.queryKey[1] === "schemas" || q.queryKey[1] === "tags") });
      onCreated?.(out.note, title);
      onClose();
    } catch (e) {
      void qc.invalidateQueries({ queryKey: ["vault", "tree"] });
      if (!(e instanceof NewDatabaseError)) { setError("The database could not be created. Nothing was created."); return; }
      const p = e.progress;
      setProgress(p.note || p.schemaDone || p.schemaBatches ? p : null);
      const why = e.detail ? `${e.detail.charAt(0).toUpperCase()}${e.detail.slice(1)}. ` : "";
      if (e.stage === "page") setError(`${why}The database page could not be created. Nothing was created.`);
      else if (e.stage === "schema") {
        if (p.schemaBatches) setError(`${why}Some properties were created; the rest were not. Try again to finish.`);
        else {
          // The tag was refused (or the write failed) before any of it existed: choose again.
          setError(!p.note || e.pageRemoved ? `${why}Nothing was created.` : `${why}An empty database page “${title}” was created but could not be removed.`);
          setProgress(p.note && !e.pageRemoved ? p : null);
          setRecheck((n) => n + 1);
        }
      } else setError(`${why}The tag and its properties were created, but the database page could not be set up. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  const retrying = !!progress && (tagLocked || !!progress.note);
  return (
    <div className="db-dialog-wrap" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || busy) return;
        e.preventDefault();
        e.stopPropagation();
        if (adding) setAdding(false); else onClose();
      }}>
      <div className="db-dialog db-dialog-wide" role="dialog" aria-modal="true" aria-label="New database">
        <header className="db-dialog-head"><h2>New database</h2><button type="button" className="db-icon-btn" aria-label="Close" disabled={busy} onClick={onClose}><X size={14} aria-hidden="true" /></button></header>
        {!server ? (
          <p className="db-pop-empty">A database with its own properties needs the Prism Server.</p>
        ) : schemas.isPending ? (
          <p className="db-pop-empty" role="status">Checking what you can create…</p>
        ) : !owner ? (
          <p className="db-pop-empty" role="note">A new database adds a tag and its properties to the workspace, and only the workspace owner can do that. Ask the owner to create it, or show the pages of a tag that already exists.</p>
        ) : (
          <>
            <div className="db-date-row">
              <label className="db-field"><span>Name</span>
                <input ref={nameInput} aria-label="Database name" value={name} maxLength={120} disabled={busy || !!progress?.note} placeholder="e.g. Reading list" onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="db-field"><span>Tag for its pages</span>
                <input aria-label="Tag for its pages" value={tag} maxLength={64} spellCheck={false} disabled={busy || tagLocked} placeholder={name.trim() ? "…" : "minted from the name"}
                  onChange={(e) => { setTag(e.target.value.replace(/^#/, "")); setTagEdited(true); }} />
              </label>
            </div>
            <p className="db-newdb-tag" aria-live="polite" data-state={tagState.state}>
              {tagLocked ? `Pages of this database are tagged #${tag}.`
                : tagState.state === "checking" ? "Checking the tag…"
                : tagState.state === "ok" ? `Every page of this database will be tagged #${tag.trim()} — a new tag, used by nothing else.`
                : tagState.state === "refused" || tagState.state === "error" ? <span className="db-error">{tagState.detail}{tagEdited && tagState.state === "refused" ? " Choose another tag." : ""}</span>
                : "A new tag is made from the name."}
              {tagEdited && !tagLocked && <> <button type="button" className="db-ghost" onClick={() => { setTagEdited(false); setRecheck((n) => n + 1); }}>Use the name</button></>}
            </p>

            <section aria-label="Properties">
              <p className="db-pop-heading">Properties — every page has a Title; these come with it</p>
              {properties.length > 0 ? (
                <ul className="db-newdb-props" aria-label="Properties of the new database">
                  {properties.map((p, i) => {
                    const label = p.ui.label ?? p.key;
                    const target = p.ui.relationTarget ? ("tag" in p.ui.relationTarget ? `#${p.ui.relationTarget.tag}` : p.ui.relationTarget.pathPrefix) : p.ui.relationTag ? `#${p.ui.relationTag}` : "";
                    return (
                      <li key={p.key} className="db-newdb-prop">
                        <span className="db-newdb-prop-name">{label}</span>
                        <span className="db-newdb-prop-kind">{p.ui.kind ? PROPERTY_KIND_LABELS[p.ui.kind] : p.field.type}{target ? ` → ${target}` : ""}{p.field.enum?.length ? ` · ${p.field.enum.join(", ")}` : ""}</span>
                        <button type="button" className="db-icon-btn" aria-label={`Move ${label} up`} disabled={busy || tagLocked || i === 0} onClick={() => move(i, -1)}><ArrowUp size={12} aria-hidden="true" /></button>
                        <button type="button" className="db-icon-btn" aria-label={`Move ${label} down`} disabled={busy || tagLocked || i === properties.length - 1} onClick={() => move(i, 1)}><ArrowDown size={12} aria-hidden="true" /></button>
                        <button type="button" className="db-icon-btn" aria-label={`Remove ${label}`} disabled={busy || tagLocked} onClick={() => setProperties((cur) => cur.filter((x) => x.key !== p.key))}><X size={12} aria-hidden="true" /></button>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="db-pop-empty">Only a Title. You can add properties now or later.</p>}
              {adding ? (
                <div className="db-newdb-form">
                  <NewPropertyForm tags={[tag.trim() || "new"]} schemaBacked knownTags={knownTags} existing={properties.map((p) => p.key)} heading="New property" submitLabel="Add to the database"
                    onCreateSchema={addProperty} onDone={() => setAdding(false)} />
                  <button type="button" className="db-ghost" onClick={() => setAdding(false)}>Cancel</button>
                </div>
              ) : (
                <button type="button" className="db-ghost" disabled={busy || tagLocked || properties.length >= 60} onClick={() => setAdding(true)}><Plus size={13} aria-hidden="true" /> Add a property</button>
              )}
            </section>

            <fieldset className="db-newdb-views" disabled={busy || !!progress?.configDone}>
              <legend className="db-field-legend">First view</legend>
              {VIEW_TYPES.map((v) => (
                <label key={v} className="db-radio"><input type="radio" name="db-newdb-view" value={v} checked={view === v} onChange={() => setView(v)} /> {VIEW_LABELS[v]}</label>
              ))}
            </fieldset>
            {viewRefusal && <p className="db-error" role="alert">{viewRefusal}</p>}
          </>
        )}
        {error && <p className="db-error" role="alert">{error}</p>}
        <div className="db-settings-row">
          {onUseExistingTag ? <button type="button" className="db-ghost" disabled={busy} onClick={onUseExistingTag}>Use an existing tag</button> : <span />}
          {server && owner && (
            <button type="button" className="db-primary" disabled={busy || !ready} onClick={() => void create()}>
              {busy ? "Creating…" : retrying ? "Try again" : "Create database"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
