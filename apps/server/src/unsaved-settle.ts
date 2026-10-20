/**
 * The per-actor budget for SETTLING a page's unsaved live changes on behalf of a
 * body write (collab.ts `settleUnsaved`: load the document + store it — a
 * conversion and a vault write). One bucket, whichever door the write came
 * through: the gateway's PATCH/PUT/restore middleware and the Prism MCP tools.
 */
import { consumeRateLimit } from "./middleware/ratelimit";

/** Read per call (tests change it). */
export const unsavedSettlesPerMinute = (): number => (Number(process.env.UNSAVED_SETTLES_PER_MINUTE) > 0 ? Number(process.env.UNSAVED_SETTLES_PER_MINUTE) : 6);

/** The bucket key of a signed-in account (the same for its session, device and agent credentials). */
export const settleKeyForUser = (email: string): string => `u:${email.toLowerCase()}`;

/** Take one settle from `who`'s bucket: null = go ahead; a number = seconds until one is free (do NOT settle). */
export function takeUnsavedSettle(who: string): number | null {
  return consumeRateLimit(`unsaved-settle:${who}`, unsavedSettlesPerMinute(), 60_000);
}
