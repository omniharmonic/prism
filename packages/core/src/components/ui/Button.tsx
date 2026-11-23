import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--action-bg)] text-[var(--action-fg)] hover:bg-[var(--action-hover)] active:brightness-90",
  secondary:
    "glass-interactive",
  ghost:
    "bg-transparent hover:bg-[var(--glass-hover)] active:bg-[var(--glass-active)]",
};

/* Bound to the control tokens (tokens.css); `.ui-button` gets the touch size in touch.css. */
const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-[var(--control-h-sm)] px-[var(--control-px-sm)] text-xs gap-1.5 rounded-[var(--control-radius)]",
  md: "h-[var(--control-h-md)] px-[var(--control-px-md)] text-sm gap-[var(--control-gap)] rounded-[var(--control-radius)]",
  lg: "h-[var(--control-h-lg)] px-[var(--control-px-lg)] text-sm gap-2 rounded-[var(--control-radius)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        aria-busy={loading || undefined}
        disabled={disabled || loading}
        className={cn(
          "ui-button inline-flex min-w-0 max-w-full items-center justify-center whitespace-nowrap font-medium transition-all",
          "focus-ring",
          "disabled:opacity-40 disabled:pointer-events-none",
          variantStyles[variant],
          sizeStyles[size],
          className,
        )}
        style={{ color: variant === "primary" ? "var(--action-fg)" : "var(--text-primary)" }}
        {...props}
      >
        {loading ? <Spinner size={size === "sm" ? 12 : 14} /> : icon}
        {/* A plain label truncates instead of wrapping inside the pill or overflowing its row. */}
        {typeof children === "string" ? <span className="min-w-0 truncate">{children}</span> : children}
      </button>
    );
  },
);

Button.displayName = "Button";

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
        className="opacity-25"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        className="opacity-75"
      />
    </svg>
  );
}
