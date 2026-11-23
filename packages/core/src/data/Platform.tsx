// Which shell the core UI is running in. The desktop (Tauri) shell talks to the
// Rust backend via `invoke` and can reach host integrations (Matrix, Google,
// Claude CLI, Ollama, native config/Keychain); the web/PWA shell talks only to
// the Prism Server gateway and CANNOT reach those. Components that back onto
// desktop-only `invoke` calls use this to gate themselves in the browser (show a
// "manage on desktop" notice) instead of silently failing.
//
// Defaults to "desktop" when no provider is mounted, so the desktop shell needs
// no change; the web shell explicitly wraps the app in <PlatformProvider value="web">.
import { createContext, useContext, type ReactNode } from "react";

export type Platform = "web" | "desktop";

const PlatformContext = createContext<Platform>("desktop");

export function PlatformProvider({ value, children }: { value: Platform; children: ReactNode }) {
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): Platform {
  return useContext(PlatformContext);
}

/** True in the web/PWA shell — host integrations (agent trigger, sync, native
 *  config) are unavailable; gate those controls. */
export function useIsWeb(): boolean {
  return useContext(PlatformContext) === "web";
}
