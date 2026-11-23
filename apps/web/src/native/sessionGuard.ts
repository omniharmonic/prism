/**
 * When does a native session END? (qa/ios-simulator-findings-2026-10-08.md, findings 4 and 5.)
 *
 * THE RULE
 *  1. One 401 is a suspicion, never a sign-out. The token that was refused is asked ONE
 *     question — `GET /auth/me` with that same token:
 *       401 from /auth/me   → the token is dead: the session has ended;
 *       200, authenticated  → the token is alive: nothing happens (the 401 was not about us);
 *       anything else       → unknown (no answer, a 5xx, a proxy page): nothing happens.
 *     One question at a time, and its answer is reused for a moment, so a burst of 401s asks
 *     once. A 401 for a token that is no longer the current one says nothing and is ignored.
 *  2. Ending a session forgets the token and reloads into the sign-in screen. It NEVER starts
 *     a sign-in: only a person pressing "Sign in" does. (Each sign-in mints a device; an app
 *     that signs in again by itself mints one per 401.)
 *  3. Once this page has sent the device token, a request that would go out with NO token is
 *     not sent at all, and the page reloads into the sign-in screen — it does not carry on
 *     unauthenticated behind a workspace that still looks signed in.
 *
 * Pure (no fetch, no window): `transport.ts` supplies the edges, `scripts/verify-session.ts`
 * pins the rule.
 */
export type Verdict = "alive" | "dead" | "unknown";

export interface SessionGuardDeps {
  /** The current device token, or null. */
  getToken(): Promise<string | null>;
  /** Ask the server about ONE token (`GET /auth/me` with it). Must not go through the guard. */
  probe(token: string): Promise<Verdict>;
  /** Forget the token (host `onUnauthorized`). Never a sign-in. */
  forget(): Promise<unknown>;
  /** Drop the offline read cache of the account that just ended. */
  clearCache(): Promise<unknown>;
  /** Reload into the sign-in screen. `rejected` = the server refused the token (rule 1),
   *  as opposed to the token having gone from under the page (rule 3). */
  reload(rejected: boolean): void;
  now?(): number;
}

/** How long an "alive"/"unknown" answer is reused for the same token. */
export const VERDICT_REUSE_MS = 2000;

export interface SessionGuard {
  /** A request is going out with the device token. */
  sent(): void;
  /** True once the session is over for this page load: no authenticated request may be made. */
  over(): boolean;
  /** A request got 401 with `token`. Resolves with what the server says about that token. */
  unauthorized(token: string | null): Promise<Verdict>;
  /** A request found no token. True = do not send it (the session is over). */
  missing(): boolean;
  /** The person is signing out: stop sending. The sign-out path does its own reload. */
  closing(): void;
}

export function createSessionGuard(deps: SessionGuardDeps): SessionGuard {
  const now = deps.now ?? Date.now;
  let held = false; // this page load has sent the device token
  let over = false;
  let flight: { token: string; promise: Promise<Verdict> } | null = null;
  let last: { token: string; verdict: Verdict; at: number } | null = null;

  /** Rule 2. Runs at most once per page load. */
  function end(forget: boolean): void {
    if (over) return;
    over = true;
    void (async () => {
      // Neither step may keep the person on a dead workspace.
      const steps = Promise.allSettled([forget ? deps.forget() : null, deps.clearCache()]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([steps, new Promise((r) => { timer = setTimeout(r, 2000); })]);
      clearTimeout(timer);
      deps.reload(forget);
    })();
  }

  async function ask(token: string): Promise<Verdict> {
    let verdict: Verdict;
    try { verdict = await deps.probe(token); } catch { verdict = "unknown"; }
    if (verdict === "dead") {
      // A sign-in may have finished while we asked: only the CURRENT token can end the session.
      const current = await deps.getToken().catch(() => null);
      if (current && current !== token) return "unknown";
      end(true);
      return "dead";
    }
    last = { token, verdict, at: now() };
    return verdict;
  }

  return {
    sent() { held = true; },
    over: () => over,
    async unauthorized(token) {
      if (over) return "dead";
      if (!token) return "unknown";
      const current = await deps.getToken().catch(() => null);
      if (over) return "dead";
      if (current !== token) return "unknown"; // an older request's 401 (or the token is already gone)
      if (flight?.token === token) return flight.promise;
      if (last && last.token === token && now() - last.at < VERDICT_REUSE_MS) return last.verdict;
      const promise = ask(token).finally(() => { if (flight?.promise === promise) flight = null; });
      flight = { token, promise };
      return promise;
    },
    missing() {
      if (over) return true;
      if (!held) return false; // never signed in on this page load (the sign-in screen): unchanged
      end(false); // nothing to forget — the shell already has no token
      return true;
    },
    closing() { over = true; },
  };
}
