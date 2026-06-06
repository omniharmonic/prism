import { CheckSquare, Circle, CheckCircle2 } from "lucide-react";
import { useNotes } from "../../../app/hooks/useParachute";
import { useUIStore } from "../../../app/stores/ui";
import { Badge } from "../../ui/Badge";
import type { Note } from "../../../lib/types";

interface TaskListWidgetProps {
  filter?: Record<string, unknown>;
}

function getStatus(note: Note): string {
  return (note.metadata as Record<string, unknown>)?.status as string || "todo";
}

function getProject(note: Note): string | null {
  return (note.metadata as Record<string, unknown>)?.project as string || null;
}

export function TaskListWidget({ filter }: TaskListWidgetProps) {
  const { data: allTasks, isLoading } = useNotes({ tag: "task" });
  const openTab = useUIStore((s) => s.openTab);

  const filterStatus = filter?.status as string | undefined;
  const filterProject = filter?.project as string | undefined;

  const tasks = (allTasks || []).filter((t) => {
    if (filterStatus && getStatus(t) !== filterStatus) return false;
    if (filterProject && getProject(t) !== filterProject) return false;
    return true;
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-8 rounded animate-pulse" style={{ background: "var(--glass)" }} />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="text-sm py-2" style={{ color: "var(--text-muted)" }}>
        No tasks found
      </div>
    );
  }

  return (
    <div className="space-y-0.5 max-h-64 overflow-auto">
      {tasks.slice(0, 15).map((task) => {
        const status = getStatus(task);
        const title = task.path?.split("/").pop() || task.content?.split("\n")[0]?.slice(0, 60) || "Untitled";
        const isDone = status === "done";

        return (
          <button
            key={task.id}
            onClick={() => openTab(task.id, title, "task")}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-[var(--glass-hover)] transition-colors"
          >
            {isDone ? (
              <CheckCircle2 size={14} style={{ color: "var(--color-success)" }} />
            ) : status === "in-progress" ? (
              <CheckSquare size={14} style={{ color: "var(--color-accent)" }} />
            ) : (
              <Circle size={14} style={{ color: "var(--text-muted)" }} />
            )}
            <span
              className="flex-1 truncate"
              style={{
                color: isDone ? "var(--text-muted)" : "var(--text-primary)",
                textDecoration: isDone ? "line-through" : undefined,
              }}
            >
              {title}
            </span>
            <Badge variant={status === "in-progress" ? "info" : status === "done" ? "success" : "default"}>
              {status}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
