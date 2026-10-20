import { FileText, Tags, Link2 } from "lucide-react";
import { useVaultStats } from "../../../app/hooks/useParachute";

export function StatCardWidget() {
  const { data: stats, isLoading } = useVaultStats();

  if (isLoading) {
    return (
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 rounded-lg animate-pulse" style={{ background: "var(--glass)" }} />
        ))}
      </div>
    );
  }

  const items = [
    { label: "Notes", value: stats?.totalNotes ?? 0, icon: FileText, color: "var(--color-accent)" },
    { label: "Tags", value: stats?.tagCount ?? 0, icon: Tags, color: "var(--color-success)" },
    { label: "Links", value: stats?.linkCount ?? 0, icon: Link2, color: "var(--color-warning)" },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map(({ label, value, icon: Icon, color }) => (
        <div
          key={label}
          className="glass rounded-lg p-3 text-center"
        >
          <Icon size={16} className="mx-auto mb-1.5" style={{ color }} />
          <div className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            {value.toLocaleString()}
          </div>
          <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}
