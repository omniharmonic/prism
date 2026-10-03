import { isAccessUnavailable } from "../../data/VaultClient";
import { noteLinkTitle } from "../../lib/wikilinks";
import { isVaultNoteId } from "../../lib/noteIdentity";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { remoteAdoption } from "../../app/hooks/useAutoSave";
import { Compass } from "lucide-react";
import { useUIStore } from "../../app/stores/ui";
import { useNote, useUpdateNote } from "../../app/hooks/useParachute";
import { inferContentType } from "../../lib/schemas/content-types";
import { getRenderer } from "../renderers/Registry";
import { useCollabDocumentSeam } from "../../data/CollabDocumentContext";
import { TagView } from "../navigation/TagView";
import { TabBar } from "./TabBar";
import { RendererBoundary } from "./RendererBoundary";
import { reviewMode } from "../../lib/governance/review";
import { Skeleton } from "../ui/Skeleton";
import type { Note } from "../../lib/types";
import { isLocked, pageStyleOf } from "../../lib/pages/model";
import { LockedBanner } from "../pages/LockedBanner";
import { RequestAccessButton } from "../inbox/RequestAccessButton";
import { useUnreadCount } from "../../lib/notifications/hooks";
import { OfflineCopyNotice, offlineCopyAt } from "./OfflineCopyNotice";

function subscribeOnline(notify: () => void) {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => { window.removeEventListener("online", notify); window.removeEventListener("offline", notify); };
}

