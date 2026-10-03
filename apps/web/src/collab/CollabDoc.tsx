import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { persistLocalDocument, localDocumentKey, type LocalSaveState } from "./localDocument";
import { captureWriteContext, scopeKey } from "../offline/writeScope";
import { humanCollabRevision } from "@prism/core/collab-commands";
import { sendHumanCommand } from "./humanCommands";
import { humanRevisionBody } from "../../../../packages/core/src/lib/collab/human/validation";
import { PageCover, parseCover, coverPatch, COVER_GRADIENTS, type PageCoverValue } from "@prism/core";
import { COLLAB_SCHEMA_VERSION, useAgentDocumentSnapshot, CollabEditor, CommentsSidebar, collabAffordances, humanFailureText, HumanCommandFailure, PresenceAvatars, type CollabSocketScope, type CommentCommandActions, type HumanCommandChannel, CollabCodeEditor, CollabSpreadsheet, CollabCanvas, detectCodeLanguage, inferContentType, PageHeader, NotePropertyBar, PageProperties, renamePath, useUIStore, useAgentChatStore, type ContentFont, type Note, type Editor } from "@prism/core";
import { MessageSquare, X, Lock } from "lucide-react";
import { serverFetch, collabWsUrl, collabToken, isNative } from "../transport";
import { apiBase, agentScope, getCapabilityToken, getActiveVault, getMe, fetchMe, contextHeaders } from "../config";

/** The vault-scoped collab documentName: the primary vault uses a BARE note id
 *  (backward-compatible), every other vault prefixes `${vaultId}::` so the server
 *  keeps its in-memory doc + persisted CRDT state isolated per tenant. Mirrors the
 *  server's docNameFor() in apps/server/src/collab.ts. */
function vaultDocName(noteId: string): string {
  const v = getActiveVault();
  return v && v !== "primary" ? `${v}::${noteId}` : noteId;
}
import { updateNote as restUpdateNote, getNote as restGetNote, hasPendingWrites, uploadAttachment, unfurl as restUnfurl } from "../parachute/rest";
import { markUnsynced, clearUnsynced, setOpenHere, unsyncedDocs } from "./unsynced";
import { reloadForUpdate } from "../offline/reloadForUpdate";
import { reportSyncSource, BacklinksPill, EmptyPageStarters, notePageIconChanged, pageIconWriteConfirmed, pageIconWriteFailed, PageDiscussion } from "@prism/core";

/** Track a CSS breakpoint without per-render layout thrash. */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth <= 820);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

const COLORS = ["#f783ac", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];

/** A STABLE color per identity (so a given person is always the same color across
 *  sessions/clients), derived from their email/name — not from join order. */
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

/** Resolve the collab identity from the signed-in session (name → email), or a
 *  distinct-per-link "Guest" for capability-link viewers with no account. This is
 *  what labels every cursor, comment, and suggested edit — so collaborators see
 *  WHO is acting, instead of everyone showing as the same hardcoded "You". */
function identityFrom(me: { name?: string | null; email?: string; avatar?: string | null } | null, capToken: string | null): PresenceUser {
  if (capToken) {
    // Anonymous share-link viewer: no account. Keep them visually distinct per
    // link, but they can't be named (that's what account sign-in is for).
    const seed = `guest-${capToken.slice(0, 10)}`;
    return { name: "Guest", color: colorFor(seed) };
  }
  // Never the account email (final review L4): presence and comment authorship are
  // seen by everyone on the page. No display name → the neutral "Member" (the
  // server's command endpoint uses the same label, so "my comment" checks agree).
  const name = (me?.name && me.name.trim() && me.name.trim() !== me.email ? me.name.trim() : "") || "Member";
  return { name, color: colorFor(me?.email || name), avatar: me?.avatar ?? null };
}

/** The server refuses a document socket without the current schema version (C1). */
function collabUrl(): string {
  return `${collabWsUrl()}?schema=${COLLAB_SCHEMA_VERSION}`;
}

interface PresenceUser {
  name: string;
  color: string;
  /** Small data:image/ avatar (set once in awareness → shown on presence chips). */
  avatar?: string | null;
}

type CollabKind = "document" | "code" | "spreadsheet" | "canvas";

/** Derive the collab kind from the SAME `inferContentType` the renderers use, so
 *  the live editor always matches how the note renders (and how the server seeds
 *  it). Content sniffing inside inferContentType catches tag-less canvases. */
