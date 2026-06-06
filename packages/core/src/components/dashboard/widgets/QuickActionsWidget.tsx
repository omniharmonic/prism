import {
  Plus,
  Search,
  FileText,
  CheckSquare,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCreateNote } from "../../../app/hooks/useParachute";
import { useUIStore } from "../../../app/stores/ui";
import type { DashboardWidgetConfig, QuickAction } from "../../../lib/dashboard/widget-registry";

interface QuickActionsWidgetProps {
  config: DashboardWidgetConfig;
}

const ICON_MAP: Record<string, LucideIcon> = {
  Plus,
  Search,
  FileText,
  CheckSquare,
  Zap,
};

export function QuickActionsWidget({ config }: QuickActionsWidgetProps) {
  const actions = config.actions ?? [];
  const createNote = useCreateNote();
  const openCommandBar = useUIStore((s) => s.openCommandBar);
  const openTab = useUIStore((s) => s.openTab);

  const handleAction = (action: QuickAction) => {
    switch (action.action) {
      case "create-note": {
        createNote.mutate(
          {
            content: "",
            tags: action.tags,
            metadata: action.metadata,
          },
          {
            onSuccess: (newNote) => {
              if (newNote && typeof newNote === "object" && "id" in newNote) {
                const n = newNote as { id: string };
                openTab(n.id, action.label, "document");
              }
            },
          },
        );
        break;
      }
      case "open-command-bar": {
        openCommandBar();
        break;
      }
    }
  };

  if (actions.length === 0) {
    return (
      <div className="text-sm py-4 text-center" style={{ color: "var(--text-muted)" }}>
        No actions configured. Edit this widget to add actions.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {actions.map((action) => {
        const Icon = ICON_MAP[action.icon] ?? Zap;
        return (
          <button
            key={action.id}
            onClick={() => handleAction(action)}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors hover:bg-[var(--glass-hover)]"
            style={{
              background: "var(--glass)",
              border: "1px solid var(--glass-border)",
              color: "var(--text-primary)",
            }}
          >
            <Icon size={15} style={{ color: "var(--color-accent)" }} />
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
