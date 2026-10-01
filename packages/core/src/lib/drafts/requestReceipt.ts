/** A retry uses the same ID after reload; receipts never trigger automatic work. */
interface Receipt { id: string; hash: string; createdAt?: number }
const keyFor = (scope: string, conversation: string, namespace = "agent") => `prism:${namespace}-request:v1:${JSON.stringify([scope, conversation])}`;

export async function requestReceipt(scope: string, conversation: string, payload: unknown, options: { namespace?: string; maxAgeMs?: number } = {}): Promise<Receipt> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = keyFor(scope, conversation, options.namespace);
  const readOrCreate = () => {
    try {
      const raw = localStorage.getItem(key);
      let previous: Receipt | null = null;
      try { previous = raw ? JSON.parse(raw) : null; } catch { /* Replace malformed local data. */ }
      if (previous?.hash === hash && typeof previous.id === "string" && /^[A-Za-z0-9_-]{16,100}$/.test(previous.id)) {
        if (options.maxAgeMs !== undefined && (typeof previous.createdAt !== "number" || Date.now() < previous.createdAt || Date.now() - previous.createdAt > options.maxAgeMs)) throw new ExpiredReceiptError();
        return previous;
      }
      const receipt = { id: crypto.randomUUID(), hash, createdAt: Date.now() };
      localStorage.setItem(key, JSON.stringify(receipt));
      return receipt;
    } catch (error) {
      if (error instanceof ExpiredReceiptError) throw error;
      throw new Error("Prism couldn't save a retry receipt. Copy your draft and free some browser storage before sending.");
    }
  };
  return navigator.locks ? navigator.locks.request(key, readOrCreate) : readOrCreate();
}

export function clearRequestReceipt(scope: string, conversation: string, id: string, namespace = "agent"): void {
  const key = keyFor(scope, conversation, namespace);
  try {
    if ((JSON.parse(localStorage.getItem(key) ?? "null") as Receipt | null)?.id === id) localStorage.removeItem(key);
  } catch { /* Retaining a receipt is safer than accidentally duplicating work. */ }
}

class ExpiredReceiptError extends Error {
  constructor() { super("The previous send is too old to retry safely. Check the conversation first; edit the draft only if you intend to send a new message."); }
}
