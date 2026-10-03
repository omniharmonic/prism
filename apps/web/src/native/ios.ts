// The iOS app's shell surface (WP5). host.js exposes `__PRISM_SHELL__.ios`
// only inside the iOS build of Prism Client; everywhere else it is null, so
// every caller here degrades to "not available".
//
// Each function is a narrow wrapper over one shell command
// (apps/client/src-tauri/src/mobile_cmds.rs, granted in capabilities/mobile.json).
// The shell validates every argument again and owns every native prompt
// (confirmation, Face ID); nothing here is a security boundary.

export type LockMode = "off" | "launch" | "background" | "always";
export interface AppLock {
  mode: LockMode;
  minutes: number;
}
export interface AppSettings {
  serverOrigin: string | null;
  lock: AppLock;
  /** "faceID" | "touchID" | "opticID" | "none" */
  biometry: string;
  passcodeSet: boolean;
}
export interface PushRegistration {
  token: string;
  environment: "sandbox" | "production";
}

interface IosShell {
  setServerOrigin(origin: string): Promise<string>;
  resetServer(): Promise<boolean>;
  appSettings(): Promise<AppSettings>;
  setAppLock(mode: LockMode, minutes?: number | null): Promise<AppLock>;
  pushRegister(): Promise<PushRegistration>;
  /** "notDetermined" | "denied" | "authorized" | "provisional" | "ephemeral" */
  pushStatus(): Promise<string>;
  takeOpenedSession(): Promise<string | null>;
}

interface Shell {
  platform?: string;
  ios?: IosShell | null;
  toast?(msg: string): void;
}

const shell = (): Shell | undefined => (window as unknown as { __PRISM_SHELL__?: Shell }).__PRISM_SHELL__;

/** The iOS shell, or null outside the iOS app. */
export function iosShell(): IosShell | null {
  return shell()?.ios ?? null;
}

export const isIosApp = (): boolean => iosShell() !== null;

/** The shell's errors arrive as strings; make them readable. */
export function shellError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
