import { cn } from "../../lib/cn";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  rounded?: boolean;
  className?: string;
}

export function Skeleton({ width, height = 16, rounded, className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse",
        rounded ? "rounded-full" : "rounded-md",
        className,
      )}
      style={{
        width: typeof width === "number" ? `${width}px` : width,
        height: typeof height === "number" ? `${height}px` : height,
        background: "var(--glass)",
      }}
    />
  );
}