export function Canvas() {
  const openTabs = useUIStore((s) => s.openTabs);
  const activeTabId = useUIStore((s) => s.activeTabId);
  const activeTab = openTabs.find((t) => t.id === activeTabId);

  // Tag views are a special virtual tab type
  const isTagView = activeTab?.noteId.startsWith("tag:");

  // Virtual notes (e.g., matrix:room_id, messages-dashboard, calendar-dashboard) don't come from Parachute
  const isVirtual = !!activeTab && !isVaultNoteId(activeTab.noteId);
  const parachuteNoteId = isVirtual ? null : (activeTab?.noteId ?? null);

  const { data: note, isLoading, isError, error, isFetching, refetch, dataUpdatedAt } = useNote(parachuteNoteId);
  const accessUnavailable = isAccessUnavailable(error);
  // Request access (NP-CO-13) needs a Prism Server with notifications.
  const canRequestAccess = useUnreadCount().available;
  useEffect(() => {
    if (!parachuteNoteId) return;
    if (accessUnavailable) useUIStore.getState().renameTab(parachuteNoteId, "Unavailable document");
    else if (note) useUIStore.getState().renameTab(parachuteNoteId, noteLinkTitle(note));
  }, [parachuteNoteId, accessUnavailable, note]);
  const { mutate: updateNote } = useUpdateNote();

  // For virtual notes, construct a synthetic Note object
  const effectiveNote: Note | null = useMemo(() => {
    if (note) return note;
    if (isVirtual && activeTab) {
      return {
        id: activeTab.noteId,
        content: "",
        path: activeTab.title,
        metadata: {
          type: activeTab.type,
          matrix_room_id: activeTab.noteId.replace("matrix:", ""),
        },
        createdAt: new Date().toISOString(),
        updatedAt: null,
        tags: null,
      };
    }
    return null;
  }, [note, isVirtual, activeTab]);

  const handleSave = useCallback(
    (content: string) => {
      if (!note || isVirtual) return;
      updateNote({ id: note.id, content });
    },
    [note, isVirtual, updateNote],
  );

  const handleMetadataChange = useCallback(
    (metadata: Record<string, unknown>) => {
      if (!note || isVirtual) return;
      updateNote({ id: note.id, metadata });
    },
    [note, isVirtual, updateNote],
  );

  // For virtual tabs, use the tab type directly (inferContentType doesn't know virtual types)
  const contentType = isVirtual ? (activeTab?.type ?? null) : (effectiveNote ? inferContentType(effectiveNote) : (activeTab?.type ?? null));
  const Renderer = contentType ? getRenderer(contentType) : null;

  // Collab-capable notes render in the live collaborative editor so every session
  // (this one, another browser, a phone) sees edits in real time with no refresh.
  // The seam's CollabDocument auto-detects the kind (document → prose, code →
  // CodeMirror, spreadsheet → grid, canvas → Excalidraw). The hook is called
  // unconditionally; shells that provide collab return true for these kinds, the
  // default (offline shells) returns false → plain autosave editor.
  const COLLAB_TYPES = new Set(["document", "task", "code", "spreadsheet", "canvas"]);
  const collab = useCollabDocumentSeam();
  const collabDocId =
    !isVirtual && effectiveNote && contentType && COLLAB_TYPES.has(contentType) ? effectiveNote.id : "";
  // ── P4 (WEB, NON-OWNER ONLY) ──────────────────────────────────────────────
  // A note the actor may PROPOSE on but not edit does not belong in the live
  // CRDT session: every keystroke there is either refused or lands in a shared
  // document they have no right to change. Route them to the plain renderer
  // instead, which offers "Submit for review" (DocumentRenderer + ReviewBanner).
  // Gated entirely on the gateway's `_caps` annotation, which only a non-owner
  // web response ever carries — `reviewMode` is "none" for every desktop client
  // and every owner, so `isLiveDoc` is computed exactly as before for them.
  // Wave 3: "propose" now means GOVERNANCE review applies (`_review: "governance"`,
  // or create-without-suggest). A plain suggest-level share stays in the live
  // editor: its socket is read-only server-side and suggestions/comments go through
  // the command endpoint — the same suggest-only editor `/collab/:id` gives.
  const proposeOnly = reviewMode(effectiveNote) === "propose";
  const noteRevision = useUIStore((s) => (effectiveNote ? s.noteRevisions[effectiveNote.id] ?? 0 : 0));
  // Lock page (metadata.prism_locked): read-only for everyone until unlocked. A locked
  // page leaves the live session too — its keystrokes must not reach the shared doc.
  const locked = !isVirtual && isLocked(effectiveNote);
  const isLiveDoc = collab.useLiveCollab(collabDocId) && collabDocId !== "" && !proposeOnly && !locked;
  // NP-OF-05: an open PLAIN editor reads `note.content` once, at mount. When a
  // re-read (events channel, focus refetch) brings content this editor neither
  // shows nor wrote, an IDLE editor remounts on it; one with local edits keeps
  // them (the save's 409 → "Needs review" path settles it). Live collab docs
  // get remote edits through their socket and never come here.
  const shown = useRef<{ id: string; content: string } | null>(null);
  const plainNote = !isVirtual && !isLiveDoc && note ? note : null;
  useEffect(() => {
    if (!plainNote) { shown.current = null; return; }
    const content = plainNote.content ?? "";
    if (shown.current?.id !== plainNote.id) { shown.current = { id: plainNote.id, content }; return; }
    if (shown.current.content === content) return;
    const verdict = remoteAdoption(plainNote.id, content);
    if (verdict === "keep" || verdict === "none") return; // re-judged on the next re-read
    shown.current = { id: plainNote.id, content };
    if (verdict === "adopt") useUIStore.getState().bumpNoteRevision(plainNote.id);
  }, [plainNote]);

  // NP-SR-07: back/forward (⌘[ / ⌘], the header arrows, the phone edge swipe)
  // return to where the page was scrolled. Positions are remembered per tab for
  // this session; an ordinary open or tab click does not restore (a deep link to
  // a comment or mention scrolls to its own target).
  const mainRef = useRef<HTMLElement>(null);
  const scrolls = useRef(new Map<string, { cls: string; tag: string; top: number }>());
  const scrollTab = useRef<string | null>(null);
  const restoring = useRef(false);
  const navRestore = useUIStore((s) => s.navRestore);
  const seenRestore = useRef(navRestore);
  // Renderers bring their own scroller (the writing column, the live editor), so
  // listen in the capture phase and remember the page-sized one, not a code block.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onScroll = (event: Event) => {
      const el = event.target as HTMLElement | null;
      if (restoring.current || !scrollTab.current || !el || !(el instanceof HTMLElement)) return;
      if (el !== main && el.clientHeight < main.clientHeight * 0.5) return;
      scrolls.current.set(scrollTab.current, { cls: typeof el.className === "string" ? el.className : "", tag: el.tagName, top: el.scrollTop });
    };
    main.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => main.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
  useLayoutEffect(() => {
    scrollTab.current = activeTabId;
    const main = mainRef.current;
    const wanted = seenRestore.current !== navRestore;
    seenRestore.current = navRestore;
    const saved = activeTabId ? scrolls.current.get(activeTabId) : undefined;
    if (!main || !wanted || !saved || saved.top <= 0) return;
    restoring.current = true;
    const started = performance.now();
    let frame = 0;
    const events = ["wheel", "touchstart", "keydown", "mousedown"];
    const stop = () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
      for (const type of events) window.removeEventListener(type, stop, true);
    };
    const find = (): HTMLElement | null => {
      if (main.tagName === saved.tag && main.className === saved.cls) return main;
      for (const el of main.getElementsByTagName(saved.tag)) {
        if (el instanceof HTMLElement && el.className === saved.cls && el.clientHeight >= main.clientHeight * 0.5) return el;
      }
      return null;
    };
    // The page may still be loading (lazy renderer, images): keep trying until it is tall enough.
    const step = () => {
      const el = find();
      if (el) el.scrollTop = saved.top;
      if ((el && Math.abs(el.scrollTop - saved.top) < 2) || performance.now() - started > 2000) { stop(); return; }
      frame = requestAnimationFrame(step);
    };
    for (const type of events) window.addEventListener(type, stop, { capture: true, passive: true });
    step();
    return stop;
  }, [activeTabId, navRestore]);

  // NP-OF-02: this page came from the device's copy (no connection).
  // Either the host says so (read from its on-device cache), or the device is
  // offline and what is on screen is the copy this session read earlier.
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const offlineAt = isVirtual || !note ? null : offlineCopyAt(note) ?? (!online && dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null);

  // NP-PG-08: per-page small text / full width (styles/shell.css), any device, live or not.
  const pageStyle = isVirtual ? {} : pageStyleOf(effectiveNote);

  return (
    <div className="flex flex-col h-full">
      <TabBar />

      <main id="workspace-document" ref={mainRef} tabIndex={-1} className="flex-1 min-h-0 overflow-auto"
        data-page-small={pageStyle.small ? "true" : undefined} data-page-full={pageStyle.full ? "true" : undefined}>
        {!isVirtual && !isTagView && offlineAt && <OfflineCopyNotice at={offlineAt} />}
        {!activeTab ? (
          <EmptyState />
        ) : isTagView ? (
          <TagView tag={activeTab.noteId.replace("tag:", "")} />
        ) : !isVirtual && isLoading ? (
          <LoadingSkeleton />
        ) : !isVirtual && isError && !note ? (
          <div role="alert" className="mx-auto max-w-lg px-6 pt-16 text-center">
            <h2 className="text-lg font-medium">{accessUnavailable ? "Document unavailable" : "Couldn’t open this document"}</h2>
            <p className="mt-3 text-sm text-[var(--text-secondary)]">{accessUnavailable ? "Your access may have changed, or this document may have been moved or removed." : "Check your connection and try again. Your saved work has not been changed."}</p>
            {accessUnavailable && canRequestAccess && parachuteNoteId && <div className="mt-5"><RequestAccessButton noteId={parachuteNoteId} /></div>}
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <button type="button" disabled={isFetching} onClick={() => { void refetch(); }} className="focus-ring min-h-11 rounded-lg border border-[var(--border-subtle)] px-4 text-sm">{isFetching ? "Checking document…" : "Retry document"}</button>
              <button type="button" onClick={() => activeTab && useUIStore.getState().closeTab(activeTab.id)} className="focus-ring min-h-11 rounded-lg px-4 text-sm text-[var(--text-secondary)]">Close tab</button>
            </div>
          </div>
        ) : effectiveNote && isLiveDoc ? (
          // Keyed by note id so a crash on one note clears when you switch tabs.
          <RendererBoundary key={effectiveNote.id}>
            <collab.CollabDocument noteId={effectiveNote.id} note={effectiveNote} />
          </RendererBoundary>
        ) : effectiveNote && Renderer ? (
          // + the note's revision: a version restore remounts the editor on the
          // restored content (a live collab doc above instead receives it through
          // the server's reconciler, so it keeps its session).
          <RendererBoundary key={`${effectiveNote.id}:${noteRevision}:${locked ? "locked" : "open"}`}>
            {locked && <LockedBanner note={effectiveNote} />}
            <Suspense fallback={<LoadingSkeleton />}>
              <Renderer
                note={effectiveNote}
                onSave={locked ? undefined : handleSave}
                onMetadataChange={locked ? undefined : handleMetadataChange}
                readOnly={locked || undefined}
              />
            </Suspense>
          </RendererBoundary>
        ) : (
          <div className="text-center pt-20" style={{ color: "var(--text-muted)" }}>
            Note not found.
          </div>
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4" style={{ background: "var(--bg-base)" }}>
      <div
        className="flex items-center justify-center"
        style={{
          width: 56,
          height: 56,
          borderRadius: "var(--radius-lg)",
          background: "var(--surface-hover)",
          color: "var(--text-muted)",
        }}
      >
        <Compass size={26} strokeWidth={1.5} />
      </div>
      <div className="flex flex-col items-center" style={{ gap: 6 }}>
        <p style={{ fontSize: "var(--text-xl)", fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
          Open a document
        </p>
        <p className="flex items-center" style={{ gap: 6, fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
          Pick one from the sidebar, or press <kbd>&#8984;K</kbd> to search
        </p>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 max-w-2xl mx-auto pt-12 px-6">
      <Skeleton width="60%" height={28} />
      <Skeleton width="100%" height={16} />
      <Skeleton width="90%" height={16} />
      <Skeleton width="75%" height={16} />
      <Skeleton width="85%" height={16} />
    </div>
  );
}
