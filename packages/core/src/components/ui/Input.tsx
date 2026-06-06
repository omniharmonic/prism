import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
}

import React from "react";

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, icon, ...props }, ref) => {
    return (
      <div className={cn("relative flex items-center", className)}>
        {icon && (
          <span className="absolute left-2.5 pointer-events-none" style={{ color: "var(--text-muted)" }}>
            {icon}
          </span>
        )}
        <input
          ref={ref}
          className={cn(
            "w-full h-8 rounded-lg px-3 text-sm outline-none",
            "transition-colors placeholder:text-[var(--text-muted)]",
            icon && "pl-8",
          )}
          style={{
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            color: "var(--text-primary)",
          }}
          {...props}
        />
      </div>
    );
  },
);

Input.displayName = "Input";
