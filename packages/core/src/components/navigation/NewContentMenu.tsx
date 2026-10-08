import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  Presentation,
  Code,
  MessageSquare,
  Mail,
  Table2,
  Globe,
  CheckSquare,
  LayoutDashboard,
  PenTool,
  X,
  ChevronDown,
  Folder,
  Search,
  Check,
  ArrowRight,
  LayoutTemplate,
  Database,
  Settings2,
} from "lucide-react";
import { useVaultClient } from "../../data/VaultClientContext";
import { useUIStore } from "../../app/stores/ui";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import type { ContentType } from "../../lib/types";
import { TaskCreateDialog } from "../tasks/TaskCreateDialog";
import { TEMPLATE_TAG, pageTitle, referencesAttachments, templateCopy, templateWantsTags, withoutTrashed } from "../../lib/pages/model";
import { useCollabSharing } from "../../data/CollabSharing";
import { inferContentType } from "../../lib/schemas/content-types";
import { applyTemplateVariables, templateCreator } from "../../lib/pages/templates";
import { serverFetch } from "../../lib/transport/serverFetch";
import { usePagesUI } from "../../lib/pages/store";
import { ComposeMessage } from "../comms/ComposeMessage";
import { NewDatabaseDialog } from "../database/NewDatabaseDialog";
import {
  folderLabel,
  newContentFolder,
  newContentFolders,
  newContentParams,
  validFolder,
} from "./newContent";

