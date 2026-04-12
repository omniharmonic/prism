import { useState, useCallback } from "react";
import { X } from "lucide-react";
import { useCreateNote, useNotes } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { vaultApi } from "../../lib/parachute/client";

const STATUS_OPTIONS = ["todo", "in-progress", "blocked", "done"] as const;
const PRIORITY_OPTIONS = ["low", "medium", "high", "critical"] as const;

interface TaskCreateDialogProps {
  onClose: () => void;
}

export function TaskCreateDialog({ onClose }: TaskCreateDialogProps) {
  const createNote = useCreateNote();
  const openTab = useUIStore((s) => s.openTab);
  const { data: allNotes } = useNotes({ tag: "project" });

  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<string>("todo");
  const [priority, setPriority] = useState<string>("medium");
  const [project, setProject] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [showProjectSuggestions, setShowProjectSuggestions] = useState(false);
  const [dueDate, setDueDate] = useState("");
  const [assigned, setAssigned] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Derive project names from notes tagged "project"
  const projectNames = (allNotes || [])
    .map((n) => n.path || (n.metadata as Record<string, unknown>)?.title as string || "")
    .filter(Boolean);

  const filteredProjects = projectQuery.length > 0
    ? projectNames.filter((p) => p.toLowerCase().includes(projectQuery.toLowerCase()))
    : projectNames;

  const handleProjectSelect = useCallback((name: string) => {
    setProject(name);
    setProjectQuery(name);
    setShowProjectSuggestions(false);
  }, []);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setIsSubmitting(true);
    try {
      const metadata: Record<string, unknown> = {
        type: "task",
        status,
        priority,
      };
      if (project) metadata.project = project;
      if (dueDate) metadata.due = dueDate;
      if (assigned) metadata.assigned = assigned;

      const note = await createNote.mutateAsync({
        content: description || " ",
        metadata,
        path: title.trim(),
      });

      // Add the "task" tag
      await vaultApi.addTags(note.id, ["task"]);

      openTab(note.id, title.trim(), "task");
      onClose();
    } catch (e) {
      console.error("Failed to create task:", e);
      alert(`Failed to create task: ${e}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div
        className="glass-elevated w-full max-w-md mx-4"
        style={{ borderRadius: "var(--radius-lg)", padding: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            New Task
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="space-y-3">
          {/* Title */}
          <FormField label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..."
              autoFocus
              className="w-full h-8 rounded-md px-2.5 text-sm outline-none"
              style={{
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                color: "var(--text-primary)",
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) handleSubmit(); }}
            />
          </FormField>

          {/* Status + Priority row */}
          <div className="flex gap-3">
            <FormField label="Status" className="flex-1">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-full h-8 rounded-md px-2 text-sm outline-none cursor-pointer"
                style={{
                  background: "var(--glass)",
                  border: "1px solid var(--glass-border)",
                  color: "var(--text-primary)",
                }}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s} style={{ background: "var(--bg-elevated)" }}>{s}</option>
                ))}
              </select>
            </FormField>

            <FormField label="Priority" className="flex-1">
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full h-8 rounded-md px-2 text-sm outline-none cursor-pointer"
                style={{
                  background: "var(--glass)",
                  border: "1px solid var(--glass-border)",
                  color: "var(--text-primary)",
                }}
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p} style={{ background: "var(--bg-elevated)" }}>{p}</option>
                ))}
              </select>
            </FormField>
          </div>

          {/* Project autocomplete */}
          <FormField label="Project">
            <div className="relative">
              <input
                value={projectQuery}
                onChange={(e) => {
                  setProjectQuery(e.target.value);
                  setProject(e.target.value);
                  setShowProjectSuggestions(true);
                }}
                onFocus={() => setShowProjectSuggestions(true)}
                onBlur={() => setTimeout(() => setShowProjectSuggestions(false), 150)}
                placeholder="Search projects..."
                className="w-full h-8 rounded-md px-2.5 text-sm outline-none"
                style={{
                  background: "var(--glass)",
                  border: "1px solid var(--glass-border)",
                  color: "var(--text-primary)",
                }}
              />
              {showProjectSuggestions && filteredProjects.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-0.5 py-0.5 glass-elevated z-10 rounded-md overflow-hidden max-h-32 overflow-y-auto">
                  {filteredProjects.slice(0, 8).map((p) => (
                    <button
                      key={p}
                      onMouseDown={() => handleProjectSelect(p)}
                      className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--glass-hover)] transition-colors truncate"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </FormField>

          {/* Due date + Assigned row */}
          <div className="flex gap-3">
            <FormField label="Due Date" className="flex-1">
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full h-8 rounded-md px-2.5 text-sm outline-none"
                style={{
                  background: "var(--glass)",
                  border: "1px solid var(--glass-border)",
                  color: "var(--text-primary)",
                }}
              />
            </FormField>

            <FormField label="Assigned" className="flex-1">
              <input
                value={assigned}
                onChange={(e) => setAssigned(e.target.value)}
                placeholder="Person..."
                className="w-full h-8 rounded-md px-2.5 text-sm outline-none"
                style={{
                  background: "var(--glass)",
                  border: "1px solid var(--glass-border)",
                  color: "var(--text-primary)",
                }}
              />
            </FormField>
          </div>

          {/* Description */}
          <FormField label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Task details..."
              rows={3}
              className="w-full rounded-md px-2.5 py-2 text-sm outline-none resize-none"
              style={{
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                color: "var(--text-primary)",
                lineHeight: "1.5",
              }}
            />
          </FormField>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm transition-colors hover:bg-[var(--glass-hover)]"
            style={{ color: "var(--text-secondary)" }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || isSubmitting}
            className="px-4 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "white",
            }}
          >
            {isSubmitting ? "Creating..." : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="block text-xs mb-1" style={{ color: "var(--text-muted)" }}>
        {label}
      </label>
      {children}
    </div>
  );
}
