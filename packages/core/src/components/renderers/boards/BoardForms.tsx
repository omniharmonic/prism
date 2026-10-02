import {
  useEffect,
  useRef,
  useState,
  useId,
  cloneElement,
  isValidElement,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { BoardFilters } from "./BoardFilters";
import { propertyFilters, readFilterDraft } from "../../../lib/boards/filters";
import { readBoardConfig, type BoardConfig } from "../../../lib/boards/config";
const control =
  "min-h-11 w-full rounded-lg border border-[var(--glass-border)] bg-[var(--bg-surface)] px-3 text-sm";

function Dialog({
  title,
  busy,
  error,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  error?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const element = ref.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto max-h-[90dvh] w-[min(560px,calc(100vw-24px))] overflow-auto rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-elevated)] p-5 text-[var(--text-primary)] backdrop:bg-black/40"
    >
      <header className="mb-5 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button
          type="button"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
          className="grid h-11 w-11 place-items-center rounded-lg hover:bg-[var(--glass-hover)]"
        >
          <X size={18} />
        </button>
      </header>
      {error && (
        <p role="alert" className="mb-3 text-sm text-[var(--color-error)]">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="block min-w-0 text-sm">
      <label htmlFor={id} className="mb-1.5 block text-[var(--text-secondary)]">
        {label}
      </label>
      {isValidElement<{ id?: string }>(children)
        ? cloneElement(children, { id })
        : children}
    </div>
  );
}

export function BoardSettings({
  config,
  busy,
  error,
  onClose,
  onSave,
}: {
  config: BoardConfig;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSave: (config: BoardConfig) => Promise<void>;
}) {
  const [tags, setTags] = useState((config.source.tags ?? []).join(", "));
  const [prefix, setPrefix] = useState(config.source.pathPrefix ?? "");
  const [group, setGroup] = useState(config.groupBy);
  const [columns, setColumns] = useState(
    config.columns.map((c) => c.id + ": " + c.label).join("\n"),
  );
  const [fields, setFields] = useState(config.cardFields.join(", "));
  const [sort, setSort] = useState(config.sort.field);
  const [direction, setDirection] = useState(config.sort.direction);
  const [view, setView] = useState(config.view);
  const [validation, setValidation] = useState("");
  const [filters, setFilters] = useState(() => readFilterDraft(config.source));
  const [dateEditing, setDateEditing] = useState(false);
  const csv = (s: string) => [
    ...new Set(
      s
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
  const submit = async () => {
    setValidation("");
    let metadataFilters;
    try {
      metadataFilters = propertyFilters(filters);
    } catch (e) {
      setValidation((e as Error).message);
      return;
    }
    if (dateEditing) {
      setValidation("Add or cancel the date filter before saving.");
      return;
    }
    const next: BoardConfig = {
      ...config,
      source: {
        ...config.source,
        tags: csv(tags),
        pathPrefix: prefix.trim(),
        metadataFilters,
        dateRange: filters.date,
      },
      groupBy: group.trim(),
      columns: columns
        .split("\n")
        .filter((s) => s.trim())
        .map((line) => {
          const i = line.indexOf(":");
          return {
            id: (i < 0 ? line : line.slice(0, i)).trim(),
            label: (i < 0 ? line : line.slice(i + 1)).trim(),
          };
        }),
      cardFields: csv(fields),
      sort: { field: sort.trim(), direction },
      view,
    };
    try {
      readBoardConfig({ metadata: { prism_board: next } });
    } catch {
      setValidation(
        "Use unique nonempty columns (up to 24) and ordinary property names. Protected system properties cannot group a board.",
      );
      return;
    }
    await onSave(next);
  };
  return (
    <Dialog title="View settings" busy={busy} error={error} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            This view uses existing notes. Changing its columns does not change
            their saved properties.
          </p>
          <Field label="Source tags">
            <input
              className={control}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="task, project-name"
            />
          </Field>
          <Field label="Source folder">
            <input
              className={control}
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="All folders"
            />
          </Field>
          <BoardFilters
            value={filters}
            onChange={(next) => {
              setFilters(next);
              setValidation("");
            }}
            onDateEditing={setDateEditing}
          />
          <Field label="Group by property">
            <input
              className={control}
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            />
          </Field>
          <Field label="Columns (value: label, one per line)">
            <textarea
              className={control + " py-2"}
              rows={5}
              value={columns}
              onChange={(e) => setColumns(e.target.value)}
            />
          </Field>
          <Field label="Card properties">
            <input
              className={control}
              value={fields}
              onChange={(e) => setFields(e.target.value)}
              placeholder="priority, deadline, project"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sort by property">
              <input
                className={control}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              />
            </Field>
            <Field label="Sort direction">
              <select
                className={control}
                value={direction}
                onChange={(e) => setDirection(e.target.value as "asc" | "desc")}
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </Field>
          </div>
          <Field label="Default view">
            <select
              className={control}
              value={view}
              onChange={(e) => setView(e.target.value as "board" | "list")}
            >
              <option value="board">Board</option>
              <option value="list">List</option>
            </select>
          </Field>
          {validation && (
            <p role="alert" className="text-sm text-[var(--color-error)]">
              {validation}
            </p>
          )}
          <button
            disabled={busy}
            className={
              control +
              " bg-[var(--color-accent)] font-medium text-white disabled:opacity-50"
            }
          >
            {busy ? "Saving…" : "Save view"}
          </button>
        </fieldset>
      </form>
    </Dialog>
  );
}
export function BoardTaskForm({
  config,
  busy,
  error,
  onClose,
  onCreate,
}: {
  config: BoardConfig;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onCreate: (title: string, priority: string, status: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [status, setStatus] = useState(config.columns[0].id);
  return (
    <Dialog title="New task" busy={busy} error={error} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void onCreate(title.trim(), priority, status);
        }}
      >
        <Field label="Task title">
          <input
            autoFocus
            maxLength={240}
            required
            className={control}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to happen?"
          />
        </Field>
        <Field label="Priority">
          <select
            className={control}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            {["low", "medium", "high", "critical"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label={config.groupBy}>
          <select
            className={control}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {config.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <button
          disabled={busy || !title.trim()}
          className={
            control +
            " bg-[var(--color-accent)] font-medium text-white disabled:opacity-50"
          }
        >
          {busy ? "Creating…" : "Create task"}
        </button>
      </form>
    </Dialog>
  );
}