const OPTIONS = [
  {
    type: "document",
    label: "Page",
    detail: "A blank page for your next idea.",
    icon: FileText,
  },
  {
    type: "canvas",
    label: "Canvas",
    detail: "Arrange notes and connect ideas visually.",
    icon: PenTool,
  },
  {
    type: "spreadsheet",
    label: "Spreadsheet",
    detail: "Organize information in a shared table.",
    icon: Table2,
  },
  {
    type: "presentation",
    label: "Presentation",
    detail: "Build a story, one slide at a time.",
    icon: Presentation,
  },
  {
    type: "code",
    label: "Code file",
    detail: "A place for scripts and snippets.",
    icon: Code,
  },
  {
    type: "dashboard",
    label: "Dashboard",
    detail: "Bring useful views into one place.",
    icon: LayoutDashboard,
  },
  {
    // NP-DB-01: a full-page database. "New database" names it, mints its own tag and
    // defines its first properties (NewDatabaseDialog); "Use an existing tag" makes the
    // older page that asks for its source tag on first open.
    type: "database",
    label: "Database",
    detail: "A table of pages with board, calendar and gallery views.",
    icon: Database,
  },
  {
    type: "website",
    label: "Website",
    detail: "Create an HTML page in your vault.",
    icon: Globe,
  },
  {
    type: "task",
    label: "Task",
    detail: "Capture something to do.",
    icon: CheckSquare,
  },
  {
    type: "email",
    label: "Email draft",
    detail: "Write an email draft in your vault.",
    icon: Mail,
  },
  {
    type: "message",
    label: "Message",
    detail: "Start a conversation.",
    icon: MessageSquare,
  },
] as const;
type CreationType = (typeof OPTIONS)[number]["type"];
export interface NewContentMenuProps {
  onClose: () => void;
  /** Optional raw vault-relative folder for a tree/context-menu entry point. */
  initialFolder?: string;
  initialType?: ContentType;
  /** Opener for reliable focus restoration, including Safari pointer activation. */
  returnFocus?: HTMLElement | null;
  /** "New page from template": open with the template list showing. */
  startWithTemplates?: boolean;
  /** The Templates gallery's "Use": open with this template already picked. */
  initialTemplate?: { id: string; title: string };
}
export function NewContentMenu(props: NewContentMenuProps) {
  const client = useVaultClient();
  const scope = useAgentChatStore((s) => s.scope);
  const binding = JSON.stringify([scope, client.scope?.() ?? null]);
  const initial = useRef(binding);
  useEffect(() => {
    if (binding !== initial.current) props.onClose();
  }, [binding, props.onClose]);
  return binding === initial.current ? (
    <CreateContent key={binding} {...props} />
  ) : null;
}
function CreateContent({
  onClose,
  initialFolder,
  initialType = "document",
  returnFocus,
  startWithTemplates,
  initialTemplate,
}: NewContentMenuProps) {
  const client = useVaultClient();
  const queryClient = useQueryClient();
  const scope = useAgentChatStore((s) => s.scope);
  const initialScope = useRef(
    JSON.stringify([scope, client.scope?.() ?? null]),
  );
  const current = () =>
    initialScope.current ===
    JSON.stringify([
      useAgentChatStore.getState().scope,
      client.scope?.() ?? null,
    ]);
  const activeNoteId = useRef(
    useUIStore
      .getState()
      .openTabs.find((tab) => tab.id === useUIStore.getState().activeTabId)
      ?.noteId,
  );
  const tree = useQuery({
    queryKey: ["vault", "creation-locations", initialScope.current],
    queryFn: () => client.listTree(),
    retry: false,
  });
  const [type, setType] = useState<CreationType>(
    OPTIONS.some((option) => option.type === initialType)
      ? (initialType as CreationType)
      : "document",
  );
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState<string | null>(
    initialFolder !== undefined && validFolder(initialFolder)
      ? initialFolder
      : null,
  );
  const [showTypes, setShowTypes] = useState(false);
  // Templates: notes tagged `template` the viewer can see (lib/pages/model.ts).
  const templates = useQuery({
    queryKey: ["vault", "templates", initialScope.current],
    queryFn: async () => withoutTrashed(await client.listNotes({ tag: TEMPLATE_TAG })).filter((n) => n.tags?.includes(TEMPLATE_TAG)),
    retry: false,
  });
  const [template, setTemplate] = useState<{ id: string; title: string } | null>(initialTemplate ?? null);
  const [showTemplates, setShowTemplates] = useState(!!startWithTemplates);
  // 🔒 The tags a template would apply are DATA from a note someone else may have
  // written (a member can edit a shared template). They are applied silently only for
  // the viewer's OWN template; for anyone else's each tag must be ticked, default off.
  const sharing = useCollabSharing();
  const viewer = useQuery({ queryKey: ["viewer-role", client.scope?.() ?? scope], enabled: !!sharing?.getViewer, queryFn: () => sharing!.getViewer!(), staleTime: 5 * 60_000, retry: 1 });
  const me = viewer.data?.email?.toLowerCase() ?? null;
  const isMine = (n: { metadata?: Record<string, unknown> | null } & { _creator?: { me?: boolean } }): boolean =>
    n._creator?.me === true || (!!me && typeof n.metadata?.prism_creator === "string" && n.metadata.prism_creator.toLowerCase() === me);
  const chosenRow = template ? (templates.data ?? []).find((t) => t.id === template.id) : undefined;
  const foreignTags = chosenRow && !isMine(chosenRow) ? templateWantsTags(chosenRow) : [];
  const [tickedTags, setTickedTags] = useState<string[]>([]);
  useEffect(() => { setTickedTags([]); }, [template?.id]);
  const [showFolders, setShowFolders] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const option = OPTIONS.find((item) => item.type === type)!;
  const Icon = option.icon;
  const selectedFolder =
    folder ??
    newContentFolder(
      tree.isFetching || tree.isError ? [] : (tree.data ?? []),
      activeNoteId.current,
    );
  const folders = useMemo(
    () =>
      newContentFolders(
        tree.isFetching || tree.isError ? [] : (tree.data ?? []),
      ),
    [tree.data, tree.isFetching, tree.isError],
  );
  const visibleFolders = folders
    .filter((value) =>
      folderLabel(value).toLowerCase().includes(search.toLowerCase()),
    )
    .slice(0, 40);
  // "Database" = the New database dialog (its own tag + properties) where the shell can
  // write schemas; "Use an existing tag" (or a shell without schema writes) keeps the
  // older page that asks for its source tag on first open. A template keeps this dialog.
  const [existingTagDb, setExistingTagDb] = useState(false);
  const newDatabase = type === "database" && !template && !existingTagDb && !!client.updateSchema;
  const dedicated = type === "task" || type === "message" || newDatabase;
  useEffect(() => {
    if (folder === null && tree.data && !tree.isFetching && !tree.isError)
      setFolder(newContentFolder(tree.data, activeNoteId.current));
  }, [folder, tree.data, tree.isFetching, tree.isError]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (dedicated) return;
    const node = dialog.current;
    const trigger =
      returnFocus ?? (document.activeElement as HTMLElement | null);
    node?.showModal();
    titleInput.current?.focus();
    return () => {
      node?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [dedicated, returnFocus]);
  const close = () => {
    if (!lock.current) onClose();
  };
  const create = async () => {
    if (
      lock.current ||
      !current() ||
      tree.isPending ||
      (tree.isFetching && folder === null) ||
      dedicated
    )
      return;
    let input;
    try {
      input = newContentParams(
        type as ContentType,
        title,
        selectedFolder,
        tree.data ?? [],
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Check the title and location.",
      );
      return;
    }
    lock.current = true;
    setPending(true);
    setError("");
    try {
      // Refresh known names before a deliberate create, without reading bodies.
      if (tree.data) {
        const entries = await client.listTree();
        if (!alive.current || !current()) return;
        input = newContentParams(
          type as ContentType,
          title,
          selectedFolder,
          entries,
        );
      }
      let params = input.params;
      let openType = type as ContentType;
      if (template) {
        // Copy the template's body, properties and tags (minus `template` and system keys).
        const source = await client.getNote(template.id, { fresh: true });
        if (!alive.current || !current()) return;
        // NP-TX-02: `@today`, `@now` and `@me` resolve now, for this creator.
        const creator = await templateCreator(() => serverFetch("/auth/me"));
        if (!alive.current || !current()) return;
        const copy = applyTemplateVariables(templateCopy(source, input.title, selectedFolder), { now: new Date(), creator });
        // Judged on the FRESH template: its own maker's tags apply; anyone else's only if ticked here.
        if (!isMine(source as never)) copy.tags = copy.tags.filter((t) => tickedTags.includes(t));
        params = copy;
        openType = inferContentType({ ...source, metadata: copy.metadata, tags: copy.tags });
      }
      let note;
      let droppedTags: string[] = [];
      try {
        note = await client.createNote(params);
      } catch (e) {
        // A template's remembered tags go through the normal create rules. If this
        // person has no standing in one of them the page is still created — without
        // the tags — and they are told which (never a failed create).
        const tags = (params as { tags?: string[] }).tags ?? [];
        // (The HTTP status the transport reports — never a number that happens to be in a message.)
        if (!template || !tags.length || (e as { status?: unknown } | null)?.status !== 403) throw e;
        note = await client.createNote({ ...params, tags: [] });
        droppedTags = tags;
      }
      // A page made from a template gets its OWN copies of the template's files (its links
      // otherwise name the template's attachments, which only the template's viewers load).
      if (template && client.copyAttachments && referencesAttachments(params)) await client.copyAttachments(note.id).catch(() => null);
      if (!alive.current || !current()) return;
      void queryClient.invalidateQueries({ queryKey: ["vault"] });
      useUIStore.getState().openTab(note.id, input.title, openType);
      if (droppedTags.length) usePagesUI.getState().showToast({ message: `Created without the template’s tag${droppedTags.length === 1 ? "" : "s"} ${droppedTags.map((t) => `“${t}”`).join(", ")} — not applied, because you can’t add pages to ${droppedTags.length === 1 ? "it" : "them"}.` });
      onClose();
    } catch (e) {
      if (alive.current && current())
        setError(
          e instanceof Error
            ? e.message
            : "Could not create this page. Your title and location are kept.",
        );
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  if (type === "task") return <TaskCreateDialog onClose={onClose} />;
  if (type === "message") return <ComposeMessage onClose={onClose} />;
  if (newDatabase)
    return (
      <NewDatabaseDialog
        folder={selectedFolder}
        initialName={title}
        onClose={onClose}
        onUseExistingTag={() => setExistingTagDb(true)}
        onCreated={(note, name) => {
          void queryClient.invalidateQueries({ queryKey: ["vault"] });
          useUIStore.getState().openTab(note.id, name, "database");
        }}
      />
    );
  return (
    <dialog
      ref={dialog}
      aria-labelledby="new-content-title"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']",
          ),
        ).filter((node) => node.getClientRects().length > 0);
        event.preventDefault();
        if (!controls.length) return;
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? index <= 0
            ? controls.length - 1
            : index - 1
          : (index + 1) % controls.length;
        controls[next]?.focus();
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      className="p-0 backdrop:bg-black/30"
      style={{
        width: isMobile
          ? "calc(100vw - 16px)"
          : "min(520px, calc(100vw - 40px))",
        maxHeight: "calc(100dvh - 32px)",
        maxWidth: "calc(100vw - 16px)",
        margin: isMobile
          ? "auto 8px max(8px, env(safe-area-inset-bottom))"
          : "auto",
        border: "1px solid var(--glass-border)",
        borderRadius: 18,
        background: "var(--bg-base)",
        color: "var(--text-primary)",
        boxShadow: "0 24px 80px rgba(0,0,0,.16)",
        overflow: "auto",
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <h2
            id="new-content-title"
            className="text-sm font-medium"
            style={{ color: "var(--text-secondary)" }}
          >
            New {type === "document" ? "page" : option.label.toLowerCase()}
          </h2>
          <button
            type="button"
            aria-label="Close new page"
            disabled={pending}
            onClick={close}
            className="focus-ring flex size-control items-center justify-center rounded-lg hover:bg-[var(--glass-hover)]"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-6 pb-6">
          <div
            className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl"
            style={{
              background: "var(--glass)",
              color: "var(--text-secondary)",
            }}
          >
            <Icon size={27} strokeWidth={1.5} />
          </div>
          <label className="sr-only" htmlFor="new-content-name">
            Page title
          </label>
          <input
            id="new-content-name"
            data-display-text
            style={{
              fontSize: isMobile ? 26 : 30,
              fontWeight: 600,
              lineHeight: 1.3,
            }}
            ref={titleInput}
            value={title}
            maxLength={200}
            onChange={(event) => {
              setTitle(event.target.value);
              setError("");
            }}
            disabled={pending}
            placeholder="Untitled"
            autoComplete="off"
            className="w-full bg-transparent py-2 text-[28px] font-semibold tracking-tight outline-none placeholder:opacity-40"
          />
          <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
            {option.detail}
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span
              className="w-14 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              Format
            </span>
            <button
              type="button"
              disabled={pending}
              aria-expanded={showTypes}
              aria-controls="creation-formats"
              onClick={() => {
                setShowTypes(!showTypes);
                setShowFolders(false);
              }}
              className="focus-ring flex min-h-control items-center gap-2 rounded-lg px-3 text-sm hover:bg-[var(--glass-hover)]"
            >
              <Icon size={16} />
              {option.label}
              <ChevronDown size={14} />
            </button>
          </div>
          {showTypes && (
            <div
              id="creation-formats"
              aria-label="Page formats"
              className="mb-4 grid grid-cols-2 gap-1 rounded-xl border p-2"
              style={{ borderColor: "var(--glass-border)" }}
            >
              {OPTIONS.map((item) => (
                <button
                  type="button"
                  key={item.type}
                  disabled={pending}
                  onClick={() => {
                    setType(item.type);
                    setShowTypes(false);
                  }}
                  className="focus-ring flex min-h-control items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-[var(--glass-hover)]"
                  aria-pressed={type === item.type}
                >
                  <item.icon size={16} />
                  {item.label}
                  {type === item.type && (
                    <Check size={13} className="ml-auto" />
                  )}
                </button>
              ))}
            </div>
          )}
          {(type === "document" && (startWithTemplates || !!template || (templates.data?.length ?? 0) > 0)) && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="w-14 text-xs" style={{ color: "var(--text-muted)" }}>
                Template
              </span>
              <button
                type="button"
                disabled={pending}
                aria-expanded={showTemplates}
                aria-controls="creation-templates"
                onClick={() => {
                  setShowTemplates(!showTemplates);
                  setShowTypes(false);
                  setShowFolders(false);
                }}
                className="focus-ring flex min-h-control items-center gap-2 rounded-lg px-3 text-sm hover:bg-[var(--glass-hover)]"
              >
                <LayoutTemplate size={16} />
                {template ? template.title : "Blank page"}
                <ChevronDown size={14} />
              </button>
            </div>
          )}
          {type === "document" && showTemplates && (
            <div
              id="creation-templates"
              role="group"
              aria-label="Templates"
              className="mb-4 grid grid-cols-1 gap-1 rounded-xl border p-2 sm:grid-cols-2"
              style={{ borderColor: "var(--glass-border)" }}
            >
              <button
                type="button"
                disabled={pending}
                aria-pressed={!template}
                onClick={() => {
                  setTemplate(null);
                  setShowTemplates(false);
                }}
                className="focus-ring flex min-h-control items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-[var(--glass-hover)]"
              >
                <FileText size={16} />
                Blank page
                {!template && <Check size={13} className="ml-auto" />}
              </button>
              {(templates.data ?? []).map((t) => {
                const title = typeof t.metadata?.title === "string" && t.metadata.title ? (t.metadata.title as string) : pageTitle(t.path);
                return (
                  <button
                    type="button"
                    key={t.id}
                    disabled={pending}
                    aria-pressed={template?.id === t.id}
                    onClick={() => {
                      setTemplate({ id: t.id, title });
                      setShowTemplates(false);
                    }}
                    className="focus-ring flex min-h-control items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-[var(--glass-hover)]"
                  >
                    <LayoutTemplate size={16} />
                    <span className="truncate">{title}</span>
                    {template?.id === t.id && <Check size={13} className="ml-auto shrink-0" />}
                  </button>
                );
              })}
              {templates.isSuccess && !templates.data.length && (
                <p className="px-2 py-2 text-xs sm:col-span-2" style={{ color: "var(--text-muted)" }}>
                  No templates yet. Open a page and choose “Save as template” in its ⋯ menu.
                </p>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  // The gallery replaces this dialog (one modal at a time); it lists, edits and deletes templates.
                  onClose();
                  usePagesUI.getState().openTemplates(true);
                }}
                className="focus-ring flex min-h-control items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-[var(--glass-hover)] sm:col-span-2"
                style={{ color: "var(--text-secondary)" }}
              >
                <Settings2 size={16} />
                Manage templates…
              </button>
              {templates.isError && (
                <p className="px-2 py-2 text-xs sm:col-span-2" style={{ color: "var(--text-muted)" }}>
                  Templates couldn’t load. You can still start from a blank page.
                </p>
              )}
            </div>
          )}
          {type === "document" && template && foreignTags.length > 0 && (
            <fieldset role="group" aria-label="Tags from this template" className="mb-3 rounded-xl border px-3 py-2" style={{ borderColor: "var(--glass-border)" }}>
              <legend className="px-1 text-xs" style={{ color: "var(--text-muted)" }}>Tags</legend>
              <p className="mb-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                This template was made by someone else. Tick the tags the new page should get — a tag can share or publish a page.
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {foreignTags.map((t) => (
                  <label key={t} className="flex min-h-control items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={pending}
                      checked={tickedTags.includes(t)}
                      onChange={(e) => setTickedTags((now) => (e.target.checked ? [...now, t] : now.filter((x) => x !== t)))}
                    />
                    {t}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex items-center gap-2">
            <span
              className="w-14 shrink-0 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              Location
            </span>
            <button
              type="button"
              disabled={pending}
              aria-label={`Location: ${folderLabel(selectedFolder)}`}
              aria-expanded={showFolders}
              aria-controls="creation-folders"
              onClick={() => {
                setShowFolders(!showFolders);
                setShowTypes(false);
              }}
              className="focus-ring flex min-h-control min-w-0 items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-[var(--glass-hover)]"
            >
              <Folder size={16} className="shrink-0" />
              <span className="truncate">
                {(tree.isPending || tree.isFetching) && folder === null
                  ? "Finding your location…"
                  : folderLabel(selectedFolder)}
              </span>
              <ChevronDown size={14} className="shrink-0" />
            </button>
          </div>
          {showFolders && (
            <div
              id="creation-folders"
              className="mt-2 rounded-xl border p-2"
              style={{ borderColor: "var(--glass-border)" }}
            >
              <label
                className="flex items-center gap-2 border-b px-2 py-2"
                style={{ borderColor: "var(--glass-border)" }}
              >
                <Search size={16} />
                <span className="sr-only">Find a folder</span>
                <input
                  autoFocus
                  aria-label="Find a folder"
                  style={{ fontSize: 16 }}
                  disabled={pending}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                  }}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-base outline-none"
                  placeholder="Find a folder…"
                />
              </label>
              <div className="max-h-52 overflow-y-auto py-1">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setFolder("");
                    setShowFolders(false);
                  }}
                  className="focus-ring flex min-h-control w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-[var(--glass-hover)]"
                >
                  <Folder size={15} />
                  Vault home
                  {!selectedFolder && <Check size={14} className="ml-auto" />}
                </button>
                {visibleFolders.map((value) => (
                  <button
                    type="button"
                    key={value}
                    disabled={pending}
                    onClick={() => {
                      setFolder(value);
                      setShowFolders(false);
                    }}
                    className="focus-ring flex min-h-control w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-[var(--glass-hover)]"
                  >
                    <Folder size={15} className="shrink-0" />
                    <span className="truncate">{folderLabel(value)}</span>
                    {selectedFolder === value && (
                      <Check size={14} className="ml-auto shrink-0" />
                    )}
                  </button>
                ))}
                {!visibleFolders.length && search && (
                  <p
                    className="px-2 py-3 text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    No matching folders. Try another name or use Vault home.
                  </p>
                )}
              </div>
            </div>
          )}
          {tree.isError && (
            <p
              role="status"
              className="mt-3 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              Folders couldn’t load.{" "}
              {folder === null
                ? "New pages will use Vault home."
                : "Your chosen location is kept."}{" "}
              <button
                type="button"
                className="underline"
                disabled={pending}
                onClick={() => void tree.refetch()}
              >
                Try again
              </button>
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="mt-4 text-sm"
              style={{ color: "var(--text-secondary)" }}
            >
              {error}
            </p>
          )}
        </div>
        <footer
          className="flex items-center justify-between gap-3 border-t px-6 py-4"
          style={{ borderColor: "var(--glass-border)" }}
        >
          {!isMobile && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Enter to create
            </span>
          )}
          <button
            type="submit"
            disabled={
              pending || tree.isPending || (tree.isFetching && folder === null)
            }
            className="focus-ring flex min-h-control shrink-0 items-center gap-2 rounded-lg px-4 text-sm font-medium disabled:opacity-50"
            style={{
              background: "var(--action-bg)",
              color: "var(--action-fg)",
              ...(isMobile ? { width: "100%", justifyContent: "center" } : {}),
            }}
          >
            {pending
              ? "Creating…"
              : type === "document"
                ? "Create page"
                : "Create"}
            <ArrowRight size={16} />
          </button>
        </footer>
      </form>
    </dialog>
  );
}
