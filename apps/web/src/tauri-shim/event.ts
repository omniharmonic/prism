/**
 * Browser shim for `@tauri-apps/api/event` (aliased in vite.config.ts).
 *
 * The desktop backend pushes events (e.g. `vault:batch_delete` progress) that
 * the web has no equivalent for. `listen` resolves to a no-op unsubscribe so
 * components that subscribe keep working; nothing is ever emitted.
 */
export type UnlistenFn = () => void;
export type EventCallback<T> = (event: { event: string; id: number; payload: T }) => void;

export async function listen<T>(_event: string, _handler: EventCallback<T>): Promise<UnlistenFn> {
  return () => {};
}

export async function once<T>(_event: string, _handler: EventCallback<T>): Promise<UnlistenFn> {
  return () => {};
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {
  /* no-op on web */
}
