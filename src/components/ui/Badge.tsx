import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "platform";

interface BadgeProps {
  variant?: BadgeVariant;
  platform?: string;
  children: ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-[var(--glass)] text-[var(--text-secondary)]",
  success: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
  warning: "bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
  error: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
  info: "bg-accent-dim text-accent",
  platform: "",
};

const PLATFORM_COLORS: Record<string, string> = {
  whatsapp: "var(--platform-whatsapp)",
  telegram: "var(--platform-telegram)",
  discord: "var(--platform-discord)",
  linkedin: "var(--platform-linkedin)",
  instagram: "var(--platform-instagram)",
  messenger: "var(--platform-messenger)",
  twitter: "var(--platform-twitter)",
  imessage: "var(--platform-imessage)",
  email: "var(--platform-email)",
};

export function Badge({ variant = "default", platform, children, className }: BadgeProps) {
  const platformColor = platform ? PLATFORM_COLORS[platform.toLowerCase()] : undefined;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium",
        variant !== "platform" && variantStyles[variant],
        className,
      )}
      style={
        variant === "platform" && platformColor
          ? {
              backgroundColor: `color-mix(in srgb, ${platformColor} 15%, transparent)`,
              color: platformColor,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}
