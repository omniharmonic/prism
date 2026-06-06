import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface GlassProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  interactive?: boolean;
  elevated?: boolean;
}

export const Glass = forwardRef<HTMLDivElement, GlassProps>(
  ({ children, className, interactive, elevated, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          elevated ? "glass-elevated" : interactive ? "glass-interactive" : "glass",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);

Glass.displayName = "Glass";
