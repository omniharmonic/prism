import { parseHumanCommand } from "./validation";
export interface HumanCommandReceipt {
  version: 1;
  body: string;
}
export interface HumanReceiptState {
  receipt: HumanCommandReceipt | null;
  blocked: boolean;
  message: string;
}
const memory = new Map<string, HumanCommandReceipt>();
const lastSeen = new Map<string, HumanCommandReceipt>();
export const humanReceiptKey = (audience: string, noteId: string) =>
  `prism:human-command:v1:${JSON.stringify([audience, noteId])}`;
function parse(raw: string): HumanCommandReceipt | null {
  if (raw.length > 500_000) return null;
  try {
    const value = JSON.parse(raw);
    return value &&
      Object.keys(value).sort().join() === "body,version" &&
      value.version === 1 &&
      typeof value.body === "string" &&
      parseHumanCommand(value.body)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function readHumanReceipt(key: string): HumanReceiptState {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const receipt = parse(raw);
      if (!receipt)
        return {
          receipt: null,
          blocked: true,
          message:
            "A saved submission cannot be read safely. It will not be replaced by a new request.",
        };
      lastSeen.set(key, receipt);
      if (memory.get(key)?.body === receipt.body) memory.delete(key);
      return { receipt, blocked: false, message: "" };
    }
    // Only records which failed persistence live here. Do not discard their bytes.
    const receipt = memory.get(key) ?? null;
    return {
      receipt,
      blocked: !!receipt,
      message: receipt
        ? "This request is only held in this window. Copy it before leaving; no new submission will replace it."
        : "",
    };
  } catch {
    return {
      receipt: memory.get(key) ?? lastSeen.get(key) ?? null,
      blocked: true,
      message:
        "Browser recovery storage is unavailable. Keep this window open and copy the request before leaving. Sending is paused.",
    };
  }
}
/** Reserve before sending, serializing all request kinds for this audience/document. */
export async function reserveHumanReceipt(
  key: string,
  next: HumanCommandReceipt,
): Promise<HumanReceiptState> {
  if (!parse(JSON.stringify(next)))
    throw Error("The request is invalid and was not submitted.");
  if (!navigator.locks)
    return {
      ...readHumanReceipt(key),
      blocked: true,
      message:
        "This browser cannot safely coordinate submissions across windows. Reading and preparing drafts still work.",
    };
  return navigator.locks.request(key, () => {
    const existing = readHumanReceipt(key);
    if (existing.blocked || existing.receipt) return existing;
    memory.set(key, next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      const saved = readHumanReceipt(key);
      if (saved.receipt?.body !== next.body)
        throw Error("Recovery record changed");
      return saved;
    } catch {
      return {
        receipt: next,
        blocked: true,
        message:
          "This request could not be saved. Nothing was sent; keep the window open or copy it before leaving.",
      };
    }
  });
}
/** Clear only after a confirmed outcome and only if the exact saved bytes still match. */
export async function clearHumanReceipt(
  key: string,
  confirmed: HumanCommandReceipt,
): Promise<boolean> {
  if (!navigator.locks) return false;
  return navigator.locks.request(key, () => {
    try {
      const raw = localStorage.getItem(key);
      if (raw && parse(raw)?.body !== confirmed.body) return false;
      if (!raw && memory.get(key) && memory.get(key)?.body !== confirmed.body)
        return false;
      if (raw) localStorage.removeItem(key);
      if (memory.get(key)?.body === confirmed.body) memory.delete(key);
      lastSeen.delete(key);
      return true;
    } catch {
      return false;
    }
  });
}
