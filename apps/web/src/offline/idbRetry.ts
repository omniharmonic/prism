/**
 * IndexedDB can refuse work for a moment and then be fine: on iOS (WKWebView / Safari) the
 * storage process is restarted while the app is in the background or right after an app
 * update, and a connection opened earlier answers every request with
 * `UnknownError: Connection to Indexed Database server lost` (or `InvalidStateError`) until
 * a NEW connection is opened. One such failure must be neither shown to the person nor
 * read as "nothing stored".
 *
 * `idbRetry` runs one unit of work (open + ONE transaction). When it fails with a storage
 * error it drops the connection (`reset`) and tries again after a short pause — a few
 * attempts over about a second and a half — and only then throws. Callers keep reporting
 * the final failure exactly as before.
 *
 * Safe for writes: a unit rejects only when its transaction aborted, and an aborted
 * transaction wrote nothing. Errors a new attempt cannot change (quota, constraint, data)
 * and errors that are not storage errors (a rule of the caller, an explicit abort) are
 * thrown at once.
 */
export const IDB_RETRY_DELAYS_MS: readonly number[] = [150, 400, 900];
const PERMANENT = new Set(["QuotaExceededError", "ConstraintError", "DataError", "DataCloneError", "VersionError", "NotFoundError", "ReadOnlyError", "SecurityError"]);

export function idbRetryable(error: unknown): boolean {
  if (typeof DOMException === "undefined" || !(error instanceof DOMException)) return false;
  return !PERMANENT.has(error.name);
}

export async function idbRetry<T>(attempt: () => Promise<T>, reset: () => void, delays: readonly number[] = IDB_RETRY_DELAYS_MS): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (!idbRetryable(error)) throw error;
      reset();
      if (i >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
    }
  }
}
