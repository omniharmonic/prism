// Platform configuration for bridged messaging platforms.
// Each platform gets a label, color (from design tokens), and icon name.

export type Platform =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "linkedin"
  | "instagram"
  | "messenger"
  | "twitter"
  | "signal"
  | "imessage"
  | "email"
  | "matrix";

export interface PlatformConfig {
  label: string;
  color: string;
  iconName: string;
}

export const PLATFORM_CONFIG: Record<Platform, PlatformConfig> = {
  whatsapp: { label: "WhatsApp", color: "var(--platform-whatsapp)", iconName: "MessageCircle" },
  telegram: { label: "Telegram", color: "var(--platform-telegram)", iconName: "Send" },
  discord: { label: "Discord", color: "var(--platform-discord)", iconName: "Gamepad2" },
  linkedin: { label: "LinkedIn", color: "var(--platform-linkedin)", iconName: "Linkedin" },
  instagram: { label: "Instagram", color: "var(--platform-instagram)", iconName: "Instagram" },
  messenger: { label: "Messenger", color: "var(--platform-messenger)", iconName: "MessageSquare" },
  twitter: { label: "Twitter/X", color: "var(--platform-twitter)", iconName: "Twitter" },
  signal: { label: "Signal", color: "var(--platform-imessage)", iconName: "Shield" },
  imessage: { label: "iMessage", color: "var(--platform-imessage)", iconName: "Smartphone" },
  email: { label: "Email", color: "var(--platform-email)", iconName: "Mail" },
  matrix: { label: "Matrix", color: "var(--text-secondary)", iconName: "Hash" },
};

export function getPlatformConfig(platform: string): PlatformConfig {
  return PLATFORM_CONFIG[platform as Platform] || PLATFORM_CONFIG.matrix;
}