function detectKind(note: { path?: string | null; tags?: string[] | null; metadata?: Record<string, unknown> | null; content?: string | null }): CollabKind {
  const t = inferContentType(note as never);
  return t === "canvas" || t === "code" || t === "spreadsheet" ? t : "document";
}

/** A readable document title from either markdown or HTML content (collab
 *  persists HTML, so the old "first line" heuristic would show raw tags). */
function deriveTitle(content: string): string {
  const h = content.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
  if (h?.[1]) return h[1].replace(/<[^>]+>/g, "").trim().slice(0, 100) || "Shared document";
  if (!content.includes("<")) {
    const line = content.split("\n").find((l) => l.trim());
    if (line) return line.replace(/^#+\s*/, "").trim().slice(0, 100);
  }
  const text = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 80) || "Shared document";
}

/**
 * The live collaborative document — Hocuspocus-connected, level-aware (read-only
 * for viewers, comment sidebar, suggest mode), with presence. Shared by the
 * full-page share route (CollabPage) and the in-app renderer (CollabDocument)
 * so the owner's main app gets the same real-time editor as recipients.
 *
 * `embedded` drops the full-viewport chrome so it fits inside the app canvas.
 */
type CollabDocProps = {
  noteId: string;
  embedded?: boolean;
  onWikilinkNavigate?: (target: string) => void;
  wikilinkNotes?: Note[];
};

export function CollabDoc(props: CollabDocProps) {
  const scope = useAgentChatStore((state) => state.scope);
  return <ScopedCollabDoc key={JSON.stringify([props.noteId, scope, getActiveVault(), getCapabilityToken()])} {...props} />;
}

