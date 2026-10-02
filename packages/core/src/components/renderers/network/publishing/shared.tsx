import type { PublicationInfo } from "../../../../data/CollabSharing";
export function pubSlice(pub: PublicationInfo): string {
  return pub.kind === "path" ? (pub.pathPrefix ?? "") : `#${pub.tag}`;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontWeight: 600,
        color: "var(--text-muted)",
      }}
    >
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </div>
      {children}
      {hint && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-muted)",
            lineHeight: 1.45,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

export function ErrText({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{ fontSize: 11.5, color: "var(--color-danger, #EB5757)" }}
    >
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        style={{ opacity: 0.25 }}
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        style={{ opacity: 0.75 }}
      />
    </svg>
  );
}
