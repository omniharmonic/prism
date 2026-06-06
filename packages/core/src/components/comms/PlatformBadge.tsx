import { getPlatformConfig } from "../../lib/matrix/bridge-map";

interface PlatformBadgeProps {
  platform: string;
  className?: string;
}

export function PlatformBadge({ platform, className }: PlatformBadgeProps) {
  const config = getPlatformConfig(platform);

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${className || ""}`}
      style={{
        backgroundColor: `color-mix(in srgb, ${config.color} 15%, transparent)`,
        color: config.color,
      }}
    >
      {config.label}
    </span>
  );
}
