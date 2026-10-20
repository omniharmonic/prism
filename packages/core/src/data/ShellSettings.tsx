// Shell-provided settings (WP5): a native shell may add its own section to
// Settings → Account (the iOS app: Face ID lock + "Sign out & change server").
// The web PWA and the desktop provide none, so nothing renders there.
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

const ShellSettingsContext = createContext<ComponentType | null>(null);

export function ShellSettingsProvider({ value, children }: { value: ComponentType | null; children: ReactNode }) {
  return <ShellSettingsContext.Provider value={value}>{children}</ShellSettingsContext.Provider>;
}

/** Renders the shell's settings section, or nothing. */
export function ShellSettingsSlot() {
  const Section = useContext(ShellSettingsContext);
  return Section ? <Section /> : null;
}
