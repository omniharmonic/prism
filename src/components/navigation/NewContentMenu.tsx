import {
  FileText,
  Presentation,
  Code,
  Mail,
  Table2,
  Globe,
  CheckSquare,
  LayoutDashboard,
} from "lucide-react";
import { useCreateNote } from "../../app/hooks/useParachute";
import { useUIStore } from "../../app/stores/ui";
import { CONTENT_DEFAULTS, type ContentType } from "../../lib/types";

const CONTENT_TYPE_OPTIONS = [
  { type: "document" as ContentType, label: "Document", icon: FileText },
  { type: "presentation" as ContentType, label: "Presentation", icon: Presentation },
  { type: "code" as ContentType, label: "Code File", icon: Code },
  { type: "email" as ContentType, label: "Email", icon: Mail },
  { type: "spreadsheet" as ContentType, label: "Spreadsheet", icon: Table2 },
  { type: "website" as ContentType, label: "Website", icon: Globe },
  { type: "task" as ContentType, label: "Task", icon: CheckSquare },
  { type: "dashboard" as ContentType, label: "Dashboard", icon: LayoutDashboard },
];

interface NewContentMenuProps {
  onClose: () => void;
}

export function NewContentMenu({ onClose }: NewContentMenuProps) {
  const createNote = useCreateNote();
  const openTab = useUIStore((s) => s.openTab);

  const handleCreate = async (type: ContentType) => {
    try {
      const defaults = CONTENT_DEFAULTS[type];
      const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const title = `Untitled ${type} ${ts}`;

      const note = await createNote.mutateAsync({
        content: defaults.content || " ",
        metadata: defaults.metadata,
        path: title,
      });

      openTab(note.id, title, type);
      onClose();
    } catch (e) {
      console.error("Failed to create note:", e);
      alert(`Failed to create ${type}: ${e}`);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
    >
      <div
        className="absolute bottom-12 left-2 py-1 glass-elevated"
        style={{ borderRadius: "var(--radius-md)", width: 200 }}
        onClick={(e) => e.stopPropagation()}
      >
        {CONTENT_TYPE_OPTIONS.map(({ type, label, icon: Icon }) => (
          <button
            key={type}
            onClick={() => handleCreate(type)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-[var(--glass-hover)] transition-colors"
            style={{ color: "var(--text-primary)" }}
          >
            <Icon size={15} style={{ color: "var(--text-secondary)" }} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
