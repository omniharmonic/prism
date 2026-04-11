import { useState, useCallback, useMemo } from "react";
import { Plus } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RendererProps } from "./RendererProps";
import { useNotes, useUpdateNote, useCreateNote } from "../../app/hooks/useParachute";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import type { Note } from "../../lib/types";

const COLUMNS = [
  { id: "todo", label: "To Do", color: "var(--text-secondary)" },
  { id: "in-progress", label: "In Progress", color: "var(--color-accent)" },
  { id: "blocked", label: "Blocked", color: "var(--color-warning)" },
  { id: "done", label: "Done", color: "var(--color-success)" },
];

function getTaskStatus(note: Note): string {
  const meta = note.metadata as Record<string, unknown> | null;
  return (meta?.status as string) || "todo";
}

function getTaskPriority(note: Note): string {
  const meta = note.metadata as Record<string, unknown> | null;
  return (meta?.priority as string) || "medium";
}

function getTaskDeadline(note: Note): string | null {
  const meta = note.metadata as Record<string, unknown> | null;
  return (meta?.deadline as string) || (meta?.due as string) || null;
}

function getTaskProject(note: Note): string | null {
  const meta = note.metadata as Record<string, unknown> | null;
  return (meta?.project as string) || null;
}

export default function TaskBoardRenderer({ note: _contextNote }: RendererProps) {
  const { data: allNotes } = useNotes({ tag: "task" });
  const updateNote = useUpdateNote();
  const createNote = useCreateNote();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // Group tasks by status column
  const tasksByColumn = useMemo(() => {
    const tasks = allNotes || [];
    const grouped: Record<string, Note[]> = {};
    for (const col of COLUMNS) grouped[col.id] = [];

    for (const task of tasks) {
      const status = getTaskStatus(task);
      if (grouped[status]) {
        grouped[status].push(task);
      } else {
        grouped["todo"].push(task); // Unknown statuses go to To Do
      }
    }
    return grouped;
  }, [allNotes]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    const targetColumn = (over.data.current as { column?: string })?.column || (over.id as string);

    if (COLUMNS.some((c) => c.id === targetColumn)) {
      // Update the task's status
      const task = (allNotes || []).find((n) => n.id === taskId);
      if (task) {
        const meta = { ...(task.metadata as Record<string, unknown> || {}), status: targetColumn };
        updateNote.mutate({ id: taskId, metadata: meta });
      }
    }
  }, [allNotes, updateNote]);

  const handleCreateTask = useCallback(async (description: string, priority: string) => {
    await createNote.mutateAsync({
      content: description,
      tags: ["task"],
      metadata: { type: "task", status: "todo", priority, prism_type: "task" },
    });
    setShowCreate(false);
  }, [createNote]);

  const activeTask = activeId ? (allNotes || []).find((n) => n.id === activeId) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--glass-border)", background: "var(--bg-surface)" }}
      >
        <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          Task Board
        </span>
        <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
          New Task
        </Button>
      </div>

      {/* Kanban board */}
      <div className="flex-1 flex gap-3 p-4 overflow-x-auto min-h-0">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col.id}
              id={col.id}
              label={col.label}
              color={col.color}
              tasks={tasksByColumn[col.id] || []}
            />
          ))}

          <DragOverlay>
            {activeTask && <TaskCard task={activeTask} isDragging />}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Create task dialog */}
      {showCreate && (
        <CreateTaskDialog onClose={() => setShowCreate(false)} onCreate={handleCreateTask} />
      )}
    </div>
  );
}

function KanbanColumn({ id, label, color, tasks }: {
  id: string; label: string; color: string; tasks: Note[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id, data: { column: id } });

  return (
    <div
      ref={setNodeRef}
      className="flex flex-col min-w-[240px] w-[280px] flex-shrink-0 rounded-lg"
      style={{
        background: isOver ? "var(--glass-hover)" : "var(--glass)",
        border: "1px solid var(--glass-border)",
      }}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--glass-border)" }}>
        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
        <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
          {label}
        </span>
        <span className="text-xs ml-auto" style={{ color: "var(--text-muted)" }}>
          {tasks.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex-1 overflow-auto p-2 space-y-2">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard key={task.id} task={task} column={id} />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

function SortableTaskCard({ task, column }: { task: Note; column: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { column },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TaskCard task={task} />
    </div>
  );
}

function TaskCard({ task, isDragging }: { task: Note; isDragging?: boolean }) {
  const priority = getTaskPriority(task);
  const deadline = getTaskDeadline(task);
  const project = getTaskProject(task);
  const title = task.path?.split("/").pop() || task.content.split("\n")[0].slice(0, 60) || "Untitled task";

  const priorityVariant = {
    critical: "error" as const,
    high: "warning" as const,
    medium: "info" as const,
    low: "default" as const,
  };

  return (
    <div
      className="rounded-lg p-2.5 cursor-grab active:cursor-grabbing"
      style={{
        background: isDragging ? "var(--glass-active)" : "var(--bg-elevated)",
        border: "1px solid var(--glass-border)",
      }}
    >
      <div className="text-sm mb-1.5 line-clamp-2" style={{ color: "var(--text-primary)" }}>
        {title}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant={priorityVariant[priority as keyof typeof priorityVariant] || "default"}>
          {priority}
        </Badge>
        {deadline && (
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {deadline}
          </span>
        )}
        {project && (
          <span className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
            {project}
          </span>
        )}
      </div>
    </div>
  );
}

function CreateTaskDialog({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (desc: string, priority: string) => void;
}) {
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="glass-elevated p-6 rounded-xl w-96 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-medium" style={{ color: "var(--text-primary)" }}>New Task</h3>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Task description..."
          className="w-full rounded-lg p-3 text-sm resize-none outline-none"
          style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          rows={3}
          autoFocus
        />
        <div>
          <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="w-full h-8 rounded-md px-2 text-sm outline-none"
            style={{ background: "var(--glass)", border: "1px solid var(--glass-border)", color: "var(--text-primary)" }}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onCreate(description, priority)} disabled={!description.trim()}>
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}
