import { useAgentDocumentSnapshot } from "../../lib/agent/documentSnapshots";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BubbleMenu } from "@tiptap/react/menus";
import { SelectionActions } from "./SelectionActions";
import { useAgentClient } from "../../data/AgentClientContext";
import { useEditor, EditorContent } from "@tiptap/react";
import { useUIStore } from "../../app/stores/ui";
import { useNotes } from "../../app/hooks/useParachute";
import { WikilinkDropdown } from "./WikilinkDropdown";
import { sanitizeHtml } from "../../lib/html/sanitize";
import { InlinePrompt } from "../agent/InlinePrompt";
import { isDesktop } from "../../lib/platform";
import { useHostServices } from "../../data/HostServicesContext";
import { WikilinkExtension } from "../../lib/tiptap/WikilinkMark";
import { WikilinkAutocomplete, type WikilinkAutocompleteState } from "../../lib/tiptap/WikilinkAutocomplete";
import { SlashCommand, type SlashCommandState } from "../../lib/tiptap/SlashCommand";
import { SlashMenu } from "./SlashMenu";
import { SearchHighlight } from "../../lib/tiptap/SearchHighlight";
import { blockSchemaExtensions } from "../../editor/blocks";
import { mentionExtensions } from "../../lib/tiptap/MentionNode";
import "../../lib/tiptap/MentionView";
import { MentionSuggest, type MentionSuggestState } from "../../lib/tiptap/MentionSuggest";
import { MentionContext, setMentionNoteId } from "../../lib/tiptap/MentionContext";
import { MentionMenu } from "../../lib/tiptap/MentionMenu";
import { BlockKeymap } from "../../lib/tiptap/blockCommands";
import { EditorKeys, editorPlaceholder, blockSelectionActive } from "../../lib/tiptap/EditorKeys";
import { FIND_IN_PAGE_EVENT, isReplaceShortcut, editorIsOnScreen } from "../../lib/tiptap/findShortcuts";
import { BlockHandles } from "./BlockHandles";
import { TableControls } from "./TableControls";
import { ImageUpload } from "../../lib/tiptap/ImageUpload";
import "../../lib/tiptap/mediaViews";
import { UrlPaste, type UrlPasteState, type Unfurler } from "../../lib/tiptap/UrlPaste";
import { PasteUrlMenu } from "./PasteUrlMenu";
import { DatabaseInsert, type DatabaseInsertRequest } from "../../lib/tiptap/databaseView";
import { InsertDatabaseDialog } from "./InsertDatabaseDialog";
import { PageCover } from "./PageCover";
import { COVER_GRADIENTS, coverPatch, parseCover, type PageCover as Cover } from "../../lib/media/attachments";
import { useVaultClient } from "../../data/VaultClientContext";
import { ChildPages } from "../../lib/tiptap/childPage";
import { createSubPage } from "../../lib/tiptap/subPages";
import { trashPage } from "../../lib/pages/ops";
import { useQueryClient } from "@tanstack/react-query";
import { EditorFindBar } from "./EditorFindBar";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Typography from "@tiptap/extension-typography";
import type { RendererProps } from "./RendererProps";
import { useAutoSave } from "../../app/hooks/useAutoSave";
import { useWikilinkNavigate } from "../../app/hooks/useWikilinkNavigate";
import { convertApi } from "../../lib/parachute/client";
import { DocumentOutline } from "./DocumentOutline";
import { EditorToolbar } from "./EditorToolbar";
import { KeyboardToolbar } from "./KeyboardToolbar";
import { BacklinksPill } from "../layout/BacklinksPill";
import { EmptyPageStarters } from "./EmptyPageStarters";
import { PageHeader, PageProperties, renamePath, type ContentFont } from "./DocumentChrome";
import { PropertyBar } from "../database/PropertyBar";
import { useUpdateNote } from "../../app/hooks/useParachute";
import { reviewMode } from "../../lib/governance/review";
import { ReviewBanner } from "./ReviewBanner";
import "./editor-blocks.css";

