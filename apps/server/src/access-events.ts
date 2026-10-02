/** In-process permission invalidation. No credentials or document content. */
type Listener = (vaultId?: string) => void;
const listeners = new Set<Listener>();
let revision = 0;
export const accessRevision = (): number => revision;
export function onAccessChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Called synchronously after a permission write, including governance writes. */
export function notifyAccessChanged(vaultId?: string): void {
  revision++;
  for (const listener of listeners) listener(vaultId);
}
