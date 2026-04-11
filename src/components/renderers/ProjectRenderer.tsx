import { FileText, CheckSquare, MessageSquare, Calendar } from "lucide-react";
import type { RendererProps } from "./RendererProps";
import { useNotes } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { inferContentType } from "../../lib/schemas/content-types";
import type { Note } from "../../lib/types";

export default function ProjectRenderer({ note }: RendererProps) {
  const meta = note.metadata as Record<string, unknown> | null;
  const projectName = note.path?.split("/").pop() || (meta?.title as string) || "Project";
  const projectPath = note.path || "";

  // Fetch all notes and filter by project path or project tag
  const { data: allNotes } = useNotes();
  const openTab = useUIStore((s) => s.openTab);

  const projectNotes = (allNotes || []).filter((n) => {
    // Match by path prefix
    if (n.path && projectPath && n.path.startsWith(projectPath) && n.id !== note.id) return true;
    // Match by project metadata
    const m = n.metadata as Record<string, unknown> | null;
    if (m?.project === projectName) return true;
    return false;
  });

  const documents = projectNotes.filter((n) => {
    const type = inferContentType(n);
    return type === "document" || type === "note" || type === "briefing";
  });

  const tasks = projectNotes.filter((n) => {
    const type = inferContentType(n);
    return type === "task";
  });

  const tasksByStatus = {
    todo: tasks.filter((t) => (t.metadata as Record<string, unknown>)?.status === "todo"),
    inProgress: tasks.filter((t) => (t.metadata as Record<string, unknown>)?.status === "in-progress"),
    done: tasks.filter((t) => (t.metadata as Record<string, unknown>)?.status === "done"),
  };

  const handleOpenNote = (n: Note) => {
    const type = inferContentType(n);
    const title = n.path?.split("/").pop() || n.id;
    openTab(n.id, title, type);
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Project header */}
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)", fontFamily: "var(--font-sans)" }}>
            {projectName}
          </h1>
          {note.content && (
            <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
              {note.content.split("\n").find((l) => l.trim() && !l.startsWith("#")) || ""}
            </p>
          )}
        </div>

        {/* Task summary */}
        <Section icon={<CheckSquare size={16} />} title="Tasks" count={tasks.length}>
          {tasks.length === 0 ? (
            <EmptySection text="No tasks for this project" />
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="To Do" count={tasksByStatus.todo.length} color="var(--text-secondary)" />
              <StatCard label="In Progress" count={tasksByStatus.inProgress.length} color="var(--color-accent)" />
              <StatCard label="Done" count={tasksByStatus.done.length} color="var(--color-success)" />
            </div>
          )}
          {tasks.length > 0 && (
            <div className="mt-3 space-y-1">
              {tasks.slice(0, 8).map((task) => (
                <button
                  key={task.id}
                  onClick={() => handleOpenNote(task)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-left hover:bg-[var(--glass-hover)] transition-colors"
                  style={{ color: "var(--text-primary)" }}
                >
                  <CheckSquare size={13} style={{ color: "var(--text-muted)" }} />
                  <span className="truncate">{task.path?.split("/").pop() || task.content.slice(0, 50)}</span>
                  <span className="text-xs ml-auto" style={{ color: "var(--text-muted)" }}>
                    {(task.metadata as Record<string, unknown>)?.status as string || ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* Documents */}
        <Section icon={<FileText size={16} />} title="Documents" count={documents.length}>
          {documents.length === 0 ? (
            <EmptySection text="No documents in this project" />
          ) : (
            <div className="space-y-1">
              {documents.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => handleOpenNote(doc)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-left hover:bg-[var(--glass-hover)] transition-colors"
                  style={{ color: "var(--text-primary)" }}
                >
                  <FileText size={13} style={{ color: "var(--text-muted)" }} />
                  <span className="truncate">{doc.path?.split("/").pop() || doc.id}</span>
                </button>
              ))}
            </div>
          )}
        </Section>

        {/* Threads placeholder */}
        <Section icon={<MessageSquare size={16} />} title="Threads" count={0}>
          <EmptySection text="Thread linking coming soon" />
        </Section>

        {/* Events placeholder */}
        <Section icon={<Calendar size={16} />} title="Upcoming Events" count={0}>
          <EmptySection text="Calendar integration required" />
        </Section>
      </div>
    </div>
  );
}

function Section({ icon, title, count, children }: {
  icon: React.ReactNode; title: string; count: number; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: "var(--text-secondary)" }}>{icon}</span>
        <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>{title}</h2>
        <span className="text-xs px-1.5 rounded-full" style={{ background: "var(--glass)", color: "var(--text-muted)" }}>
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="glass p-3 rounded-lg text-center">
      <div className="text-2xl font-bold" style={{ color }}>{count}</div>
      <div className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}

function EmptySection({ text }: { text: string }) {
  return (
    <div className="text-sm py-2" style={{ color: "var(--text-muted)" }}>{text}</div>
  );
}
