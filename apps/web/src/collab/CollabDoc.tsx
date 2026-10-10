import { ProjectSections } from "@prism/core";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { persistLocalDocument, localDocumentKey, type LocalSaveState } from "./localDocument";
import { captureWriteContext, scopeKey } from "../offline/writeScope";
import { humanCollabRevision } from "@prism/core/collab-commands";
import { sendHumanCommand } from "./humanCommands";
import { humanRevisionBody } from "../../../../packages/core/src/lib/collab/human/validation";
import { PageCover, parseCover, coverPatch, COVER_GRADIENTS, useSoftKeyboard, type PageCoverValue } from "@prism/core";
import { COLLAB_SCHEMA_VERSION, collabColorFor, useAgentDocumentSnapshot, CollabEditor, CommentsSidebar, CommentsRowButton, collabAffordances, humanFailureText, HumanCommandFailure, PresenceAvatars, type CollabSocketScope, type CommentCommandActions, type HumanCommandChannel, CollabCodeEditor, CollabSpreadsheet, CollabCanvas, detectCodeLanguage, inferContentType, PageHeader, NotePropertyBar, PageProperties, renamePageFromTitle, containerTitle, isContainerPath, useUIStore, useWritingFont, useAgentChatStore, type ContentFont, type Note, type Editor } from "@prism/core";
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
import { updateNote as restUpdateNote, getNote as restGetNote, uploadAttachment, unfurl as restUnfurl } from "../parachute/rest";
import { markUnsynced, clearUnsynced, setOpenHere, unsyncedDocs } from "./unsynced";
import { reloadForUpdate } from "../offline/reloadForUpdate";
import { PlainTextPage } from "./PlainTextPage";
import { ReplacedNotice } from "@prism/core";
import { httpVaultClient } from "../parachute/HttpVaultClient";
import { reportSyncSource, NOT_SAVED_TO_PAGE, unsavedExplanation, BacklinksPill, EmptyPageStarters, notePageIconChanged, pageIconWriteConfirmed, pageIconWriteFailed, PageDiscussion } from "@prism/core";

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

