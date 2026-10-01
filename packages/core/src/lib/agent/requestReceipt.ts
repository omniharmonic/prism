/** A retry uses the same ID after reload; receipts never trigger automatic work. */
interface Receipt { id: string; hash: string }
const keyFor = (scope: string, conversation: string) => `prism:agent-request:v1:${JSON.stringify([scope, conversation])}`;

export async function requestReceipt(scope: string, conversation: string, payload: unknown): Promise<Receipt> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = keyFor(scope, conversation);
  const readOrCreate = () => {
    try {
      const raw = localStorage.getItem(key);
      let previous: Receipt | null = null;
      try { previous = raw ? JSON.parse(raw) : null; } catch { /* Replace malformed local data. */ }
      if (previous?.hash === hash && typeof previous.id === "string" && /^[A-Za-z0-9_-]{16,100}$/.test(previous.id)) return previous;
      const receipt = { id: crypto.randomUUID(), hash };
      localStorage.setItem(key, JSON.stringify(receipt));
      return receipt;
    } catch {
      throw new Error("Prism couldn't save a retry receipt. Copy your draft and free some browser storage before sending.");
    }
  };
  return navigator.locks ? navigator.locks.request(key, readOrCreate) : readOrCreate();
}

export function clearRequestReceipt(scope: string, conversation: string, id: string): void {
  const key = keyFor(scope, conversation);
  try {
    if ((JSON.parse(localStorage.getItem(key) ?? "null") as Receipt | null)?.id === id) localStorage.removeItem(key);
  } catch { /* Retaining a receipt is safer than accidentally duplicating work. */ }
}
