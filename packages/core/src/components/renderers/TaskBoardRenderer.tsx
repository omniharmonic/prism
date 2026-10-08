import { TEMPLATE_TAG, isTemplateNote } from "../../lib/pages/model";
import "./boards/BoardWorkspace.css";
import { dueSummary } from "../../lib/database/dates";
import "../database/database.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  GripVertical,
  Plus,
  Settings2,
  LayoutGrid,
  List,
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Database,
  MoreHorizontal,
} from "lucide-react";
import { Popover } from "../database/Popover";
import type { RendererProps } from "./RendererProps";
import type { Note } from "../../lib/types";
import { useVaultClient } from "../../data/VaultClientContext";
import { useAgentChatStore } from "../../lib/agent/chatStore";
import { useIsMobile } from "../../app/hooks/useIsMobile";
import { useUIStore } from "../../app/stores/ui";
import { noteCaps } from "../../lib/governance/review";
import { inferContentType } from "../../lib/schemas/content-types";
import {
  boardStatus,
  boardTasks,
  boardTitle,
  readBoardConfig,
  reorderBoardTasks,
  safeBoardField,
  type BoardConfig,
} from "../../lib/boards/config";
import { BoardSettings, BoardTaskForm } from "./boards/BoardForms";

export const boardControl =
  "board-control focus-ring min-h-control rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] px-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--glass-hover)] disabled:opacity-50";

// Prefer the card under the pointer to its containing column. Exclude the
// dragged card itself so overlapping its original slot cannot capture the drop.
const boardCollision: CollisionDetection = (args) => {
  const candidates = {
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => container.id !== "task:" + args.active.id,
    ),
  };
  const pointer = pointerWithin(candidates);
  const hits = pointer.length ? pointer : rectIntersection(candidates);
  const cards = hits.filter((hit) => String(hit.id).startsWith("task:"));
  return cards.length ? cards : hits;
};

export default function TaskBoardRenderer(props: RendererProps) {
  const client = useVaultClient();
  const audience = useAgentChatStore((s) => s.scope);
  const scope = client.scope?.() ?? audience;
  return (
    <Board
      key={JSON.stringify([scope, props.note.id])}
      {...props}
      scope={scope}
    />
  );
}

