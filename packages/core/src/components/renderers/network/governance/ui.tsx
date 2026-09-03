// Shared presentation primitives for the governance surface. Everything here is
// styling + tiny stateless widgets, so the real components stay about governance
// rather than about padding. Matches the sibling Network panels' conventions:
// glass cards, var(--text-*) colors, the shared Button/Badge/Input.
import type { CSSProperties, ReactNode } from "react";

export const card: CSSProperties = {
  border: "1px solid var(--glass-border)",
  borderRadius: 10,
  padding: 16,
  marginBottom: 18,
  background: "var(--glass-bg)",
};

export const subCard: CSSProperties = {
  border: "1px solid var(--glass-border)",
  borderRadius: 8,
  padding: 12,
  background: "var(--glass)",
};

export const label: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: 6,
};

export const hint: CSSProperties = { fontSize: 12, color: "var(--text-secondary)", margin: "0 0 10px" };

export const row: CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };

export const selectStyle: CSSProperties = {
  fontSize: 13,
  padding: "6px 8px",
  borderRadius: 6,
  background: "var(--glass-bg)",
  color: "var(--text-primary)",
  border: "1px solid var(--glass-border)",
};

export const sentence: CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.5,
  color: "var(--text-primary)",
};

/** A titled card with an optional icon and right-aligned actions. */
export function Section({
  icon,
  title,
  subtitle,
  actions,
  children,
  testId,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div style={card} data-testid={testId}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: subtitle ? 4 : 12 }}>
        {icon}
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: "var(--text-primary)", flex: 1 }}>{title}</h2>
        {actions}
      </div>
      {subtitle && <p style={hint}>{subtitle}</p>}
      {children}
    </div>
  );
}

/** An inline field: a small label above its control. */
export function Field({ text, children, width }: { text: string; children: ReactNode; width?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, ...(width ? { width } : {}) }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted, var(--text-secondary))" }}>{text}</span>
      {children}
    </div>
  );
}

/** A small pill — used for members, capabilities and assign targets. */
export function Chip({
  children,
  onRemove,
  tone = "neutral",
  testId,
}: {
  children: ReactNode;
  onRemove?: () => void;
  tone?: "neutral" | "accent";
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        padding: "3px 8px",
        borderRadius: 999,
        border: `1px solid ${tone === "accent" ? "var(--accent)" : "var(--glass-border)"}`,
        background: tone === "accent" ? "var(--accent-dim)" : "var(--glass)",
        color: tone === "accent" ? "var(--accent)" : "var(--text-secondary)",
      }}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 0, lineHeight: 1 }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** approvals / needed as a bar plus a "1 of 2" readout. */
export function Progress({ value, needed, testId }: { value: number; needed: number; testId?: string }) {
  const pct = needed <= 0 ? 100 : Math.min(100, Math.round((value / needed) * 100));
  const done = value >= needed;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180 }} data-testid={testId}>
      <div style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--glass-border)", overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: done ? "var(--color-success, #2e7d32)" : "var(--accent)",
            transition: "width 160ms ease",
          }}
        />
      </div>
      <span style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
        {value} of {needed} approvals
      </span>
    </div>
  );
}

/** A checkbox with a human label (the capability/power matrix's atom). */
export function Check({
  checked,
  onChange,
  text,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  text: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <label
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12.5,
        color: disabled ? "var(--text-muted, var(--text-secondary))" : "var(--text-primary)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {text}
    </label>
  );
}

/** Relative "3 minutes ago" for proposal/audit timestamps. */
export function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso || "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Time left in a voting window, or "" when there is none / it has passed. */
export function countdown(openedAt: string, windowSeconds: number): string {
  if (!windowSeconds) return "";
  const t = Date.parse(openedAt);
  if (Number.isNaN(t)) return "";
  const left = Math.floor((t + windowSeconds * 1000 - Date.now()) / 1000);
  if (left <= 0) return "voting closed";
  if (left < 3600) return `${Math.ceil(left / 60)}m left to vote`;
  if (left < 86400) return `${Math.floor(left / 3600)}h left to vote`;
  return `${Math.floor(left / 86400)}d left to vote`;
}
