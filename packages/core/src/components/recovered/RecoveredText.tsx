/**
 * "Recovered text" (server owner): what a page held when a newer copy replaced typing
 * that had not been saved, and pages whose live changes cannot be saved.
 *
 * Mounted in Network → Server (every page) and, filtered to one page, under the live
 * document's "replaced part of this page" notice. It renders NOTHING when the viewer is
 * not the server owner (the list answers 403), on the legacy desktop (no server), or when
 * the server is older — `fallback` is shown instead where the caller has one.
 *
 * Reading a kept text is audited by the server; nothing here stores it (it lives in
 * component state until the row is closed).
 */
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { isDesktop } from "../../lib/platform";
import { serverContextHeaders } from "../../lib/import-export/client";
import { RecoveredError, RecoveredUnavailable, recoveredApi, setAsideReason, sizeLabel, unsavedReason, type RecoveredList, type SetAsideEntry, type UnsavedEntry } from "../../lib/recovered/client";
import { copyText } from "../../lib/clipboard";

const when = (ms: number): string => (ms > 0 ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Unknown date");
const btn = "focus-ring inline-flex min-h-9 items-center rounded-lg border border-[var(--glass-border)] px-3 text-xs font-medium text-[var(--text-primary)] disabled:opacity-40";
const danger = `${btn} border-[var(--color-danger,#dc2626)]`;

export interface RecoveredTextProps {
  /** Only this page's entries (the live document's notice). */
  noteId?: string;
  /** The active-vault headers (`X-Prism-Vault`); default = the ones the shell installed. The routes act on that vault. */
  vaultHeaders?: () => Record<string, string>;
  /** Shown instead of nothing when the viewer cannot use this (not the server owner, no server). */
  fallback?: ReactNode;
  /** Card chrome (heading + explanation) — off under the document notice. */
  bare?: boolean;
}

export function RecoveredText({ noteId, vaultHeaders, fallback = null, bare = false }: RecoveredTextProps) {
  const headers = useRef(vaultHeaders);
  headers.current = vaultHeaders;
  const api = useMemo(() => recoveredApi(() => (headers.current ?? serverContextHeaders)()), []);
  const headingId = useId();
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [list, setList] = useState<RecoveredList>({ setAside: [], unsaved: [] });
  // null until the names have been looked up (the tree); an id missing from the map afterwards has no readable name.
  const [titles, setTitles] = useState<Record<string, string> | null>(null);
  const [open, setOpen] = useState<{ id: number; body: string | null; error?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  // `expect` is fixed when the form opens: what must be typed never changes under the person typing it.
  // …and `permanent` is what the form SAID about the page ("cannot be saved" / "still being saved").
  const [discard, setDiscard] = useState<{ noteId: string; typed: string; expect: string; permanent: boolean } | null>(null);
  // The workspace's own tree, where there is one (no provider on the share route / in a bare mount).
  const queryClient = useContext(QueryClientContext);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const next = await api.list();
      if (!alive.current) return null;
      const mine = noteId ? { setAside: next.setAside.filter((e) => e.noteId === noteId), unsaved: next.unsaved.filter((e) => e.noteId === noteId) } : next;
      setList(mine);
      setState("ready");
      const ids = [...new Set([...mine.setAside, ...mine.unsaved].map((e) => e.noteId))];
      // Always settles (cached tree, else one bounded request): Discard is never left waiting for names.
      void api.titles(ids, queryClient?.getQueryData(["vault", "tree"])).catch(() => ({})).then((t) => { if (alive.current) setTitles((prev) => ({ ...(prev ?? {}), ...t })); });
      return mine;
    } catch (e) {
      if (!alive.current) return;
      setState(e instanceof RecoveredUnavailable ? "unavailable" : "error");
      return null;
    }
  }, [api, noteId, queryClient]);
  useEffect(() => { if (!isDesktop) void load(); }, [load]);

  if (isDesktop || state === "unavailable") return <>{fallback}</>;
  if (state === "loading") return bare ? <p role="status" className="text-xs text-[var(--text-secondary)]">Looking for kept text…</p> : null;

  const name = (id: string): string => titles?.[id] ?? `Page ${id}`;
  /** What must be typed to discard: the page's own name — or, for a page with no name of its own
   *  ("Untitled", unreadable, deleted), the fixed word DISCARD (a name every such page shares proves nothing). */
  const confirmPhrase = (id: string): string => {
    const t = (titles?.[id] ?? "").trim();
    return t && t.toLowerCase() !== "untitled" ? t : "DISCARD";
  };
  const say = (text: string, error = false) => setMessage({ text, error });
  const failText = (e: unknown, what: string) => (e instanceof RecoveredError ? e.message : what);

  const view = async (entry: SetAsideEntry) => {
    if (open?.id === entry.id) { setOpen(null); return; }
    setOpen({ id: entry.id, body: null });
    try {
      const body = await api.read(entry.id);
      if (alive.current) setOpen((o) => (o?.id === entry.id ? { id: entry.id, body } : o));
    } catch (e) {
      if (alive.current) setOpen((o) => (o?.id === entry.id ? { id: entry.id, body: null, error: failText(e, "The text could not be loaded.") } : o));
    }
  };
  const copy = async (body: string) => {
    if (await copyText(body)) say("Copied.");
    else say("Copy is not available here — select the text and copy it.", true);
  };
  const remove = async (entry: SetAsideEntry) => {
    setBusy(true);
    try {
      await api.remove(entry.id);
      if (!alive.current) return;
      setConfirmDelete(null);
      if (open?.id === entry.id) setOpen(null);
      say("Deleted.");
      await load();
    } catch (e) { if (alive.current) say(failText(e, "The text could not be deleted."), true); }
    finally { if (alive.current) setBusy(false); }
  };
  const runDiscard = async (entry: UnsavedEntry, form: { permanent: boolean }) => {
    setBusy(true);
    try {
      // The list on screen may be minutes old. Ask again, and act on what is true NOW: a page that
      // was saved meanwhile is left alone, and `force` goes only to a page still listed as retrying.
      let now: RecoveredList;
      try {
        now = await api.list();
      } catch {
        // Not knowing is not "saved": nothing is sent, and nothing is claimed about the page.
        if (alive.current) say("Could not check the page’s current state. Nothing was discarded.", true);
        return;
      }
      if (!alive.current) return;
      const fresh = now.unsaved.find((u) => u.noteId === entry.noteId);
      if (!fresh) {
        setDiscard(null);
        say(`“${name(entry.noteId)}” has been saved in the meantime. Nothing was discarded.`);
        await load();
        return;
      }
      if (fresh.permanent !== form.permanent) {
        // What was confirmed is no longer what would be done (the server gave up on a page it was
        // still saving, or started saving one it had given up on): show the row as it is and ask again.
        setDiscard(null);
        say(fresh.permanent ? `The server has stopped trying to save “${name(entry.noteId)}”. Nothing was discarded — check the page and confirm again.` : `The server is saving “${name(entry.noteId)}” again. Nothing was discarded — confirm again to discard it anyway.`, true);
        await load();
        return;
      }
      const done = await api.discard(entry.noteId, !fresh.permanent);
      if (!alive.current) return;
      setDiscard(null);
      say(`Unsaved changes on “${name(entry.noteId)}” were discarded. The page shows what is stored${done.kept ? "; what it held is kept above for 90 days" : ""}.`);
      await load();
    } catch (e) {
      if (alive.current) say(e instanceof RecoveredError && e.code === "not_permanent" ? "The server is saving this page again. Nothing was discarded." : failText(e, "The changes could not be discarded."), true);
      if (alive.current) await load();
    } finally { if (alive.current) setBusy(false); }
  };

  const empty = list.setAside.length === 0 && list.unsaved.length === 0;
  const body = (
    <>
      {state === "error" && <p role="alert" className="text-xs text-[var(--text-primary)]">Recovered text could not be loaded. <button type="button" className="focus-ring underline" onClick={() => { setState("loading"); void load(); }}>Try again</button></p>}
      {state === "ready" && empty && (
        <p data-testid="recovered-empty" className="text-xs text-[var(--text-secondary)]">
          {noteId ? "Nothing was kept for this page." : "Nothing to recover. When a newer copy of a page replaces typing that was not saved yet, the page’s text is kept here."}
        </p>
      )}
      {list.setAside.length > 0 && (
        <ul aria-label="Recovered text" className="m-0 list-none p-0">
          {list.setAside.map((entry) => (
            <li key={entry.id} data-recovered={entry.id} className="border-b border-[var(--glass-border)] py-2 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-[var(--text-primary)]">{name(entry.noteId)}</div>
                  <div className="text-xs text-[var(--text-secondary)]">{when(entry.at)} · {sizeLabel(entry.bytes)} · {setAsideReason(entry.reason)}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={btn} aria-expanded={open?.id === entry.id} onClick={() => void view(entry)}>{open?.id === entry.id ? "Close" : "View"}<span className="sr-only"> text of {name(entry.noteId)}, {when(entry.at)}</span></button>
                  {confirmDelete === entry.id ? (
                    <>
                      <span className="text-xs text-[var(--text-primary)]">Delete this text for good?</span>
                      <button type="button" className={danger} disabled={busy} onClick={() => void remove(entry)}>Delete for good</button>
                      <button type="button" className={btn} disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" className={btn} onClick={() => setConfirmDelete(entry.id)}>Delete<span className="sr-only"> text of {name(entry.noteId)}, {when(entry.at)}</span></button>
                  )}
                </div>
              </div>
              {open?.id === entry.id && (
                <div role="region" aria-label={`Text of ${name(entry.noteId)} as it was`} className="mt-2">
                  {open.error ? <p role="alert" className="text-xs">{open.error}</p>
                    : open.body === null ? <p role="status" className="text-xs text-[var(--text-secondary)]">Loading…</p>
                    : (
                      <>
                        <pre tabIndex={0} className="focus-ring m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] p-3 text-xs text-[var(--text-primary)]">{open.body || "(empty)"}</pre>
                        <div className="mt-2 flex items-center gap-2">
                          <button type="button" className={btn} onClick={() => void copy(open.body ?? "")}>Copy text</button>
                          <span className="text-xs text-[var(--text-secondary)]">Plain text of the page as it was. Opening it was recorded in the audit log.</span>
                        </div>
                      </>
                    )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.unsaved.length > 0 && (
        <>
          <h4 className="mb-1 mt-4 text-xs font-semibold text-[var(--text-secondary)]">Pages with changes that are not saved</h4>
          <ul aria-label="Pages with changes that are not saved" className="m-0 list-none p-0">
            {list.unsaved.map((entry) => {
              const typing = discard?.noteId === entry.noteId ? discard : null;
              const fieldId = `${headingId}-discard-${entry.noteId}`;
              return (
                <li key={entry.noteId} data-unsaved={entry.noteId} className="border-b border-[var(--glass-border)] py-2 last:border-b-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-[var(--text-primary)]">{name(entry.noteId)}</div>
                      <div className="text-xs text-[var(--text-secondary)]">
                        {entry.permanent ? "Cannot be saved as it is" : "The server is still trying to save it"} · {unsavedReason(entry.reason)} · since {when(entry.since)}
                      </div>
                    </div>
                    {!typing && <button type="button" className={btn} disabled={titles === null} title={titles === null ? "Looking up the page’s name…" : undefined} onClick={() => setDiscard({ noteId: entry.noteId, typed: "", expect: confirmPhrase(entry.noteId), permanent: entry.permanent })}>{entry.permanent ? "Discard unsaved changes…" : "Discard anyway…"}<span className="sr-only"> on {name(entry.noteId)}</span></button>}
                  </div>
                  {typing && (
                    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (typing.typed.trim() === typing.expect && !busy) void runDiscard(entry, typing); }}>
                      <label htmlFor={fieldId} className="basis-full text-xs text-[var(--text-primary)]">
                        This drops the changes for good{typing.permanent ? "" : " — the server has not given up on saving them"}; the page becomes the stored page again (what it holds now is kept under Recovered text). Type <strong>{typing.expect}</strong> to confirm.
                      </label>
                      <input id={fieldId} autoComplete="off" spellCheck={false} value={typing.typed} onChange={(e) => setDiscard({ ...typing, typed: e.target.value })}
                        className="focus-ring min-h-9 min-w-0 flex-1 rounded-lg border border-[var(--glass-border)] bg-[var(--bg-base)] px-2 text-base text-[var(--text-primary)] sm:text-sm" />
                      <button type="submit" className={danger} disabled={busy || typing.typed.trim() !== typing.expect}>Discard changes</button>
                      <button type="button" className={btn} disabled={busy} onClick={() => setDiscard(null)}>Cancel</button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p role={message?.error ? "alert" : "status"} aria-live="polite" className="mt-2 min-h-4 text-xs text-[var(--text-primary)]">{message?.text ?? ""}</p>
    </>
  );
  if (bare) return <div data-testid="recovered-text">{body}</div>;
  return (
    <section aria-labelledby={headingId} data-testid="recovered-text" className="connections-card mb-5 rounded-xl border border-[var(--glass-border)] bg-[var(--bg-surface)] p-5">
      <h3 id={headingId} className="connections-section-title">Recovered text</h3>
      <p className="connections-help">
        When a newer copy of a page replaces typing that was not saved yet, the page’s text as it was is kept here for 90 days. Only the server owner can open it, and each opening is recorded.
      </p>
      {body}
    </section>
  );
}

/**
 * A live document's "Changes made elsewhere replaced part of this page." notice. The sentence is
 * the live region; the kept text opens BELOW it, outside the region (a list and a text block do
 * not belong inside a status paragraph, and must not be re-announced with every change).
 * The server owner recovers the text in place; everyone else is told who has it.
 */
export function ReplacedNotice({ noteId, owner, text, onDismiss, vaultHeaders }: { noteId: string; owner: boolean; text: string; onDismiss: () => void; vaultHeaders?: () => Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState(false);
  const ask = <span data-testid="recover-ask">Ask the workspace owner — the text was kept.</span>;
  const canRecover = owner && !isDesktop && !refused;
  return (
    <div className="rounded-lg border p-3 text-sm">
      <p role="status" data-testid="collab-notice" className="m-0">
        {text}{" "}
        {canRecover ? <button type="button" className="focus-ring underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Recover text</button> : ask}{" "}
        <button type="button" className="underline" onClick={onDismiss}>Dismiss</button>
      </p>
      {canRecover && open && <div className="mt-2" data-testid="recover-panel"><RecoveredText noteId={noteId} vaultHeaders={vaultHeaders} bare fallback={<Unavailable onShown={() => setRefused(true)} />} /></div>}
    </div>
  );
}
/** Rendered by RecoveredText when the server says this viewer is not the owner: flips the notice to "ask the owner". */
function Unavailable({ onShown }: { onShown: () => void }) {
  useEffect(() => { onShown(); }, [onShown]);
  return null;
}