function Board({
  note,
  readOnly = false,
  scope,
}: RendererProps & { scope: string | null }) {
  const client = useVaultClient();
  const queries = useQueryClient();
  const openTab = useUIStore((s) => s.openTab);
  const canEdit = (n: Note) => !readOnly && (noteCaps(n)?.has("edit") ?? true);
  const canCreate = !readOnly && (noteCaps(note)?.has("create") ?? true);
  const current = () =>
    (client.scope?.() ?? useAgentChatStore.getState().scope) === scope;
  const [savedConfig, setSavedConfig] = useState<BoardConfig | null>(null);
  let config: BoardConfig | undefined,
    configError = "";
  try {
    config = savedConfig ?? readBoardConfig(note);
  } catch (e) {
    configError = (e as Error).message;
  }
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"board" | "list" | null>(null);
  const [settings, setSettings] = useState(false);
  // false = closed; null = the header's "New task"; a column id = that column's "+ Add task".
  const [creating, setCreating] = useState<string | null | false>(false);
  const [busy, setBusy] = useState<string | null>(null);
  const writeLock = useRef(false);
  const refreshLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const source = config?.source;
  const tasks = useQuery({
    queryKey: ["vault", "board", scope, note.id, source],
    enabled: !!config,
    queryFn: async () => {
      if (!current()) throw new Error("Workspace changed");
      const result = await client.listNotes({
        tag: source?.tags?.[0],
        // Vault `path` is exact, not a directory prefix. Apply the shared
        // dashboard prefix filter to this bounded inventory below.
        limit: 2000,
      });
      if (!current()) throw new Error("Workspace changed");
      // A page TEMPLATE is a blueprint, never a card (a template of a task is not a task).
      return source?.tags?.[0] === TEMPLATE_TAG ? result : result.filter((n) => !isTemplateNote(n));
    },
    retry: false,
  });
  // Fresh authorization is required before cached rows are displayed again.
  const notes =
    !refreshing && !tasks.isFetching && !tasks.isError && config
      ? boardTasks(tasks.data ?? [], config, query)
      : [];
  const isMobile = useIsMobile();
  const mode = view ?? (isMobile ? "list" : config?.view ?? "board");
  const refresh = () => queries.invalidateQueries({ queryKey: ["vault"] });
  const recover = async () => {
    if (!current() || writeLock.current || refreshLock.current) return;
    // Query notifications are batched. Hide old rows synchronously with the
    // user's refresh action so a quick retry cannot use the previous revision.
    refreshLock.current = true;
    setRefreshing(true);
    setNotice("");
    try {
      const result = await tasks.refetch();
      if (result.error) throw result.error;
      if (current()) {
        setError("");
        setNotice("Tasks refreshed.");
      }
    } catch {
      if (current()) setError("Tasks could not be refreshed. Try again.");
    } finally {
      refreshLock.current = false;
      if (current()) setRefreshing(false);
    }
  };
  const receipt = async (confirmed: string) => {
    const pending = await client.hasPendingWrites?.();
    if (current())
      setNotice(
        pending
          ? "Saved on this device; waiting for sync. Use the saved-changes indicator below to review it."
          : confirmed,
      );
    return !!pending;
  };
  const run = async (id: string, fn: () => Promise<void>) => {
    if (readOnly || !current() || writeLock.current || refreshLock.current)
      return;
    writeLock.current = true;
    setBusy(id);
    setError("");
    setNotice("");
    try {
      if (await client.hasPendingWrites?.())
        throw new Error(
          "An earlier change is waiting for sync or review. Resolve it using the saved-changes indicator below before trying again.",
        );
      if (!current()) return;
      await fn();
    } catch (e) {
      if (current())
        setError(
          (e as Error).message ||
            "The change could not be saved. Refresh and try again.",
        );
    } finally {
      writeLock.current = false;
      if (current()) setBusy(null);
    }
  };
  const move = async (task: Note, target: string) => {
    if (
      !canEdit(task) ||
      !config ||
      !config.columns.some((c) => c.id === target) ||
      task.metadata?.[config.groupBy] === target
    )
      return;
    await run(task.id, async () => {
      if (!task.updatedAt)
        throw new Error("Refresh this board before moving the task.");
      // Merge one property, guarded by the revision actually shown to the user.
      // Never copy stale unrelated metadata or force a conflicting move.
      await client.updateNote(
        task.id,
        {
          metadata: { [config.groupBy]: target },
          ifUpdatedAt: task.updatedAt,
        },
        { expectedScope: scope ?? undefined },
      );
      if (!current()) return;
      await receipt("Task moved.");
      await refresh();
    });
  };
  const open = async (task: Note) => {
    setError("");
    try {
      const fresh = await client.getNote(task.id, { fresh: true });
      if (current())
        openTab(fresh.id, boardTitle(fresh), inferContentType(fresh));
    } catch {
      if (current())
        setError(
          "This task is no longer available. Refresh to check your access.",
        );
    }
  };
  const save = async (next: BoardConfig, reordering = false) =>
    run(reordering ? "order" : "settings", async () => {
      if (!canEdit(note)) return;
      const fresh = await client.getNote(note.id, { fresh: true });
      if (!current()) return;
      if (JSON.stringify(readBoardConfig(fresh)) !== JSON.stringify(config))
        throw new Error(
          "Board settings changed in another window. Reopen the board before saving.",
        );
      if (!fresh.updatedAt)
        throw new Error("Refresh this board before saving settings.");
      await client.updateNote(
        note.id,
        {
          metadata: { prism_board: next },
          ifUpdatedAt: fresh.updatedAt,
        },
        { expectedScope: scope ?? undefined },
      );
      if (!current()) return;
      setSavedConfig(next);
      if (!reordering) {
        setView(null);
        setSettings(false);
      }
      await receipt(reordering ? "Task order saved." : "View saved.");
      await refresh();
    });
  const reorder = async (
    task: Note,
    neighbor: Note,
    direction: "earlier" | "later",
  ) => {
    if (!config?.order || !canEdit(note) || !current()) return;
    const order = reorderBoardTasks(
      config,
      tasks.data ?? [],
      task.id,
      neighbor.id,
      direction,
    );
    if (
      !order ||
      (order.every((id, i) => id === config.order![i]) &&
        order.length === config.order.length)
    )
      return;
    if (order.length > 10000) {
      setError(
        "This view has reached its manual-order limit. Use property sorting or narrow the source.",
      );
      return;
    }
    await save({ ...config, order }, true);
  };
  const create = async (title: string, priority: string, status: string) =>
    run("create", async () => {
      if (!config || !canCreate) return;
      // New tasks inherit the board's explicit visibility and ordinary source tags.
      const metadata: Record<string, unknown> = {
        type: "task",
        prism_type: "task",
        title,
        priority,
        [config.groupBy]: status,
      };
      if (note.metadata?.prism_visibility === "private")
        metadata.prism_visibility = "private";
      for (const [key, value] of Object.entries(
        config.source.metadataFilters ?? {},
      )) {
        // Only a single exact text choice (or legacy scalar) gives a safe
        // default. Explicit form choices always win; compound rules stay filters.
        const choices =
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value).length === 1
            ? (value as Record<string, unknown>).$in
            : undefined;
        const candidate =
          Array.isArray(choices) &&
          choices.length === 1 &&
          typeof choices[0] === "string"
            ? choices[0]
            : value;
        if (
          safeBoardField(key) &&
          !["id", "path", "content", "createdAt", "updatedAt"].includes(key) &&
          !Object.prototype.hasOwnProperty.call(metadata, key) &&
          ["string", "number", "boolean"].includes(typeof candidate)
        )
          metadata[key] = candidate;
      }
      // Prefix-scoped boards need a path for the new task to remain in the view.
      const path = config.source.pathPrefix
        ? config.source.pathPrefix.replace(/\/$/, "") +
          "/" +
          title.replace(/[\/\\]/g, "-") +
          " " +
          crypto.randomUUID().slice(0, 8)
        : undefined;
      const created = await client.createNote({
        content:
          "<p>" +
          title
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;") +
          "</p>",
        path,
        tags: [...new Set(["task", ...(config.source.tags ?? [])])],
        metadata,
      });
      if (!current()) return;
      setCreating(false);
      const pending = await receipt("Task created.");
      await refresh();
      if (current() && !pending && !boardTasks([created], config, "").length)
        setNotice("Task created. Your view's filters exclude it.");
    });
  /**
   * Supersede this board with a database over the same tag(s): a NEW database
   * note (board view grouped the same way + a table), never a rewrite of the
   * tasks or of this board — so nothing is lost and this board keeps working.
   */
  const openAsDatabase = async () =>
    run("database", async () => {
      if (!config) return;
      const tags = (config.source.tags ?? ["task"]).slice(0, 5);
      const views = [
        { id: "board", name: "Board", type: "board", groupBy: safeBoardField(config.groupBy) ? config.groupBy : "status", ...(config.order?.length ? { order: config.order.slice(0, 10000) } : {}) },
        { id: "table", name: "All tasks", type: "table" },
      ];
      const created = await client.createNote({
        content: "",
        path: `${(note.path ?? "Tasks").replace(/\.[^./]+$/, "")} database`,
        tags: [],
        metadata: { title: `${boardTitle(note)} (database)`, prism_type: "database", prism_database: { version: 1, source: { tags: tags.length ? tags : ["task"] }, views } },
      });
      if (!current()) return;
      openTab(created.id, `${boardTitle(note)} (database)`, "database");
      const narrowed = !!(config.source.pathPrefix || Object.keys(config.source.metadataFilters ?? {}).length || config.source.dateRange);
      setNotice(narrowed ? "Database created. It shows every page with these tags; this board's folder and property filters are not carried over." : "Database created.");
    });
  const dragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const task = notes.find((n) => n.id === event.active.id);
    if (!task || !config || !event.over) return;
    const column = event.over.data.current?.column;
    if (column !== null && typeof column !== "string") return;
    if (column !== boardStatus(task, config)) {
      // A group change is one task-property CAS, just like the Move menu.
      // Preserve its view rank; two independent notes cannot be saved atomically.
      if (typeof column === "string") void move(task, column);
      return;
    }
    if (!config.order || !canEdit(note)) return;
    const targetId = event.over.data.current?.taskId;
    const target = notes.find((n) => n.id === targetId);
    if (target && target.id !== task.id) {
      const pointerY =
        "clientY" in event.activatorEvent
          ? Number(event.activatorEvent.clientY) + event.delta.y
          : (event.active.rect.current.translated?.top ?? 0) +
            (event.active.rect.current.translated?.height ?? 0) / 2;
      const direction =
        pointerY < event.over.rect.top + event.over.rect.height / 2
          ? "earlier"
          : "later";
      void reorder(task, target, direction);
    } else if (!targetId) {
      const last = notes
        .filter((n) => n.id !== task.id && boardStatus(n, config) === column)
        .at(-1);
      if (last) void reorder(task, last, "later");
    }
  };
  if (!config)
    return (
      <div role="alert" className="p-6 text-sm">
        {configError}
      </div>
    );
  const groups = [
    ...config.columns.map((c) => ({
      ...c,
      tasks: notes.filter((n) => boardStatus(n, config) === c.id),
    })),
    {
      id: null,
      label: "Ungrouped",
      tasks: notes.filter((n) => boardStatus(n, config) === null),
    },
  ];
  const active = notes.find((n) => n.id === activeId);
  return (
    <section
      aria-label="Task board"
      className="board-workspace flex h-full min-h-0 min-w-0 overflow-hidden flex-col bg-[var(--bg-base)] text-[var(--text-primary)]"
    >
      <header className="board-header flex flex-wrap items-center justify-between gap-3 border-b border-[var(--glass-border)] px-5 py-4">
        <div>
          <p className="text-xs text-[var(--text-secondary)]">
            {note.path?.split("/").slice(0, -1).filter((part, index) => index !== 0 || part !== "vault").join(" / ") || "Tasks"}
          </p>
          <h1 className="board-title mt-1 font-semibold">{boardTitle(note)}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {canCreate && (
            <button className={boardControl} title="Open these tasks in a database (table, board, calendar…) — nothing is moved or rewritten" onClick={() => void openAsDatabase()}>
              <Database size={15} className="mr-2 inline" />
              Open as database
            </button>
          )}
          {canEdit(note) && (
            <button className={boardControl} onClick={() => setSettings(true)}>
              <Settings2 size={15} className="mr-2 inline" />
              View settings
            </button>
          )}
          {canCreate && (
            <button className={boardControl + " board-primary"} onClick={() => setCreating(null)}>
              <Plus size={16} className="mr-1 inline" />
              New task
            </button>
          )}
        </div>
      </header>
      <div className="board-viewbar flex flex-wrap items-center gap-3 px-5 py-3">
        <div role="group" aria-label="Task view" className="flex gap-1">
          {(["board", "list"] as const).map((v) => (
            <button
              key={v}
              aria-pressed={mode === v}
              className={boardControl}
              style={{
                background: mode === v ? "var(--glass-active)" : undefined,
              }}
              onClick={() => setView(v)}
            >
              {v === "board" ? (
                <LayoutGrid size={14} className="mr-2 inline" />
              ) : (
                <List size={14} className="mr-2 inline" />
              )}
              {v === "board" ? "Board" : "List"}
            </button>
          ))}
        </div>
        <input
          aria-label="Filter tasks"
          placeholder="Filter tasks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={boardControl + " board-filter min-w-0"}
        />
        <span className="text-xs text-[var(--text-secondary)]">
          {notes.length} tasks · grouped by {config.groupBy}
        </span>
      </div>
      <div
        aria-label="Active view filters"
        className="flex flex-wrap gap-2 px-5 pb-3 text-xs text-[var(--text-secondary)]"
      >
        {(config.source.tags ?? []).map((tag) => (
          <span
            key={tag}
            className="max-w-full break-words rounded-md bg-[var(--glass)] px-2 py-1"
          >
            #{tag}
          </span>
        ))}
        {config.source.pathPrefix && (
          <span className="max-w-full break-all rounded-md bg-[var(--glass)] px-2 py-1">
            {config.source.pathPrefix}
          </span>
        )}
        {Object.keys(config.source.metadataFilters ?? {}).map((field) => (
          <span
            key={field}
            className="max-w-full break-words rounded-md bg-[var(--glass)] px-2 py-1"
          >
            {field} filter
          </span>
        ))}
        {config.source.dateRange && (
          <span className="max-w-full break-words rounded-md bg-[var(--glass)] px-2 py-1">
            {config.source.dateRange.field} date filter
          </span>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="mx-5 mb-3 rounded-lg border border-[var(--color-error)] p-3 text-sm"
        >
          {error}
          <button
            className={boardControl + " ml-3"}
            disabled={refreshing || !!busy}
            onClick={() => void recover()}
          >
            Refresh
          </button>
        </div>
      )}
      <p role="status" className="px-5 text-xs text-[var(--text-secondary)]">
        {busy ? "Saving…" : notice}
      </p>
      {refreshing || tasks.isFetching ? (
        <p className="p-6 text-sm">Loading tasks…</p>
      ) : tasks.isError ? (
        <div role="alert" className="p-6">
          Tasks could not be loaded.{" "}
          <button className={boardControl} onClick={() => void recover()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {(tasks.data?.length ?? 0) >= 2000 && (
            <p className="px-5 py-2 text-xs">
              Showing a limited set of tasks. Narrow the source in View
              settings.
            </p>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={boardCollision}
            onDragStart={(e) => setActiveId(String(e.active.id))}
            onDragCancel={() => setActiveId(null)}
            onDragEnd={dragEnd}
          >
            <ScrollArea board={mode === "board"}>
              {mode === "list" && !notes.length && (
                <div className="rounded-xl border border-dashed border-[var(--glass-border)] px-5 py-10 text-center text-sm text-[var(--text-secondary)]">
                  No tasks match this view. Adjust the search or view filters to
                  include more tasks.
                </div>
              )}
              {groups
                .filter((g) =>
                  mode === "list"
                    ? g.tasks.length > 0
                    : g.id !== null || g.tasks.length > 0,
                )
                .map((group) => (
                  <Column
                    key={group.id ?? "ungrouped"}
                    group={group}
                    list={mode === "list"}
                    disabled={readOnly || !!busy}
                    onAdd={canCreate && group.id !== null ? () => setCreating(group.id) : undefined}
                  >
                    {group.tasks.map((task, index) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        config={config}
                        readOnly={!canEdit(task)}
                        disabled={!!busy}
                        ordering={!!config.order && canEdit(note)}
                        onEarlier={
                          index > 0
                            ? () =>
                                void reorder(
                                  task,
                                  group.tasks[index - 1]!,
                                  "earlier",
                                )
                            : undefined
                        }
                        onLater={
                          index < group.tasks.length - 1
                            ? () =>
                                void reorder(
                                  task,
                                  group.tasks[index + 1]!,
                                  "later",
                                )
                            : undefined
                        }
                        onOpen={() => void open(task)}
                        onMove={(target) => void move(task, target)}
                      />
                    ))}
                  </Column>
                ))}
            </ScrollArea>
            {/* pointer-events: none — while the drop animation plays the overlay sits
                over the cards, and a quick second grab would land on it instead of
                the card (boards.spec.ts:868 flaked on exactly that). */}
            <DragOverlay style={{ pointerEvents: "none" }}>
              {active && (
                <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--bg-elevated)] p-4 shadow-xl">
                  {boardTitle(active)}
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </>
      )}
      {settings && (
        <BoardSettings
          config={config}
          busy={!!busy}
          error={error}
          onClose={() => setSettings(false)}
          onSave={save}
        />
      )}
      {creating !== false && (
        <BoardTaskForm
          config={config}
          busy={!!busy}
          error={error}
          initialStatus={creating ?? undefined}
          onClose={() => setCreating(false)}
          onCreate={create}
        />
      )}
    </section>
  );
}

/**
 * The columns' scroller. On a board wider than the screen it shows edge fades
 * and ‹ › buttons, so a column past the edge ("Ungrouped" at 1440 px with five
 * columns) is never silently cut off (gap analysis §20).
 */
function ScrollArea({ board, children }: { board: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el || !board) return;
    const update = () => setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    for (const c of Array.from(el.children)) ro?.observe(c);
    return () => { el.removeEventListener("scroll", update); ro?.disconnect(); };
  }, [board]);
  const by = (dir: -1 | 1) => ref.current?.scrollBy({ left: dir * Math.max(240, (ref.current.clientWidth ?? 600) * 0.8), behavior: "smooth" });
  if (!board) return <div className="board-list min-h-0 flex-1 overflow-auto p-5">{children}</div>;
  return (
    <div className="board-scroll relative flex min-h-0 flex-1 flex-col" data-overflow-left={edges.left || undefined} data-overflow-right={edges.right || undefined}>
      <div ref={ref} className="board-columns flex min-h-0 flex-1 gap-4 overflow-auto p-5" role="region" aria-label="Board columns" tabIndex={0}>
        {children}
      </div>
      {edges.left && <button type="button" className="board-scroll-btn board-scroll-left focus-ring" aria-label="Scroll columns left" onClick={() => by(-1)}><ChevronLeft size={18} /></button>}
      {edges.right && <button type="button" className="board-scroll-btn board-scroll-right focus-ring" aria-label="Scroll columns right" onClick={() => by(1)}><ChevronRight size={18} /></button>}
    </div>
  );
}