function ScopedCollabDoc({
  noteId,
  embedded = false,
  onWikilinkNavigate,
  wikilinkNotes,
}: {
  noteId: string;
  embedded?: boolean;
  /** How to handle a clicked [[wikilink]] (in-app: open a tab; share route: route
   *  to the target or request-access). */
  onWikilinkNavigate?: (target: string) => void;
  /** Vault notes for the `[[` autocomplete (in-app only). */
  wikilinkNotes?: Note[];
}) {
  const [connection, setConnection] = useState<{ doc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const ydoc = connection?.doc;
  const provider = connection?.provider;
  const [localSave, setLocalSave] = useState<LocalSaveState>("saving");
  const [connectionError, setConnectionError] = useState(false);
  const [denied, setDenied] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  // Wave 2E (NP-OF-01): live documents feed the shell's one sync state.
  const [unsynced, setUnsynced] = useState(0);
  useEffect(() => {
    if (!provider) return;
    const update = ({ number }: { number: number }) => setUnsynced(number);
    provider.on("unsyncedChanges", update);
    return () => { provider.off("unsyncedChanges", update); };
  }, [provider]);
  // Which local document this is (set once its local state is loaded), and whether
  // it is registered as holding edits the server has not taken (re-review M1).
  const docRef = useRef<{ scope: import("../offline/writeScope").WriteScope; name: string } | null>(null);
  const [registered, setRegistered] = useState(false);
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    const at = docRef.current;
    if (!at) return;
    if (!connected && unsynced > 0) { markUnsynced(at.scope, at.name, noteId); setRegistered(true); }
    // Only a completed sync with nothing unacknowledged clears it — never a tab switch or unmount.
    else if (connected && synced && unsynced === 0) { clearUnsynced(at.scope, at.name); setRegistered(false); }
  }, [noteId, connected, synced, unsynced]);
  useEffect(() => {
    const key = `collab:${noteId}`;
    const waiting = unsynced > 0 || registered;
    reportSyncSource(key, connected
      ? (unsynced > 0 ? "saving" : "idle")
      // Socket down with edits the server hasn't taken: never "Saved". They are on
      // this device (local), still being written locally (saving), or at risk (failed).
      : waiting ? (localSave === "unavailable" ? "failed" : localSave === "saved" ? "local" : "saving")
        : localSave === "unavailable" ? "failed" : "idle");
    return () => reportSyncSource(key, null);
  }, [noteId, connected, unsynced, localSave, registered]);
  const [level, setLevel] = useState<string | null>(null);
  // The local collaborator identity (cursor + comment/suggestion authorship),
  // seeded from the cached session and confirmed via fetchMe() before the editor mounts.
  const [user, setUser] = useState<PresenceUser>(() => identityFrom(getMe(), getCapabilityToken()));
  // What the server actually granted THIS socket (re-read on every authentication).
  const [socketScope, setSocketScope] = useState<CollabSocketScope>(undefined);
  const [title, setTitle] = useState("Shared document");
  const [titleNotice, setTitleNotice] = useState("");
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [path, setPath] = useState<string | null>(null);
  const [contentFont, setContentFont] = useState<ContentFont>("sans");
  const [icon, setIcon] = useState<string | null>(null);
  const [cover, setCover] = useState<PageCoverValue | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<CollabKind>("document");
  const [language, setLanguage] = useState("plaintext");
  const [suggesting, setSuggesting] = useState(false);
  const narrow = useIsNarrow();
  // Comments shown by default on desktop, collapsed on mobile (doc gets full width).
  const [commentsOpen, setCommentsOpen] = useState(false); // closed by default; toggle in the header
  const [editor, setEditor] = useState<Editor | null>(null);
  const [focusedThread, setFocusedThread] = useState<string | null>(null);
  // A notification deep link (inbox → comment) opens the sidebar on that thread.
  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ noteId?: string; threadId?: string }>).detail;
      if (!d?.threadId || (d.noteId && d.noteId !== noteId)) return;
      setCommentsOpen(true);
      setFocusedThread(d.threadId);
    };
    window.addEventListener("prism:open-comment-thread", open);
    return () => window.removeEventListener("prism:open-comment-thread", open);
  }, [noteId]);
  useAgentDocumentSnapshot(editor, noteId, title, null, synced && !denied && !checkingAccess && !connectionError);

  // Expose the reading-font control to the shell (bottom bar on desktop, More
  // sheet on mobile) for documents only. Declared above the early returns below
  // so the hook order is stable regardless of load/lock state.
  const registerDocFont = useUIStore((s) => s.registerDocFont);
  useEffect(() => {
    const isDoc = kind === "document";
    registerDocFont(isDoc ? contentFont : null, isDoc ? setContentFont : null);
    return () => registerDocFont(null, null);
  }, [kind, contentFont, registerDocFont]);

  // Rename via the editable page title (preserves folder + extension). Uses the
  // REST client directly (no VaultClient provider on the full-page share route).
  const handleRename = async (newName: string) => {
    const next = renamePath(path, newName);
    if (!next) return;
    const audience = agentScope();
    setTitleNotice("");
    // Await the scoped REST write so PageHeader retains failed drafts and
    // prevents double activation. Offline acceptance remains distinct from sync.
    const saved = await restUpdateNote(noteId, { path: next }, { expectedScope: audience ?? undefined });
    const pending = await hasPendingWrites();
    if (!mounted.current || agentScope() !== audience) return;
    const confirmedPath = saved.path ?? next;
    setPath(confirmedPath);
    const name = confirmedPath.split("/").pop() || newName.trim();
    setTitle(name);
    useUIStore.getState().renameTab(noteId, name);
    setTitleNotice(pending ? "Title change saved on this device. Waiting to sync." : "");
  };

  const handleIconChange = (emoji: string | null) => {
    const previousIcon = icon;
    setIcon(emoji);
    notePageIconChanged(noteId, emoji); // tabs, breadcrumbs, sidebar follow at once (NP-PG-01)
    void restUpdateNote(noteId, { metadata: { icon: emoji } }).then(
      // Confirmed: the server's `tree: true` event for this write refreshes the tree, which then replaces the override.
      () => { pageIconWriteConfirmed(noteId); },
      // Refused or lost: tabs, breadcrumbs and the sidebar go back to what the server has (review M3).
      () => { pageIconWriteFailed(noteId); setIcon(previousIcon); },
    );
  };
  // Page cover (metadata-only write, like the icon; the server reconciles it with the live doc).
  const handleCoverChange = (next: PageCoverValue | null) => {
    setCover(next);
    void restUpdateNote(noteId, { metadata: coverPatch(next) }).catch(() => {});
  };
  // Files/images go to the note's attachments (edit cap on the server); the block is inserted after the 201.
  const uploadImage = async (file: File) => {
    setUploadNotice(null);
    const a = await uploadAttachment(noteId, file, { kind: "image" });
    return { src: a.url, alt: a.name.replace(/\.[^.]+$/, "") };
  };
  const uploadFile = async (file: File) => {
    setUploadNotice(null);
    const a = await uploadAttachment(noteId, file, { kind: "file" });
    return { src: a.url, name: a.name, size: a.size, mimeType: a.mimeType };
  };

  const isSuggestLevel = level === "suggest";
  // One table (@prism/core collabAffordances) mirrors what the server socket
  // allows: below "suggest" the connection is read-only, so a "comment"-level
  // viewer gets NO write affordances — comments need suggest (WP0.2); offering
  // them would let a comment vanish on reload.
  const { canReview, canComment, editable, commands } = collabAffordances(level, socketScope);
  // Suggest-only (NP-CO-12): commands instead of typing; no local suggestion mode.
  const useCommands = commands && kind === "document";
  const effectiveSuggesting = useCommands ? false : isSuggestLevel ? true : suggesting;
  const send = useMemo(() => sendHumanCommand(noteId, getCapabilityToken()), [noteId]);
  const pendingThreadCommands = useRef(new Map<string, Parameters<typeof send>[0]>());
  const humanChannel: HumanCommandChannel | undefined = useCommands ? { send, ready: connected && synced } : undefined;
  const commentActions: CommentCommandActions | undefined = useMemo(() => {
    if (!useCommands || !ydoc) return undefined;
    const revision = async () => {
      const doc = editor?.state.doc;
      if (!doc || !connected || !synced) throw new HumanCommandFailure("Wait for the page to finish connecting.", "not_ready", "not-sent");
      const { body } = humanRevisionBody(doc, ydoc);
      return humanCollabRevision(body, ydoc.getMap("comments").toJSON());
    };
    const base = async () => ({ requestId: crypto.randomUUID(), createdAt: Date.now(), revision: await revision() });
    // One immutable pending command per (action, thread, payload): after an
    // outcome-unknown failure the next attempt resends the SAME request (same
    // requestId and body — the server applies it at most once), like the composer.
    const run = async (key: string, make: () => Promise<Parameters<typeof send>[0]>) => {
      try {
        const command = pendingThreadCommands.current.get(key) ?? (await make());
        pendingThreadCommands.current.set(key, command);
        await send(command);
        pendingThreadCommands.current.delete(key);
      } catch (e) {
        if (!(e instanceof HumanCommandFailure && e.retrySame)) pendingThreadCommands.current.delete(key);
        throw new Error(humanFailureText(e));
      }
    };
    return {
      pageComment: (text) => run(`page-comment:${text}`, async () => ({ ...(await base()), kind: "page-comment", text })),
      reply: (threadId, text) => run(`reply:${threadId}:${text}`, async () => ({ ...(await base()), kind: "reply", threadId, text })),
      resolve: (threadId, resolved) => run(`resolve:${threadId}:${resolved}`, async () => ({ ...(await base()), kind: "resolve", threadId, resolved })),
      remove: (threadId) => run(`delete:${threadId}`, async () => ({ ...(await base()), kind: "delete-comment", threadId })),
      // The server decides (only threads whose every comment is yours); hide it elsewhere.
      canDelete: (thread) => thread.comments.length > 0 && thread.comments.every((c) => c.author === user.name),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCommands, ydoc, editor, connected, synced, send, user.name]);

  useEffect(() => {
    if (isSuggestLevel) setSuggesting(true);
  }, [isSuggestLevel]);

  // Track browser connectivity to distinguish "offline (saved locally)" from
  // "connecting" in the status line.
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    let p: HocuspocusProvider | null = null;
    const doc = new Y.Doc();
    let persistence: Awaited<ReturnType<typeof persistLocalDocument>> | undefined;
    let cancelled = false;
    let socketUp = false;
    let localUnavailable = false;
    const capToken = getCapabilityToken();
    const initialContext = JSON.stringify([contextHeaders(), capToken]);
    const current = () => !cancelled && initialContext === JSON.stringify([contextHeaders(), getCapabilityToken()]);
    void (async () => {
      try {
        if (!capToken) {
          const me = await fetchMe();
          if (!current()) return;
          // No connection: the identity this device last confirmed still opens the
          // document's LOCAL copy; the socket re-authorizes when it reconnects.
          const known = me.authenticated ? me : (me as { unavailable?: boolean }).unavailable ? getMe() : null;
          if (!known?.authenticated) { setConnectionError(true); return; }
          setUser(identityFrom(known, null));
        } else setUser(identityFrom(null, capToken));
        const context = await captureWriteContext();
        if (!current()) return;
        const stillCurrent = async () => current() && scopeKey((await captureWriteContext()).scope) === scopeKey(context.scope);
        // Fresh authorization BEFORE loading any local CRDT or opening a socket.
        // With no connection at all, the copy this account was last authorized to
        // read (the offline read cache, ≤ 30 days) stands in — and only a document
        // that already has local state on this device may open that way (below).
        let offlineOpen = false;
        let note: Record<string, any>;
        try {
          const response = await serverFetch(`${apiBase()}/notes/${encodeURIComponent(noteId)}`, { headers: context.headers });
          if (!(await stillCurrent())) return;
          if (!response.ok) {
            if ([401, 403, 404, 410].includes(response.status)) setDenied(true);
            else setConnectionError(true);
            return;
          }
          note = await response.json();
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          const cached = await restGetNote(noteId).catch(() => null);
          if (!cached || !(await stillCurrent())) { if (current()) setConnectionError(true); return; }
          note = cached as unknown as Record<string, any>;
          offlineOpen = true;
        }
        if (!(await stillCurrent())) return;
        setLevel(note._level ?? "own");
        setPath(note.path ?? null);
        if (typeof note.metadata?.contentFont === "string") setContentFont(note.metadata.contentFont as ContentFont);
        setIcon(typeof note.metadata?.icon === "string" ? note.metadata.icon : null);
        setCover(parseCover(note.metadata ?? null));
        const k = detectKind(note);
        setKind(k);
        if (k === "code") setLanguage(detectCodeLanguage(note.path ?? null, note.metadata ?? null));
        const filename = note.path?.split("/").pop() as string | undefined;
        const titleMeta = typeof note.metadata?.title === "string" ? note.metadata.title : undefined;
        // Prefer the note's explicit title / filename; fall back to a heading
        // derived from the body. (Content-only derivation left "Shared document"
        // whenever the body had no leading heading — or was collab HTML.)
        if (k === "document") setTitle(titleMeta || filename || deriveTitle(note.content || ""));
        else if (k === "canvas") setTitle(titleMeta || filename || "Canvas");
        else setTitle(titleMeta || filename || deriveTitle(note.content || ""));
        let name = vaultDocName(noteId);
        try {
          const r = await serverFetch(`${apiBase()}/federated/${encodeURIComponent(noteId)}`, { headers: context.headers });
          if (r.ok) {
            const federated = await r.json();
            if (federated?.spaceNoteKey) name = federated.spaceNoteKey;
          }
        } catch { /* ordinary local note */ }
        if (!(await stillCurrent())) return;
        try {
          persistence = await persistLocalDocument(localDocumentKey(context.scope, name), doc, (state) => { localUnavailable = state === "unavailable"; if (current()) setLocalSave(state); });
        } catch { localUnavailable = true; if (current()) setLocalSave("unavailable"); }
        if (!(await stillCurrent())) { persistence?.close(); return; }
        // Opening without the server is only safe on top of local state: an empty
        // local document would later be merged with the server's seed.
        if (offlineOpen && Y.encodeStateAsUpdate(doc).length <= 2) { persistence?.close(); setConnectionError(true); return; }
        docRef.current = { scope: context.scope, name };
        setOpenHere(name, true);
        void unsyncedDocs().then((docs) => { if (current() && docs.some((d) => d.name === name)) setRegistered(true); });
        // A server permission change closes just this document session. Refresh
        // the actual note level before reconnecting or exposing editing controls.
        // Ordinary network loss retains the existing offline-editing behavior.
        let accessCheck = 0;
        const refreshAccess = async (): Promise<boolean> => {
          const request = ++accessCheck;
          try {
            const r = await serverFetch(`${apiBase()}/notes/${encodeURIComponent(noteId)}`, { headers: context.headers });
            if (!(await stillCurrent()) || request !== accessCheck) return false;
            if (!r.ok) {
              if ([401, 403, 404, 410].includes(r.status)) setDenied(true);
              else setConnectionError(true);
              return false;
            }
            const fresh = await r.json();
            if (!(await stillCurrent()) || request !== accessCheck) return false;
            setLevel(fresh._level ?? "own");
            setDenied(false);
            setConnectionError(false);
            return true;
          } catch {
            if (current() && request === accessCheck) setConnectionError(true);
            return false;
          }
        };
        p = new HocuspocusProvider({
          url: collabUrl(), name, token: collabToken(capToken), document: doc,
          onStatus: ({ status }) => { socketUp = status === "connected"; if (current()) setConnected(status === "connected"); },
          onSynced: () => { socketUp = true; if (current()) { setSynced(true); setConnected(true); } },
          onAuthenticationFailed: ({ reason }) => {
            if (!current()) return;
            setLevel(null);
            if (reason?.startsWith("update_required")) { setUpdateRequired(true); p?.disconnect(); }
            else setDenied(true);
          },
          onAuthenticated: ({ scope }) => {
            if (current()) setSocketScope(scope === "read-write" ? "read-write" : "readonly");
            void refreshAccess().then(ok => { if (ok && current()) { setCheckingAccess(false); } });
          },
          onClose: ({ event }) => {
            if (!current() || !event.reason?.startsWith("Access changed.")) return;
            setCheckingAccess(true);
            setLevel(null);
            setSocketScope(undefined);
            setConnected(false);
            setSynced(false);
            const transport = p?.configuration.websocketProvider;
            if (!transport || !p) return;
            // Wait for the transport close before reconnecting: connect() is a
            // no-op while its old socket still reports Connected. Reattaching
            // to that socket can race its queued document-close frame.
            const closed = new Promise<void>(resolve => {
              const done = () => { transport.off("close", done); resolve(); };
              transport.on("close", done);
              p!.disconnect();
            });
            void Promise.all([refreshAccess(), closed]).then(([ok]) => {
              if (ok && current()) void p?.connect();
            });
          },
        });
        setConnection({ doc, provider: p });
      } catch { if (current()) setConnectionError(true); }
    })();
    // ── Unload guard (wave 3) ────────────────────────────────────────────────
    // Socket down + edits the server has not taken: the local IndexedDB write is
    // asynchronous, and a navigation within a few ms of the last keystroke used to
    // abort it. On the way out, whatever IndexedDB has not confirmed goes to
    // localStorage synchronously (persistence.rescue) and the document is registered
    // as unsynced; it is folded back in on the next open / background sync.
    const leaving = () => {
      const at = docRef.current;
      if (!at || cancelled) return;
      if (socketUp && (p?.unsyncedChanges ?? 0) === 0) return;
      persistence?.rescue();
      if ((p?.unsyncedChanges ?? 0) > 0) markUnsynced(at.scope, at.name, noteId);
    };
    const onHidden = () => { if (document.visibilityState === "hidden") leaving(); };
    // The browser's own "Leave site?" prompt, only when the edits are neither on the
    // server nor confirmed on this device. Web only: a native shell has no dialogs.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isNative || !docRef.current || socketUp || (p?.unsyncedChanges ?? 0) === 0) return;
      if (persistence && !persistence.pending() && !localUnavailable) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("pagehide", leaving);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", leaving);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("beforeunload", onBeforeUnload);
      cancelled = true;
      // Leaving with edits the server has not acknowledged: they are in the local
      // store — remember the document so the badge says so and it syncs later.
      const at = docRef.current;
      if (at) {
        if ((p?.unsyncedChanges ?? 0) > 0) markUnsynced(at.scope, at.name, noteId);
        setOpenHere(at.name, false);
        docRef.current = null;
      }
      p?.destroy();
      persistence?.close();
      doc.destroy();
    };
  }, [noteId]);


  // The local collaborator identity (cursor + comment/suggestion authorship).
  // Seeded synchronously from the cached session (usually already populated), then
  // confirmed via fetchMe() in the provider effect BEFORE the editor mounts, so
  // authorship is correct from the first keystroke. Was hardcoded "You" for
  // everyone — the bug that collapsed all collaborators into one identity.

  if (updateRequired) {
    return (
      <div role="alert" style={{ minHeight: embedded ? "40vh" : "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", background: "var(--bg-base)" }}>
        <div style={{ maxWidth: 440 }}>
          <h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 700, margin: 0, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>Update required</h1>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.6 }}>
            Prism was updated. Reload or update the app to keep editing. Nothing you saved is lost.
          </p>
          <button type="button" onClick={() => void reloadForUpdate()} style={{ marginTop: 22, height: 36, padding: "0 18px", borderRadius: "var(--radius-md)", border: "none", background: "var(--color-accent)", color: "#fff", fontSize: "var(--text-base)", fontWeight: 550, cursor: "pointer" }}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (denied) {
    return (
      <div style={{ minHeight: embedded ? "40vh" : "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", background: "var(--bg-base)" }}>
        <div style={{ maxWidth: 440 }}>
          <div style={{ width: 56, height: 56, borderRadius: "var(--radius-lg)", background: "var(--surface-hover)", color: "var(--text-muted)", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
            <Lock size={26} strokeWidth={1.5} />
          </div>
          <h1 style={{ fontSize: "var(--text-2xl)", fontWeight: 700, margin: 0, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
            Request access
          </h1>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.6 }}>
            You don’t have access to this document. Ask the owner to share it with your account, or
            sign in if it was already shared with you.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 22 }}>
            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 36,
                padding: "0 18px",
                borderRadius: "var(--radius-md)",
                background: "var(--color-accent)",
                color: "#fff",
                fontSize: "var(--text-base)",
                fontWeight: 550,
                textDecoration: "none",
              }}
            >
              Sign in
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (connectionError) return <div role="alert" className="p-6 text-sm">
    <p>Reconnect to open this document. Saved changes remain on this device.</p>
    <button className="focus-ring mt-3 rounded-lg border px-3 py-2" onClick={() => window.location.reload()}>Try again</button>
  </div>;
  if (checkingAccess) return <p role="status" className="p-6 text-sm">Checking updated access…</p>;
  if (!provider || !ydoc) return <p role="status" className="p-6 text-sm">Opening document…</p>;

  const outer: React.CSSProperties = embedded
    ? { padding: "0 16px" }
    : { minHeight: "100dvh", padding: "0 16px", background: "var(--bg-base, #0d0d0f)" };

  const isCode = kind === "code";
  const isSheet = kind === "spreadsheet";
  const isCanvas = kind === "canvas";
  const isDocument = kind === "document";
  const statusText = !connected
    ? online
      ? "Connecting…"
      : localSave === "saved" ? "Offline · saved on this device" : localSave === "saving" ? "Offline · saving…" : "Offline · local save unavailable"
    : useCommands
      ? "Suggesting"
      : !editable
      ? "View only"
      : !isDocument
        ? "Editing"
        : effectiveSuggesting
          ? "Suggesting"
          : "Editing";

  // Comments + suggestions are prose-only; code/spreadsheets are pure collab data.
  const showComments = isDocument;
  const sidebar = <CommentsSidebar ydoc={ydoc} user={user} canComment={canComment} editor={editor} focusedThreadId={focusedThread} actions={commentActions} />;

  return (
    <div style={outer}>
      {localSave === "unavailable" && <p role="alert" className="rounded-lg border p-3 text-sm">Local saving is unavailable. Keep this document open and copy any unsynced changes before leaving.</p>}
      {/* Extra bottom padding on narrow viewports clears the floating command pill. */}
      <div style={{ maxWidth: "var(--page-max-width, 1080px)", margin: "0 auto", padding: narrow ? "12px 14px 124px" : "16px 20px 96px" }}>
        {/* Cover band — same component and metadata as the non-collab view */}
        {isDocument && <div className="collab-cover-bleed"><PageCover
          cover={cover}
          onChange={canReview ? handleCoverChange : undefined}
          onUpload={canReview && !getCapabilityToken() ? async (file) => (await uploadAttachment(noteId, file, { kind: "image" })).url : undefined}
        /></div>}
        {/* Header — shared page chrome, identical to the non-collab document view */}
        <PageHeader
          path={path}
          fallbackName={title}
          details={<NotePropertyBar noteId={noteId} readOnly={!canReview} fallback={<PageProperties path={path} />} />}
          onRename={canReview ? handleRename : undefined}
          icon={icon}
          onIconChange={canReview ? handleIconChange : undefined}
          onAddCover={canReview && isDocument && !cover ? () => handleCoverChange({ kind: "gradient", value: COVER_GRADIENTS[Math.floor(Math.random() * COVER_GRADIENTS.length)]!.name, y: 50 }) : undefined}
          presence={<PresenceAvatars awareness={provider.awareness as never} editor={editor} compact={narrow} />}
          right={
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: connected ? "#22c55e" : online ? "#eab308" : "#ef4444" }} />
                {connected ? "Live · " : ""}{statusText}
              </span>
              {showComments && (
                <button
                  onClick={() => setCommentsOpen((o) => !o)}
                  title="Comments"
                  className="interactive"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    height: 30,
                    padding: "0 10px",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    color: commentsOpen ? "#fff" : "var(--text-secondary)",
                    background: commentsOpen ? "var(--color-accent)" : "transparent",
                    border: commentsOpen ? "1px solid var(--color-accent)" : "1px solid var(--glass-border)",
                  }}
                >
                  <MessageSquare size={14} />
                  {!narrow && "Comments"}
                </button>
              )}
            </div>
          }
        />

        {titleNotice && <p role="status" className="mb-4 text-xs text-[var(--text-secondary)]">{titleNotice}</p>}
        {uploadNotice && <p role="alert" className="mb-4 text-xs text-[var(--text-secondary)]">{uploadNotice} <button type="button" className="underline" onClick={() => setUploadNotice(null)}>Dismiss</button></p>}
        {embedded && isDocument && <div style={{ maxWidth: "var(--content-measure)", margin: "0 auto" }}><BacklinksPill noteId={noteId} title={title} /></div>}

        {/* NP-CO-02: page-level discussion (threads about the page, not anchored to text). */}
        {isDocument && showComments && <PageDiscussion ydoc={ydoc} user={user} canComment={canComment} editor={editor} actions={commentActions} />}

        {/* Doc + (desktop) inline comments */}
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
          <div
            data-content-font={isDocument ? contentFont : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              // Documents are full-bleed (the prose body self-centers at
              // --content-measure) to match the non-collab DocumentRenderer;
              // code/sheet/canvas keep a contained card.
              background: isDocument ? "transparent" : "var(--bg-surface, rgba(255,255,255,0.03))",
              border: isDocument ? "none" : "1px solid var(--glass-border)",
              borderRadius: isDocument ? 0 : 16,
              padding: isDocument ? "4px 0 64px" : 0,
              minHeight: isCanvas ? undefined : "60vh",
              height: isCanvas ? (narrow ? "78vh" : "80vh") : undefined,
              position: isCanvas ? "relative" : undefined,
              overflow: isDocument ? undefined : "hidden",
              display: isSheet ? "flex" : undefined,
            }}
          >
            {isCanvas ? (
              <CollabCanvas noteId={noteId} ydoc={ydoc} provider={provider as never} user={user} editable={editable} />
            ) : isCode ? (
              <CollabCodeEditor
                ydoc={ydoc}
                provider={provider as never}
                user={user}
                language={language}
                editable={editable}
              />
            ) : isSheet ? (
              <div style={{ flex: 1, minHeight: "60vh", display: "flex", flexDirection: "column" }}>
                <CollabSpreadsheet ydoc={ydoc} editable={editable} />
              </div>
            ) : (
              <CollabEditor
                ydoc={ydoc}
                provider={provider as never}
                user={user}
                seedReady={synced}
                toolbar
                editable={editable}
                suggesting={effectiveSuggesting}
                onSetSuggesting={isSuggestLevel ? undefined : canReview ? setSuggesting : undefined}
                humanCommands={humanChannel}
                canReview={canReview}
                canComment={canComment}
                onEditor={setEditor}
                onCommentActivate={(id) => {
                  setCommentsOpen(true);
                  setFocusedThread(id);
                }}
                onWikilinkNavigate={onWikilinkNavigate}
                wikilinkNotes={wikilinkNotes}
                uploadImage={canReview ? uploadImage : undefined}
                uploadFile={canReview ? uploadFile : undefined}
                unfurl={getCapabilityToken() ? undefined : restUnfurl}
                onUploadError={setUploadNotice}
                hostPath={canReview && !getCapabilityToken() ? path : undefined}
                noteId={noteId}
              />
            )}
            {/* Only once synced: a starter must never race the server's own content. */}
            {embedded && isDocument && editor && editable && synced && !effectiveSuggesting && (
              <div style={{ maxWidth: "var(--content-measure)", margin: "0 auto" }}><EmptyPageStarters editor={editor} noteId={noteId} title={title} /></div>
            )}
          </div>
          {showComments && !narrow && commentsOpen && <div style={{ width: 320, flexShrink: 0 }}>{sidebar}</div>}
        </div>
      </div>

      {/* Mobile comments drawer */}
      {showComments && narrow && commentsOpen && (
        <>
          <div onClick={() => setCommentsOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 40 }} />
          <div
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: "min(360px, 88vw)",
              zIndex: 41,
              background: "var(--bg-base, #0d0d0f)",
              borderLeft: "1px solid var(--glass-border)",
              padding: 16,
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
              <button onClick={() => setCommentsOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}>
                <X size={18} />
              </button>
            </div>
            {sidebar}
          </div>
        </>
      )}
    </div>
  );
}