/** How many times a `busy` refusal of an open is retried automatically (0.6 s, 1.2 s, 2.4 s) before asking. */
const BUSY_RETRIES = 3;
/** A STABLE colour per identity, from the palette the server shares (never an agent's or a review colour — NP-CO-10). */
const colorFor = collabColorFor;

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
  pagePath?: string | null;
  pageTitle?: string | null;
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
  pagePath,
  pageTitle,
  onWikilinkNavigate,
  wikilinkNotes,
}: {
  noteId: string;
  embedded?: boolean;
  /** In the workspace: the page's path as the shell's note query knows it NOW (it follows
   *  `/api/events`). A change of it is a rename / move made elsewhere — the title follows. */
  pagePath?: string | null;
  /** …and its stored title (`metadata.title`), which the page shows before its file name. */
  pageTitle?: string | null;
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
  // The server has no live document for this page (its content cannot be converted
  // for the live editor): the stored page is shown as plain text instead.
  const [tooComplex, setTooComplex] = useState<null | "edit" | "view">(null);
  // What the SERVER says about this page (stateless messages, repeated on every connect):
  // its latest changes cannot be written to the stored page / a one-off notice.
  // `permanent`: it cannot be written as the page is; else the server is still trying.
  const [serverUnsaved, setServerUnsaved] = useState<null | { permanent: boolean; reason: string | null }>(null);
  const [serverNotice, setServerNotice] = useState<string | null>(null);
  const [noticeCode, setNoticeCode] = useState<string | null>(null); // the `prism:notice` code behind `serverNotice`
  // Bumped to open the document afresh (new local document, new socket) without a page reload.
  const [attempt, setAttempt] = useState(0);
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
      // The server holds the changes but cannot write them to the page: never "Saved".
      ? (serverUnsaved ? (serverUnsaved.permanent ? "unsaved" : unsynced > 0 ? "saving" : "retrying") : unsynced > 0 ? "saving" : "idle")
      // Socket down with edits the server hasn't taken: never "Saved". They are on
      // this device (local), still being written locally (saving), or at risk (failed).
      : waiting ? (localSave === "unavailable" ? "failed" : localSave === "saved" ? "local" : "saving")
        : localSave === "unavailable" ? "failed" : "idle");
    return () => reportSyncSource(key, null);
  }, [noteId, connected, unsynced, localSave, registered, serverUnsaved]);
  const [level, setLevel] = useState<string | null>(null);
  // The local collaborator identity (cursor + comment/suggestion authorship),
  // seeded from the cached session and confirmed via fetchMe() before the editor mounts.
  const [user, setUser] = useState<PresenceUser>(() => identityFrom(getMe(), getCapabilityToken()));
  // What the server actually granted THIS socket (re-read on every authentication).
  const [socketScope, setSocketScope] = useState<CollabSocketScope>(undefined);
  const [title, setTitle] = useState("Shared document");
  const [titleNotice, setTitleNotice] = useState("");
  // A rename whose sub-pages did not all move: the working "Finish move" (this page has no toasts on the share route).
  const [finishRename, setFinishRename] = useState<(() => Promise<boolean>) | null>(null);
  const [finishing, setFinishing] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [path, setPath] = useState<string | null>(null);
  const [projectNote, setProjectNote] = useState<Note | null>(null);
  // The page's own font, else the device's writing font (Settings → Appearance).
  const writingFont = useWritingFont();
  const [ownFont, setContentFont] = useState<ContentFont | null>(null);
  const contentFont: ContentFont = ownFont ?? writingFont;
  const [icon, setIcon] = useState<string | null>(null);
  const [cover, setCover] = useState<PageCoverValue | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<CollabKind>("document");
  const [language, setLanguage] = useState("plaintext");
  const [suggesting, setSuggesting] = useState(false);
  const narrow = useIsNarrow();
  // Comments shown by default on desktop, collapsed on mobile (doc gets full width).
  const [commentsOpen, setCommentsOpen] = useState(false); // closed by default; toggle in the header
  // The phone drawer takes the focus when it opens: the document under it must not keep the caret
  // (and with it the keyboard and the editing toolbar). While the keyboard is up, the field being
  // typed in is kept inside the drawer's visible part.
  const drawerRef = useRef<HTMLDivElement>(null);
  const keyboard = useSoftKeyboard();
  const drawerOpen = narrow && commentsOpen; // the drawer exists only for a document
  useEffect(() => {
    const drawer = drawerRef.current;
    if (drawer && !drawer.contains(document.activeElement)) drawer.focus({ preventScroll: true });
  }, [drawerOpen]);
  useEffect(() => {
    const active = document.activeElement;
    if (!keyboard.open || !active || !drawerRef.current?.contains(active)) return;
    const frame = requestAnimationFrame(() => (active.closest("[data-comment-id], .page-discussion") ?? active).scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [drawerOpen, keyboard.open, keyboard.height, keyboard.top]);
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

  // Rename via the editable page title = the tree's Rename: a MOVE of the page and its
  // sub-pages (POST /api/notes/:id/move), never a bare path PATCH (it left sub-pages behind
  // and the gateway refuses it for non-owners). The live document is named by the note id,
  // so the open Y.Doc is untouched. Never queued: offline it is refused and the title reverts.
  const handleRename = async (newName: string) => {
    const audience = agentScope();
    setTitleNotice("");
    setFinishRename(null);
    pathEpoch.current++; // a re-read that started before this rename must not land on top of it
    const done = await renamePageFromTitle(httpVaultClient, { id: noteId, path }, newName);
    if (!done || !mounted.current || agentScope() !== audience) return;
    pathEpoch.current++;
    ownRename.current = { path: done.path, until: Date.now() + 15_000 };
    setPath(done.path);
    // A container-named page (`<folder>/PROJECT`): the title was stored as metadata, nothing moved.
    const name = done.title ?? (done.path.split("/").pop() || newName.trim());
    setTitle(name);
    useUIStore.getState().renameTab(noteId, name);
    if (done.partial) {
      setTitleNotice(done.finish ? "The page is renamed. Some sub-pages still need moving." : "The page is renamed. Some sub-pages still need moving — use Move to… on them to finish.");
      setFinishRename(() => done.finish ?? null);
    }
  };

  // NP-PG-03: an OPEN live document follows its page when the page is renamed or moved
  // elsewhere — the title, the breadcrumb and the tab; the Y.Doc (named by the note id), the
  // editor and the caret are untouched (only `path` / `title` state changes). Three signals:
  //  · the workspace's own note (`pagePath`, kept current by /api/events);
  //  · the server's "prism:page-changed" socket message after a move (it carries no path —
  //    each reader re-reads the page with their own access; this is what the share route has);
  //  · coming back to the page (focus / visible), on the share route, at most every 30 s.
  // This client's OWN rename always wins: a re-read that started before it is dropped
  // (`pathEpoch`), and until its echo arrives (≤ 15 s) an older path from the shell is ignored.
  // A title being typed is the title field's own draft — never replaced by any of this.
  const pathRef = useRef(path);
  pathRef.current = path;
  const pathEpoch = useRef(0);
  const ownRename = useRef<{ path: string; until: number } | null>(null);
  // The title shown is the stored title, else the file name — the same rule as at open (a page
  // that was only MOVED keeps its stored title).
  const shownRef = useRef<string | null>(null);
  // (A container-named page — `<folder>/PROJECT` — is named by its `name` / folder, never by the file: `containerTitle`.)
  const followPath = (next: string | null | undefined, storedTitle?: unknown, metadata?: Record<string, unknown> | null) => {
    if (!next || !mounted.current) return;
    const name = (typeof storedTitle === "string" && storedTitle.trim()) || containerTitle(next, metadata ?? null) || next.split("/").pop() || next;
    if (pathRef.current === next && shownRef.current === name) return;
    if (pathRef.current !== next) { pathRef.current = next; setPath(next); }
    shownRef.current = name;
    setTitle(name);
    useUIStore.getState().renameTab(noteId, name);
  };
  const rereadPath = async (again = false) => {
    const epoch = pathEpoch.current;
    const audience = agentScope();
    try {
      const context = await captureWriteContext();
      const response = await serverFetch(`${apiBase()}/notes/${encodeURIComponent(noteId)}?include_content=false`, { headers: context.headers, cache: "reload" });
      if (!response.ok) return;
      const note = (await response.json()) as { id?: unknown; path?: unknown; metadata?: Record<string, unknown> | null };
      if (!mounted.current || epoch !== pathEpoch.current || agentScope() !== audience || note.id !== noteId) return;
      followPath(typeof note.path === "string" ? note.path : null, note.metadata?.title, note.metadata);
      // A rename is two writes (the move, then the stored title): a read between them sees the
      // new path with the OLD stored title. When a stored title differs from the file name,
      // look once more a moment later (the server also tells us when the title is written).
      const stored = typeof note.metadata?.title === "string" ? note.metadata.title.trim() : "";
      if (stored && !again && typeof note.path === "string" && stored !== (note.path.split("/").pop() ?? "")) window.setTimeout(() => { if (mounted.current) void rereadPathRef.current(true); }, 2000);
    } catch { /* offline: the next signal asks again */ }
  };
  const rereadPathRef = useRef(rereadPath);
  rereadPathRef.current = rereadPath;
  const seenPagePath = useRef(pagePath);
  const seenPageTitle = useRef(pageTitle);
  useEffect(() => {
    if (pagePath === seenPagePath.current && pageTitle === seenPageTitle.current) return;
    seenPagePath.current = pagePath;
    seenPageTitle.current = pageTitle;
    const own = ownRename.current;
    if (own) {
      const waiting = pagePath !== own.path && Date.now() <= own.until;
      if (waiting) return;
      ownRename.current = null;
    }
    followPath(pagePath, pageTitle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the shell's path / title only
  }, [pagePath, pageTitle]);
  useEffect(() => {
    if (embedded) return; // the workspace has the shell's note
    let last = 0;
    const back = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 30_000) return;
      last = Date.now();
      void rereadPathRef.current();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => { window.removeEventListener("focus", back); document.removeEventListener("visibilitychange", back); };
  }, [embedded]);

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
        // The level the gateway reported for this page (kept for the plain-text fallback,
        // which outlives the socket's own level state).
        let noteLevel: string = note._level ?? "own";
        setLevel(note._level ?? "own");
        setPath(note.path ?? null);
        setProjectNote(note.tags?.includes("project") || note.metadata?.type === "project" ? note as Note : null);
        if (typeof note.metadata?.contentFont === "string") setContentFont(note.metadata.contentFont as ContentFont);
        setIcon(typeof note.metadata?.icon === "string" ? note.metadata.icon : null);
        setCover(parseCover(note.metadata ?? null));
        const k = detectKind(note);
        setKind(k);
        if (k === "code") setLanguage(detectCodeLanguage(note.path ?? null, note.metadata ?? null));
        const filename = note.path?.split("/").pop() as string | undefined;
        // A container-named page (`<folder>/PROJECT`) is named by its title / name / folder, never by its file.
        const titleMeta = (typeof note.metadata?.title === "string" ? note.metadata.title : undefined) || containerTitle(note.path ?? null, note.metadata ?? null) || undefined;
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
        let busyRetries = 0; // `busy` refusals of this open retried automatically (see onAuthenticationFailed)
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
            noteLevel = fresh._level ?? "own";
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
          onSynced: () => { socketUp = true; busyRetries = 0; if (current()) { setSynced(true); setConnected(true); } },
          onStateless: ({ payload }) => {
            if (!current()) return;
            let message: { type?: unknown; state?: unknown; code?: unknown; reason?: unknown };
            try { message = JSON.parse(payload); } catch { return; }
            // "unsaved" = cannot be written as the page is; "pending" = not written yet, the server keeps trying; "saved" clears both.
            if (message.type === "prism:unsaved") {
              const reason = typeof message.reason === "string" ? message.reason : null;
              setServerUnsaved(message.state === "unsaved" ? { permanent: true, reason } : message.state === "pending" ? { permanent: false, reason } : null);
            }
            // The page was renamed / moved (by anyone): re-read where it is now.
            // (Spread over 0–1.5 s: every open socket of a moved page is told at the same moment.)
            else if (message.type === "prism:page-changed") window.setTimeout(() => { if (current()) void rereadPathRef.current(); }, Math.random() * 1500);
            else if (message.type === "prism:notice" && message.code === "external-replaced") setServerNotice("Changes made elsewhere replaced part of this page.");
            else if (message.type === "prism:notice" && message.code === "unsaved-discarded") setServerNotice("Changes on this page that could not be saved were discarded by the workspace owner. You are looking at the stored page.");
            // Only for a notice shown above: an unknown code leaves the standing notice (text AND code) as it is.
            if (message.type === "prism:notice" && (message.code === "external-replaced" || message.code === "unsaved-discarded")) setNoticeCode(message.code);
          },
          onAuthenticationFailed: ({ reason }) => {
            if (!current()) return;
            setLevel(null);
            if (reason?.startsWith("update_required")) { setUpdateRequired(true); p?.disconnect(); }
            // No live document exists for this page (nothing was synced, so nothing of it is
            // in this device's local copy): show the stored page as plain text.
            else if (reason?.startsWith("too_complex")) { setTooComplex(noteLevel === "edit" || noteLevel === "own" ? "edit" : "view"); p?.disconnect(); }
            // The server could not take the open right now — nothing is wrong with the page or the access.
            // Retried quietly a few times first (a new page whose first read the vault was slow
            // to answer is refused `busy` rather than opened as the wrong kind of document).
            else if (reason?.startsWith("busy")) {
              p?.disconnect();
              if (busyRetries < BUSY_RETRIES) {
                const wait = 600 * 2 ** busyRetries++;
                window.setTimeout(() => { if (current()) void p?.connect(); }, wait);
              } else setConnectionError(true);
            }
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
  }, [noteId, attempt]);


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

  if (tooComplex) {
    const openLive = () => {
      setTooComplex(null);
      setConnection(null);
      setSynced(false);
      setConnected(false);
      setAttempt((n) => n + 1);
    };
    return <PlainTextPage noteId={noteId} canEdit={tooComplex === "edit"} embedded={embedded} onOpenLive={openLive} />;
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
  const statusColor = connected ? "#22c55e" : online ? "#eab308" : "#ef4444";
  // A phone: the page has ONE chrome row (in the editor, above the body). The connection state, the
  // Comments button and the backlinks count are items of it instead of three strips of their own.
  const inRow = narrow && isDocument;
  // The row's mode button already says Editing / Suggesting: next to it the state is just "Live".
  const modeInRow = editable && !useCommands && canReview && !isSuggestLevel;
  const rowStatus = (
    <>
      <span className="document-chrome-dot" style={{ background: statusColor }} />
      <span>{connected ? (modeInRow ? "Live" : `Live · ${statusText}`) : statusText}</span>
    </>
  );
  const rowActions = (
    <>
      {showComments && <CommentsRowButton ydoc={ydoc} open={commentsOpen} onToggle={() => setCommentsOpen((o) => !o)} />}
      {embedded && <BacklinksPill inline noteId={noteId} title={title} />}
    </>
  );
  const sidebar = <CommentsSidebar noteId={noteId} ydoc={ydoc} user={user} canComment={canComment} editor={editor} focusedThreadId={focusedThread} actions={commentActions} />;

  return (
    <div style={outer}>
      {localSave === "unavailable" && <p role="alert" className="rounded-lg border p-3 text-sm">Local saving is unavailable. Keep this document open and copy any unsynced changes before leaving.</p>}
      {serverUnsaved?.permanent && (
        <p role="alert" data-testid="collab-not-saved" data-reason={serverUnsaved.reason ?? ""} className="rounded-lg border p-3 text-sm">
          {NOT_SAVED_TO_PAGE}. {unsavedExplanation(serverUnsaved.reason)}
        </p>
      )}
      {/* external-replaced: the replaced text was set aside on the server (Recovered text) — the owner gets
          it here, everyone else is told who has it. */}
      {serverNotice && noticeCode === "external-replaced" && (
        <ReplacedNotice noteId={noteId} text={serverNotice} owner={!!getMe()?.isOwner && !getCapabilityToken()} onDismiss={() => setServerNotice(null)} />
      )}
      {serverNotice && noticeCode !== "external-replaced" && (
        <p role="status" data-testid="collab-notice" className="rounded-lg border p-3 text-sm">
          {serverNotice}{" "}
          <button type="button" className="underline" onClick={() => setServerNotice(null)}>Dismiss</button>
        </p>
      )}
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
          title={isContainerPath(path) ? title : undefined}
          fallbackName={title}
          details={<NotePropertyBar noteId={noteId} readOnly={!canReview} fallback={<PageProperties path={path} />} />}
          onRename={canReview ? handleRename : undefined}
          icon={icon}
          onIconChange={canReview ? handleIconChange : undefined}
          onAddCover={canReview && isDocument && !cover ? () => handleCoverChange({ kind: "gradient", value: COVER_GRADIENTS[Math.floor(Math.random() * COVER_GRADIENTS.length)]!.name, y: 50 }) : undefined}
          presence={<PresenceAvatars awareness={provider.awareness as never} editor={editor} compact={narrow} />}
          right={inRow ? undefined : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor }} />
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
          )}
        />

        {titleNotice && <p role="status" className="mb-4 text-xs text-[var(--text-secondary)]">{titleNotice}
          {finishRename && <> <button type="button" className="focus-ring underline" disabled={finishing} aria-busy={finishing || undefined}
            onClick={() => { setFinishing(true); void finishRename().then((ok) => { if (!mounted.current) return; setFinishing(false); if (ok) { setFinishRename(null); setTitleNotice(""); } else setTitleNotice("Some sub-pages still need moving. Try Finish move again."); }); }}>Finish move</button></>}
        </p>}
        {uploadNotice && <p role="alert" className="mb-4 text-xs text-[var(--text-secondary)]">{uploadNotice} <button type="button" className="underline" onClick={() => setUploadNotice(null)}>Dismiss</button></p>}
        {embedded && isDocument && !inRow && <div style={{ maxWidth: "var(--content-measure)", margin: "0 auto" }}><BacklinksPill noteId={noteId} title={title} /></div>}

        {/* NP-CO-02: page-level discussion (threads about the page, not anchored to text). On a phone it is
            in the Comments drawer (ONE comments entry point: the row's button). */}
        {isDocument && showComments && !inRow && <PageDiscussion ydoc={ydoc} user={user} canComment={canComment} editor={editor} actions={commentActions} />}

        {/* Doc + (desktop) inline comments */}
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
          <div
            data-content-font={isDocument ? contentFont : undefined}
            className={isDocument ? "collab-document-body" : undefined}
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
                chrome={inRow ? { status: rowStatus, trailing: rowActions } : undefined}
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
            {projectNote?.id === noteId && isDocument && !getCapabilityToken() && <ProjectSections project={projectNote} onNavigate={onWikilinkNavigate} />}
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
          {/* `.collab-comments-drawer` (collab.css): it fills the VISIBLE area while a software keyboard
              is open, so a reply field and its buttons stay above the keys and it scrolls inside. */}
          <div
            ref={drawerRef}
            role="dialog"
            aria-label="Comments"
            tabIndex={-1}
            className="collab-comments-drawer"
            style={{
              position: "fixed",
              right: 0,
              width: "min(360px, 88vw)",
              zIndex: 41,
              background: "var(--bg-base, #0d0d0f)",
              borderLeft: "1px solid var(--glass-border)",
              overflowY: "auto",
              outline: "none",
            }}
          >
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
              <button type="button" aria-label="Close comments" onClick={() => setCommentsOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}>
                <X size={18} />
              </button>
            </div>
            {/* The page-level "Add comment" (its threads are in the list below, with the anchored ones). */}
            {inRow && <PageDiscussion composeOnly ydoc={ydoc} user={user} canComment={canComment} editor={editor} actions={commentActions} />}
            {sidebar}
          </div>
        </>
      )}
    </div>
  );
}