function Column({
  group,
  list,
  disabled,
  children,
  onAdd,
}: {
  group: { id: string | null; label: string; tasks: Note[] };
  list: boolean;
  disabled: boolean;
  children: React.ReactNode;
  /** Per-column "+ Add task" (created in this column). */
  onAdd?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: "column:" + (group.id ?? "ungrouped"),
    data: { column: group.id },
    disabled: disabled || group.id === null,
  });
  return (
    <section
      ref={setNodeRef}
      aria-label={group.label}
      className={
        list ? "board-group board-list-group mb-6" : "board-group flex w-[min(280px,calc(100vw-56px))] shrink-0 flex-col"
      }
    >
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <span className="h-2 w-2 rounded-full bg-[var(--text-muted)]" />
        {group.label}
        <span className="text-xs font-normal text-[var(--text-secondary)]">
          {group.tasks.length}
        </span>
      </h2>
      {onAdd && (
        <button type="button" className="board-col-add focus-ring" aria-label={"Add task to " + group.label} disabled={disabled} onClick={onAdd}>
          <Plus size={14} aria-hidden="true" /> Add task
        </button>
      )}
      <div
        className="board-column-body min-h-24 space-y-2 rounded-xl p-1"
        style={{ background: isOver ? "var(--glass-active)" : "transparent" }}
      >
        {children}
        {!group.tasks.length && (
          <p className="px-3 py-6 text-xs text-[var(--text-secondary)]">
            No tasks
          </p>
        )}
      </div>
    </section>
  );
}
function TaskCard({
  task,
  config,
  readOnly,
  disabled,
  onOpen,
  onMove,
  ordering,
  onEarlier,
  onLater,
}: {
  task: Note;
  config: BoardConfig;
  readOnly: boolean;
  disabled: boolean;
  ordering: boolean;
  onEarlier?: () => void;
  onLater?: () => void;
  onOpen: () => void;
  onMove: (value: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: task.id,
    disabled: (!ordering && readOnly) || disabled,
  });
  const status = boardStatus(task, config);
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: "task:" + task.id,
    data: { column: status, taskId: task.id },
    disabled: !ordering || disabled,
  });
  const raw = task.metadata?.[config.groupBy];
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const due = dueInfo(task);
  const closeMenu = () => { setMenu(false); setMoveOpen(false); };
  return (
    <article
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      aria-label={boardTitle(task)}
      className="board-card relative rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] p-3"
      style={{
        opacity: isDragging ? 0.4 : 1,
        outline: isOver ? "2px solid var(--accent)" : undefined,
        outlineOffset: isOver ? 2 : undefined,
      }}
    >
      <div className="flex items-start gap-1">
        <button
          onClick={onOpen}
          className="board-card-title focus-ring min-h-control min-w-0 flex-1 break-words text-left text-sm font-medium"
        >
          {boardTitle(task)}
          <ArrowUpRight
            size={13}
            className="ml-1 inline text-[var(--text-secondary)]"
          />
        </button>
        <button
          ref={menuAnchor}
          type="button"
          aria-label={"Actions for " + boardTitle(task)}
          aria-haspopup="menu"
          aria-expanded={menu}
          className="board-card-menu focus-ring min-h-control w-8 shrink-0 text-[var(--text-secondary)]"
          onClick={() => setMenu((o) => !o)}
        >
          <MoreHorizontal size={16} />
        </button>
        <Popover anchor={menuAnchor} open={menu} onClose={closeMenu} label={"Actions for " + boardTitle(task)} width={220}>
          <div className="db-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { closeMenu(); onOpen(); }}><ArrowUpRight size={14} aria-hidden="true" /> Open</button>
            {!readOnly && <button type="button" role="menuitem" aria-expanded={moveOpen} disabled={disabled} onClick={() => setMoveOpen((o) => !o)}><ChevronRight size={14} aria-hidden="true" /> Move to…</button>}
            {!readOnly && moveOpen && config.columns.filter((c) => c.id !== status).map((c) => (
              <button key={c.id} type="button" role="menuitem" style={{ paddingLeft: 28 }} onClick={() => { closeMenu(); onMove(c.id); }}>{c.label}</button>
            ))}
            {ordering && <>
              <hr />
              <button type="button" role="menuitem" disabled={disabled || !onEarlier} onClick={() => { closeMenu(); onEarlier?.(); }}><ArrowUp size={14} aria-hidden="true" /> Move up</button>
              <button type="button" role="menuitem" disabled={disabled || !onLater} onClick={() => { closeMenu(); onLater?.(); }}><ArrowDown size={14} aria-hidden="true" /> Move down</button>
            </>}
          </div>
        </Popover>
        {(!readOnly || ordering) && (
          <button
            {...attributes}
            {...listeners}
            disabled={disabled}
            aria-label={"Drag " + boardTitle(task)}
            className="board-card-drag focus-ring min-h-control w-8 shrink-0 touch-none cursor-grab text-[var(--text-secondary)]"
          >
            <GripVertical size={16} />
          </button>
        )}
      </div>
      {/* w16: no per-card status select or Earlier / Later buttons — the column says the status,
          and dragging or the ⋯ menu ("Move to…", "Move up / down") changes it, keyboard included. */}
      <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
        {due && (
          <div data-board-field="due" className="board-due" data-due={due.state}>
            <dt className="sr-only">Due</dt>
            <dd><CalendarDays size={12} aria-hidden="true" className="mr-1 inline" />{due.label}</dd>
          </div>
        )}
        {config.cardFields.filter((field) => !(due && (field === "deadline" || field === "due"))).map((field) => {
          const value =
            task.metadata?.[field] ??
            (field === "deadline" ? task.metadata?.due : undefined);
          return value == null ? null : (
            <div key={field} data-board-field={field} data-priority={field === "priority" && typeof value === "string" ? value.toLowerCase() : undefined} className="min-w-0 max-w-full break-words">
              <dt className="sr-only">{field}</dt>
              <dd>
                {typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value)}
              </dd>
            </div>
          );
        })}
        {/* A status no column shows (the Ungrouped column) is the one place the value itself is news. */}
        {status === null && typeof raw === "string" && raw.trim() && (
          <div data-board-field={config.groupBy} className="min-w-0 max-w-full break-words">
            <dt className="sr-only">{config.groupBy}</dt>
            <dd>{raw}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

/** The card's due-date chip: `due` (or `deadline`), with overdue / today / soon states. */
function dueInfo(task: Note): { label: string; state: "overdue" | "today" | "soon" | "later" } | null {
  const done = /^(done|complete|completed|closed)$/i.test(String(task.metadata?.status ?? ""));
  return dueSummary(task.metadata?.due ?? task.metadata?.deadline, done);
}
