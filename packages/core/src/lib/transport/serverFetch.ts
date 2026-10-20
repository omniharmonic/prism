/**
 * The ONE seam through which shared UI in `@prism/core` reaches the Prism Server
 * (governance panel, the review/propose loop). Default = same-origin + the session
 * cookie, exactly what those call sites did inline before. The web shell swaps in
 * its transport helper (`apps/web/src/transport.ts`) via `setServerFetch`, so a
 * native shell (tauri://localhost, bearer device token, remote origin) works
 * without `@prism/core` knowing which mode it is in.
 *
 * `input` is a server-relative path ("/api/governance/…"); the installed
 * implementation decides the origin and credentials.
 */
export type ServerFetch = (input: string, init?: RequestInit) => Promise<Response>;

const defaultServerFetch: ServerFetch = (input, init) => fetch(input, { ...init, credentials: "include" });

let impl: ServerFetch = defaultServerFetch;

/** Install the shell's transport (called once at startup by apps/web). */
export function setServerFetch(f: ServerFetch): void {
  impl = f;
}

/** Fetch a Prism Server path through the installed transport. */
export const serverFetch: ServerFetch = (input, init) => impl(input, init);