export default function DocumentRenderer({ note, onMetadataChange, readOnly }: RendererProps) {
  // ── P4 governed-editing gate (WEB, NON-OWNER ONLY) ────────────────────────
  // `reviewMode` reads the gateway's `_caps` annotation, which the Prism Server
  // adds ONLY for a non-owner actor. The desktop shell reads the vault directly
  // through TauriVaultClient, and a web OWNER is served by the transparent
  // passthrough — neither response carries `_caps`, so `mode` is "none" for them
  // and every branch below collapses to the pre-P4 behavior. ONE gate, read once
  // here; nothing further down re-derives it.
  //   "none"      → unchanged: autosave, editable, no banner.
  //   "propose"   → editable locally, autosave SUPPRESSED (it could only 403),
  //                 banner offers "Submit for review".
  //   "read-only" → editor read-only with a one-line notice.
  const mode = reviewMode(note);
  // `readOnly` (published wiki / anonymous surfaces) wins outright: those
  // responses carry no `_caps` today, and if they ever did, a public reader must
  // not be offered a submit button.
  const governed = mode !== "none" && !readOnly;
  const { data: allNotes } = useNotes();
  const [autocompleteState, setAutocompleteState] = useState<WikilinkAutocompleteState | null>(null);
  const [slashState, setSlashState] = useState<SlashCommandState | null>(null);
  const [mentionState, setMentionState] = useState<MentionSuggestState | null>(null);

  // Per-document content font (Notion-style "Aa" switch). Defaults to sans;
  // the choice is persisted in note metadata so it travels with the doc.
  const [contentFont, setContentFont] = useState<ContentFont>(
    (note.metadata?.contentFont as ContentFont) || "sans",
  );
  useEffect(() => {
    setContentFont((note.metadata?.contentFont as ContentFont) || "sans");
  }, [note.id]); // re-sync when switching documents
  // A governed reader may still flip their own reading font — it just cannot be
  // PERSISTED to a note they may not write. `persistMetadata` is the single
  // choke point for that; when `_caps` is absent it is `onMetadataChange`
  // itself, so the desktop/owner path is untouched.
  const persistMetadata = governed || readOnly ? undefined : onMetadataChange;
  const changeFont = useCallback((f: ContentFont) => {
    setContentFont(f);
    persistMetadata?.({ contentFont: f });
  }, [persistMetadata]);

  // Surface the reading-font control to the shell (bottom bar / More sheet)
  // instead of the document header — keeps the top chrome uncluttered.
  const registerDocFont = useUIStore((s) => s.registerDocFont);
  useEffect(() => {
    registerDocFont(contentFont, changeFont);
    return () => registerDocFont(null, null);
  }, [contentFont, changeFont, registerDocFont]);

  const vaultClient = useVaultClient();
  // Page cover (NP-PG-02): metadata `cover` + `coverY`, optimistic locally.
  const [cover, setCover] = useState<Cover | null>(() => parseCover(note.metadata));
  useEffect(() => { setCover(parseCover(note.metadata)); }, [note.id, note.metadata?.cover, note.metadata?.coverY]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeCover = useCallback((next: Cover | null) => {
    setCover(next);
    persistMetadata?.(coverPatch(next));
  }, [persistMetadata]);
  const uploadCover = useCallback(async (file: File) => (await vaultClient.uploadAttachment!(note.id, file, { kind: "image" })).url, [vaultClient, note.id]);

  // Rename the note by editing the title in the page header (preserves folder +
  // extension; updates the open tab's label).
  const updateNote = useUpdateNote();
  const renameTab = useUIStore((s) => s.renameTab);
  const handleRename = useCallback(async (newName: string) => {
    if (readOnly || governed) return; // read-only surface / no edit access: never rename/persist
    const next = renamePath(note.path, newName);
    if (!next) return;
    await updateNote.mutateAsync({ id: note.id, path: next });
    renameTab(note.id, newName.trim());
  }, [note.path, note.id, updateNote, renameTab, readOnly, governed]);

  // Wikilink navigation (shared with the collaborative editors).
  const handleWikilinkNavigate = useWikilinkNavigate();

  // Image paste/drop/pick: only when the host can store attachments.
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Hidden for read-only and governed (propose-only) surfaces: an attachment
  // is a write the reviewer never sees.
  const canUpload = !!vaultClient.uploadAttachment && !readOnly && !governed;
  const uploadRef = useRef<(file: File) => Promise<{ src: string; alt?: string }>>(async () => { throw new Error("unavailable"); });
  uploadRef.current = async (file: File) => {
    setUploadError(null);
    const attachment = await vaultClient.uploadAttachment!(note.id, file, { kind: "image" });
    return { src: attachment.url, alt: attachment.name.replace(/\.[^.]+$/, "") };
  };
  const upload = useMemo(() => (canUpload ? (file: File) => uploadRef.current(file) : undefined), [canUpload]);
  const fileUploadRef = useRef<(file: File) => Promise<{ src: string; name: string; size: number; mimeType: string }>>(async () => { throw new Error("unavailable"); });
  fileUploadRef.current = async (file: File) => {
    setUploadError(null);
    const a = await vaultClient.uploadAttachment!(note.id, file, { kind: "file" });
    return { src: a.url, name: a.name, size: a.size, mimeType: a.mimeType };
  };
  const uploadFile = useMemo(() => (canUpload ? (file: File) => fileUploadRef.current(file) : undefined), [canUpload]);
  // Link previews for bookmark blocks (GET /api/unfurl through the host).
  const unfurlRef = useRef<Unfurler | undefined>(undefined);
  unfurlRef.current = vaultClient.unfurl ? (url) => vaultClient.unfurl!(url) : undefined;
  const unfurl = useMemo<Unfurler | undefined>(() => (vaultClient.unfurl ? (url) => unfurlRef.current!(url) : undefined), [!!vaultClient.unfurl]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pasteState, setPasteState] = useState<UrlPasteState | null>(null);
  const [dbInsert, setDbInsert] = useState<DatabaseInsertRequest | null>(null);
  // Sub-pages (NP-PG-15): only where this page itself may be written.
  const queryClient = useQueryClient();
  const pathRef = useRef(note.path);
  pathRef.current = note.path;
  const subPagesRef = useRef({ client: vaultClient, queryClient });
  subPagesRef.current = { client: vaultClient, queryClient };
  const canSubPage = !readOnly && !governed && !!note.path;
  const childPages = useMemo(() => ChildPages.configure(canSubPage ? {
    hostPath: () => pathRef.current,
    create: () => createSubPage(subPagesRef.current.client, subPagesRef.current.queryClient, pathRef.current ?? ""),
    trash: (id: string) => trashPage(subPagesRef.current.client, id).then(() => void subPagesRef.current.queryClient.invalidateQueries({ queryKey: ["vault"] })),
  } : {}), [canSubPage]);

  const extensions = useMemo(() => [
    StarterKit.configure({ codeBlock: false, link: false }),
    Placeholder.configure(editorPlaceholder("Start writing, or press / for commands...")),
    // Images, tables, callouts, toggles, columns, colours: the SAME list the
    // live editor and the server use, so a note round-trips through either.
    ...blockSchemaExtensions(),
    // @-mention chips: part of the shared schema (COLLAB_SCHEMA_VERSION 3).
    ...mentionExtensions(),
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight.configure({ multicolor: true }),
    Link.configure({ openOnClick: false, autolink: true }),
    Typography.configure({ raquo: false, laquo: false }),
    WikilinkExtension.configure({ onNavigate: handleWikilinkNavigate }),
    WikilinkAutocomplete.configure({ onStateChange: setAutocompleteState }),
    SlashCommand.configure({ onStateChange: setSlashState }),
    MentionSuggest.configure({ onStateChange: setMentionState }),
    MentionContext.configure({ noteId: note.id }),
    SearchHighlight,
    BlockKeymap,
    EditorKeys,
    ImageUpload.configure({ upload, uploadFile, onError: setUploadError }),
    UrlPaste.configure({ onStateChange: setPasteState, unfurl }),
    // Inline/linked databases: only where the page itself may be written.
    DatabaseInsert.configure({ onRequest: readOnly || governed ? undefined : setDbInsert }),
    childPages,
  ], [handleWikilinkNavigate, upload, uploadFile, unfurl, readOnly, governed, childPages]);
  const [initialHtml, setInitialHtml] = useState<string | null>(null);
  const contentRef = useRef<string>(note.content);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  // Convert markdown → HTML on load
  useEffect(() => {
    let cancelled = false;
    async function convert() {
      if (!note.content || note.content.trim() === "") {
        setInitialHtml("");
        return;
      }
      // If content looks like HTML already, use directly
      if (note.content.trim().startsWith("<")) {
        setInitialHtml(note.content);
        return;
      }
      const html = await convertApi.markdownToHtml(note.content);
      if (!cancelled) setInitialHtml(html);
    }
    convert();
    return () => { cancelled = true; };
  }, [note.id]); // Only re-convert when opening a different note

  // Track what the user has saved so we can distinguish user saves from agent edits.
  // When note.content changes on the server, if it matches what we last saved,
  // it's our own save round-tripping — not an agent edit.
  const lastKnownContent = useRef(note.content);
  const lastUserSavedContent = useRef<string | null>(null);

  useEffect(() => {
    if (note.content === lastKnownContent.current) return;
    if (!editorRef.current) return;

    // If this server update matches what the user just saved, it's not an agent edit
    if (lastUserSavedContent.current !== null && note.content === lastUserSavedContent.current) {
      lastKnownContent.current = note.content;
      return;
    }

    // External source (agent MCP) changed the note — show as ghost text for review
    const { setGhostText } = useUIStore.getState();
    setGhostText({
      noteId: note.id,
      content: note.content,
      position: "end",
    });
    lastKnownContent.current = note.content;
  }, [note.content, note.id]);

  const getContent = useCallback(() => contentRef.current, []);
  const onSaved = useCallback((content: string) => {
    lastUserSavedContent.current = content;
  }, []);
  const { isSaving, lastSaved, saveError, scheduleSave: rawScheduleSave, saveNow: rawSaveNow } = useAutoSave(note.id, getContent, 2000, onSaved);
  // Read-only surfaces (published Wiki / anonymous): never write back. Wrapping
  // the autosave triggers keeps every downstream call site unchanged while
  // guaranteeing no vault mutation when readOnly is set.
  // `governed` joins `readOnly` here: without the `edit` cap every autosave is a
  // silent 403, so we suppress the write entirely and route the change through
  // the review banner instead. (`governed` is false whenever `_caps` is absent —
  // desktop and owners keep the exact previous behavior.)
  const noWrite = readOnly || governed;
  const scheduleSave = useCallback(() => { if (!noWrite) rawScheduleSave(); }, [noWrite, rawScheduleSave]);
  const saveNow = useCallback(() => { if (!noWrite) rawSaveNow(); }, [noWrite, rawSaveNow]);
  // Editing stays LOCAL in "propose" mode — that is the point: type your change,
  // then submit it. Only "read-only" (view/comment caps) locks the editor.
  const notEditable = readOnly || mode === "read-only";

  const editor = useEditor({
    extensions,
    content: initialHtml || "",
    editable: !notEditable,
    editorProps: {
      attributes: {
        class: "prose-editor outline-none min-h-[200px]",
      },
    },
    onUpdate: ({ editor }) => {
      contentRef.current = editor.getHTML();
      scheduleSave();
    },
  }, [initialHtml]); // Re-create editor when initialHtml changes

  editorRef.current = editor;
  useEffect(() => setMentionNoteId(editor, note.id), [editor, note.id]);

  // Keep the editor's editable state in sync if readOnly flips after creation.
  // emitUpdate: false — setEditable's default emits TipTap's `update` event,
  // which our onUpdate treats as a content change and AUTOSAVES. On mount this
  // effect runs against the pre-conversion (empty) editor instance, so the
  // default clobbered the note with "<p></p>" whenever markdown→HTML conversion
  // finished after the 2s debounce (seen entering edit mode from the bioregion
  // renderer). Editability changes are not content changes; never emit.
  useEffect(() => {
    if (editor) editor.setEditable(!notEditable, false);
  }, [editor, notEditable]);

  useAgentDocumentSnapshot(editor, note.id, note.path?.split("/").pop() || "Untitled", note.updatedAt);

  // Agent write-back: watch for pending edits from PanelChat via Zustand store
  const pendingEdit = useUIStore((s) => s.pendingEdit);
  const clearPendingEdit = useUIStore((s) => s.clearPendingEdit);

  useEffect(() => {
    if (!pendingEdit || pendingEdit.noteId !== note.id || !editorRef.current) return;

    const applyEdit = async () => {
      const ed = editorRef.current;
      if (!ed) return;

      let html: string;
      // Convert markdown content to HTML for TipTap
      if (pendingEdit.content.trim().startsWith("<")) {
        html = pendingEdit.content;
      } else {
        html = await convertApi.markdownToHtml(pendingEdit.content);
      }

      if (pendingEdit.mode === "replace") {
        ed.commands.setContent(html);
      } else {
        // Append: move cursor to end, insert a separator, then the new content
        ed.commands.focus("end");
        ed.commands.insertContent("<hr>");
        ed.commands.insertContent(html);
      }

      // Update contentRef and trigger save
      contentRef.current = ed.getHTML();
      scheduleSave();
      clearPendingEdit();
    };

    applyEdit();
  }, [pendingEdit, note.id, clearPendingEdit, scheduleSave]);

  // In-note find bar state
  const [findOpen, setFindOpen] = useState(false);
  const [findReplace, setFindReplace] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Inline prompt state
  const { inlinePromptOpen, inlinePromptPosition, inlinePromptSelection, openInlinePrompt, closeInlinePrompt } = useUIStore();
  const hostServices = useHostServices();
  const inlineAgent = isDesktop || !!hostServices;
  const sessionAgent = useAgentClient();

  // Handle Cmd+S and Cmd+J
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveNow();
      }
      // ⌘J — inline agent prompt (desktop, or a thin client whose owner has the
      // server agent: WP4.3 host services)
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        if (sessionAgent || !editor || !inlineAgent) return;
        const { from, to } = editor.state.selection;
        const selectedText = editor.state.doc.textBetween(from, to, " ");
        if (!selectedText.trim()) return; // Need selected text

        // Get selection coordinates for positioning
        const view = editor.view;
        const coords = view.coordsAtPos(from);
        openInlinePrompt(
          { x: coords.left, y: coords.top },
          selectedText,
        );
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveNow, editor, openInlinePrompt, inlineAgent, sessionAgent]);

  // Cmd+F / Ctrl+F (find) and ⌘⌥F / Ctrl+Alt+F (replace) — scoped to the editor container. Only fires when focus is
  // inside this DocumentRenderer's subtree (or when document.activeElement is
  // inside it), so it won't hijack Cmd+F on dashboard/graph/agent views.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handler = (e: KeyboardEvent) => {
      const isReplace = isReplaceShortcut(e);
      const isFind = !isReplace && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f";
      if (!isFind && !isReplace) return;
      // Only activate if focus (or the event target) is inside this container.
      const active = document.activeElement;
      const target = e.target as Node | null;
      const insideContainer =
        (active && container.contains(active)) ||
        (target && container.contains(target));
      if (!insideContainer) return;
      e.preventDefault();
      setFindReplace(isReplace);
      setFindOpen(true);
    };

    // Phone ⋯ → "Find in page" (NP-ED-22): the shell asks whichever editor is on screen.
    const onFindRequest = () => { if (editorIsOnScreen(container)) { setFindReplace(false); setFindOpen(true); } };
    window.addEventListener(FIND_IN_PAGE_EVENT, onFindRequest);
    // Listen on the container itself so the event only bubbles from within.
    container.addEventListener("keydown", handler);
    return () => { container.removeEventListener("keydown", handler); window.removeEventListener(FIND_IN_PAGE_EVENT, onFindRequest); };
    // Re-run when initialHtml flips from null → string: on first mount the
    // component renders a loading placeholder and containerRef is null, so
    // the listener must re-attach once the real container mounts.
  }, [initialHtml]);

  if (initialHtml === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm" style={{ color: "var(--text-muted)" }}>Loading editor...</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="document-writing-surface flex flex-col h-full" data-content-font={contentFont}>
      {editor && <BubbleMenu editor={editor} pluginKey="documentSelectionActions" shouldShow={({ state }) => !state.selection.empty && !blockSelectionActive(state)}>
        <div className="document-selection-actions"><SelectionActions editor={editor} allowFormatting={!notEditable} /></div>
      </BubbleMenu>}
      {/* Toolbar (hidden on read-only surfaces — no editing affordances) */}
      {editor && !notEditable && <EditorToolbar editor={editor} />}
      {editor && !notEditable && <KeyboardToolbar editor={editor} />}
      {editor && notEditable && <div className="document-outline-readonly"><DocumentOutline editor={editor} /></div>}

      {/* Governed note (web, non-owner): the propose-for-review affordance, plus
          the per-note history. Never rendered when `_caps` is absent. */}
      {governed && (
        <div style={{ padding: "10px var(--space-6) 0" }}>
          <ReviewBanner
            noteId={note.id}
            mode={mode as "propose" | "read-only"}
            getContent={() => editorRef.current?.getHTML() ?? contentRef.current}
          />
        </div>
      )}

      {/* Editor */}
      <div className="document-writing-scroll flex-1 overflow-auto relative">
        <PageCover
          cover={cover}
          onChange={persistMetadata ? changeCover : undefined}
          onUpload={canUpload ? uploadCover : undefined}
        />
        <div className="document-writing-measure">
          <PageHeader
            path={note.path}
            details={(() => {
              const pageDetails = <PageProperties path={note.path} tags={note.tags ?? []} updatedAt={note.updatedAt} onOpenAll={() => useUIStore.setState({contextPanelOpen:true,contextPanelTab:"metadata"})}/>;
              // Published / anonymous surfaces keep the plain details: page metadata is not published.
              return readOnly ? pageDetails : <PropertyBar note={note} trailing={pageDetails} />;
            })()}
            onRename={readOnly || governed ? undefined : handleRename}
            icon={note.metadata?.icon as string | undefined}
            onIconChange={persistMetadata ? (emoji) => persistMetadata({ icon: emoji }) : undefined}
            onAddCover={persistMetadata && !cover ? () => changeCover({ kind: "gradient", value: COVER_GRADIENTS[Math.floor(Math.random() * COVER_GRADIENTS.length)].name, y: 50 }) : undefined}
          />
          {!readOnly && <BacklinksPill noteId={note.id} title={note.path?.split("/").pop() ?? ""} />}
          <EditorContent editor={editor} />
          {editor && !notEditable && <EmptyPageStarters editor={editor} noteId={note.id} title={note.path?.split("/").pop() ?? ""} />}
        </div>
        {/* Block gutter: ⋮⋮ drag / block menu and + insert (tap menu on phones) */}
        {editor && <BlockHandles editor={editor} enabled={!notEditable} notes={governed ? undefined : allNotes} noteId={note.id} />}
        {editor && !notEditable && <TableControls editor={editor} />}
        {/* Wikilink / @mention autocomplete dropdown */}
        {editor && autocompleteState?.active && (
          <WikilinkDropdown editor={editor} notes={allNotes || []} autocomplete={autocompleteState} hostPath={canSubPage ? note.path : undefined} />
        )}
        {/* `/` slash-command menu */}
        {editor && slashState?.active && (
          <SlashMenu editor={editor} state={slashState} onClose={() => setSlashState(null)} />
        )}
        {/* "Paste as" menu after a bare URL paste */}
        {editor && pasteState && !notEditable && (
          <PasteUrlMenu editor={editor} state={pasteState} unfurl={unfurl} onClose={() => setPasteState(null)} />
        )}
        {/* `@` mention menu: people, pages, dates, reminders */}
        {editor && mentionState?.active && <MentionMenu editor={editor} state={mentionState} notes={allNotes || []} />}
        {editor && dbInsert && <InsertDatabaseDialog editor={editor} request={dbInsert} hostPath={note.path} onClose={() => setDbInsert(null)} />}
        {/* In-note find bar (Cmd+F / Ctrl+F) */}
        {editor && findOpen && (
          <EditorFindBar editor={editor} replaceOpen={findReplace} onClose={() => { setFindOpen(false); setFindReplace(false); editor.commands.focus(); }} />
        )}
      </div>

      {/* Footer: save status (the font switch now lives in the shell bottom bar /
          More sheet, registered via the store). */}
      <div
        className="document-save-footer flex items-center justify-end px-4 py-1 text-xs gap-3"
        style={{ color: "var(--text-muted)", borderTop: "1px solid var(--glass-border)" }}
      >
        <div className="flex items-center gap-3">
          {uploadError && <span role="alert">{uploadError} <button type="button" onClick={() => setUploadError(null)} className="underline">Dismiss</button></span>}
          {saveError && <span role="alert">{saveError} <button type="button" onClick={saveNow} className="underline">Retry save</button></span>}
          {isSaving && <span>Saving...</span>}
          {lastSaved && !isSaving && !saveError && (
            <span>Saved {lastSaved.toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      {/* Ghost text: agent-generated content awaiting accept/reject */}
      <GhostTextOverlay noteId={note.id} editor={editor} scheduleSave={scheduleSave} contentRef={contentRef} />

      {/* Inline agent prompt (⌘J) */}
      {inlinePromptOpen && inlinePromptPosition && (
        <InlinePrompt
          noteId={note.id}
          selection={inlinePromptSelection}
          position={inlinePromptPosition}
          onAccept={(replacement) => {
            if (editor) {
              editor.commands.insertContent(replacement);
              contentRef.current = editor.getHTML();
              scheduleSave();
            }
            closeInlinePrompt();
          }}
          onReject={closeInlinePrompt}
        />
      )}
    </div>
  );
}

/**
 * Ghost text overlay: shows agent-generated content in a preview panel
 * at the bottom of the editor with Accept/Reject controls.
 */
function GhostTextOverlay({
  noteId,
  editor,
  scheduleSave,
  contentRef,
}: {
  noteId: string;
  editor: ReturnType<typeof useEditor>;
  scheduleSave: () => void;
  contentRef: React.MutableRefObject<string>;
}) {
  const ghostText = useUIStore((s) => s.ghostText);
  const rejectGhostText = useUIStore((s) => s.rejectGhostText);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  // Convert ghost text content to HTML for preview
  useEffect(() => {
    if (!ghostText || ghostText.noteId !== noteId) {
      setPreviewHtml(null);
      return;
    }
    let cancelled = false;
    async function convert() {
      const content = ghostText!.content;
      if (content.trim().startsWith("<")) {
        if (!cancelled) setPreviewHtml(content);
      } else {
        const html = await convertApi.markdownToHtml(content);
        if (!cancelled) setPreviewHtml(html);
      }
    }
    convert();
    return () => { cancelled = true; };
  }, [ghostText, noteId]);

  if (!ghostText || ghostText.noteId !== noteId || !previewHtml) return null;

  const handleAccept = async () => {
    if (!editor) return;
    // Replace the entire document with the agent's version
    editor.commands.setContent(previewHtml);
    contentRef.current = editor.getHTML();
    scheduleSave();
    rejectGhostText();
  };

  return (
    <div
      className="mx-6 mb-2 rounded-lg overflow-hidden"
      style={{ border: "2px dashed var(--color-accent)", background: "var(--glass)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{ background: "rgba(var(--accent-rgb, 99,102,241), 0.1)", borderBottom: "1px solid var(--glass-border)" }}
      >
        <span className="text-xs font-medium" style={{ color: "var(--color-accent)" }}>
          Agent edited this document — review changes
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleAccept}
            className="px-3 py-1 rounded text-xs font-medium"
            style={{ background: "var(--color-accent)", color: "white" }}
          >
            Accept
          </button>
          <button
            onClick={rejectGhostText}
            className="px-3 py-1 rounded text-xs"
            style={{ color: "var(--text-secondary)", background: "var(--glass)" }}
          >
            Reject
          </button>
        </div>
      </div>
      {/* Preview content */}
      <div
        className="px-4 py-3 prose-editor max-h-64 overflow-auto"
        style={{ opacity: 0.7, color: "var(--text-secondary)" }}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(previewHtml) }}
      />
    </div>
  );
}
