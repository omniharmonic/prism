import type { TranscriptDecision } from "../../data/TranscriptReviewClientContext";

export interface TranscriptReceipt {
  version: 1;
  body: string;
  title: string;
  elsewhere: boolean;
}
const memory = new Map<string, TranscriptReceipt>();
const NOTE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
export const transcriptReceiptKey = (scope: string, meetingId: string) =>
  `prism:transcript-decision:v1:${JSON.stringify([scope, meetingId])}`;
export const transcriptNoteId = (id: string) => NOTE_ID.test(id);
export function receiptBody(receipt: TranscriptReceipt): TranscriptDecision {
  return JSON.parse(receipt.body);
}
function valid(raw: string): TranscriptReceipt | null {
  if (raw.length > 8192) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      Object.keys(value).sort().join() !== "body,elsewhere,title,version" ||
      value.version !== 1 ||
      typeof value.body !== "string" ||
      value.body.length > 4096 ||
      typeof value.title !== "string" ||
      value.title.length > 500 ||
      typeof value.elsewhere !== "boolean"
    )
      return null;
    const body = JSON.parse(value.body);
    if (
      !body ||
      Object.keys(body).sort().join() !==
        "action,expectedRevision,meetingUpdatedAt,reason,requestId,transcriptId,transcriptUpdatedAt" ||
      JSON.stringify(body) !== value.body
    )
      return null;
    if (
      typeof body.transcriptId !== "string" ||
      !NOTE_ID.test(body.transcriptId) ||
      !["link", "unlink"].includes(body.action) ||
      typeof body.reason !== "string" ||
      !body.reason.trim() ||
      body.reason.length > 500 ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    )
      return null;
    for (const key of ["meetingUpdatedAt", "transcriptUpdatedAt"])
      if (
        typeof body[key] !== "string" ||
        !body[key].length ||
        body[key].length > 64
      )
        return null;
    if (
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(body.requestId)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function readTranscriptReceipt(key: string): {
  receipt: TranscriptReceipt | null;
  warning: string;
  corrupt: boolean;
} {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const receipt = valid(raw);
      if (!receipt)
        return {
          receipt: null,
          warning:
            "A stored decision cannot be read safely. Check these records before repairing browser storage; a new decision will not replace it.",
          corrupt: true,
        };
      memory.set(key, receipt);
      return { receipt, warning: "", corrupt: false };
    }
    return { receipt: memory.get(key) ?? null, warning: "", corrupt: false };
  } catch {
    return {
      receipt: memory.get(key) ?? null,
      warning:
        "Decision recovery is available only in this window. Keep it open or copy the retry details before leaving.",
      corrupt: false,
    };
  }
}
/** Reserve before dispatch. An unresolved request is never replaced by another payload. */
export async function reserveTranscriptReceipt(
  key: string,
  next: TranscriptReceipt,
): Promise<ReturnType<typeof readTranscriptReceipt>> {
  if (!valid(JSON.stringify(next)))
    throw Error(
      "The decision cannot be saved safely. Reload these records before trying again.",
    );
  const reserve = () => {
    const existing = readTranscriptReceipt(key);
    if (existing.corrupt || existing.receipt) return existing;
    memory.set(key, next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      return { receipt: next, warning: "", corrupt: false };
    } catch {
      return {
        receipt: next,
        warning:
          "Decision recovery is available only in this window. Keep it open or copy the retry details before leaving.",
        corrupt: false,
      };
    }
  };
  if (navigator.locks) return navigator.locks.request(key, reserve);
  const existing = readTranscriptReceipt(key);
  if (existing.receipt || existing.corrupt) return existing;
  return {
    receipt: null,
    warning:
      "This browser cannot coordinate safe decision recovery across windows. Viewing and opening recordings still work. Use a current supported browser to start a new transcript decision.",
    corrupt: true,
  };
}
/** Compare before clearing: another view's unresolved request must never be erased. */
export async function clearTranscriptReceipt(
  key: string,
  receipt: TranscriptReceipt,
): Promise<string> {
  const clear = () => {
    if (memory.get(key)?.body === receipt.body) memory.delete(key);
    try {
      const raw = localStorage.getItem(key);
      if (raw && valid(raw)?.body === receipt.body)
        localStorage.removeItem(key);
      return "";
    } catch {
      return "The decision finished, but browser storage could not be cleared. Reopening may show a safe replay of this same request.";
    }
  };
  if (navigator.locks) return navigator.locks.request(key, clear);
  return "The decision finished, but this browser cannot safely clear its recovery record across windows. Reopening may show a safe replay of this same request.";
}
