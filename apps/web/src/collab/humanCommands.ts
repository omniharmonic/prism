import {
  humanCollabCommandPath,
  type HumanCollabCommand,
  type HumanCollabErrorCode,
  type HumanCollabResult,
} from "@prism/core/collab-commands";
import { HumanCommandFailure } from "@prism/core";
import { contextHeaders } from "../config";
import {
  humanNoteId,
  parseHumanCommand,
} from "../../../../packages/core/src/lib/collab/human/validation";
import { gatewayOrigin, serverFetch } from "../transport";

/** Internal confirmed state, NOT a proposed /commands/me response schema.
 * No production resolver exists yet. Hosts must keep this null until the
 * backend acknowledges an authoritative actor AND resolved audience contract. */
export interface HumanCommandAudience {
  origin: string;
  workspace: string;
  vault: string;
  actorId: string;
  /** Hash/fingerprint only; never persisted raw credentials. */
  credentialKey: string;
}
export interface HumanCommandContext {
  audience: HumanCommandAudience;
  capabilityToken: string | null;
}
export const humanAudienceKey = (value: HumanCommandAudience) =>
  JSON.stringify([
    value.origin,
    value.workspace,
    value.vault,
    value.actorId,
    value.credentialKey,
  ]);
export class HumanCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly outcome: "not-sent" | "unknown" | "refused",
    readonly status?: number,
    readonly retryAt?: number,
  ) {
    super(message);
  }
}
function contextKey(context: HumanCommandContext | null): string | null {
  if (!context) return null;
  const values = Object.values(context.audience);
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        !value ||
        value.length > 2048 ||
        /[\u0000-\u001f\u007f]/.test(value),
    )
  )
    return null;
  return JSON.stringify([
    humanAudienceKey(context.audience),
    context.capabilityToken,
  ]);
}
function retryTime(
  response: Response,
  body: Record<string, unknown>,
): number | undefined {
  const header = response.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Date.now() + seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(Date.now(), date);
  }
  return typeof body.retryAfter === "number" &&
    Number.isFinite(body.retryAfter) &&
    body.retryAfter >= 0
    ? Date.now() + body.retryAfter * 1000
    : undefined;
}
/** Caller owns durable reservation. This transport never serializes a retry,
 * writes a Y.Doc, guesses identity, or auto-replays a failed request. */
export function humanCommandsFor(
  noteId: string,
  options: {
    current: () => HumanCommandContext | null;
    revalidate: () => Promise<HumanCommandContext | null>;
  },
) {
  return async (body: string): Promise<HumanCollabResult> => {
    const command = parseHumanCommand(body);
    if (!humanNoteId(noteId) || !command)
      throw new HumanCommandError(
        "This submission is invalid. Review the draft before trying again.",
        "invalid_command",
        "not-sent",
      );
    const initial = options.current();
    const binding = contextKey(initial);
    if (!initial || !binding)
      throw new HumanCommandError(
        "Command identity is not available yet. Your draft can be prepared, but nothing will be sent.",
        "identity_unavailable",
        "not-sent",
      );
    const expectedOrigin = new URL(gatewayOrigin() || location.origin).origin;
    if (initial.audience.origin !== expectedOrigin)
      throw new HumanCommandError(
        "The document belongs to another server. Reopen it before submitting.",
        "audience_changed",
        "not-sent",
      );
    const fresh = await options.revalidate();
    if (
      contextKey(fresh) !== binding ||
      contextKey(options.current()) !== binding
    )
      throw new HumanCommandError(
        "Workspace, account, or link access changed. Reopen the original document to recover this draft.",
        "audience_changed",
        "not-sent",
      );
    const query = initial.capabilityToken
      ? `?t=${encodeURIComponent(initial.capabilityToken)}`
      : "";
    let response: Response;
    try {
      response = await serverFetch(
        `${humanCollabCommandPath(noteId)}${query}`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Prism-Vault": initial.audience.vault,
            "X-Prism-Workspace": initial.audience.workspace,
          },
          body,
        },
      );
    } catch {
      throw new HumanCommandError(
        "The submission's outcome is unknown. Keep this request and check the same submission when connected.",
        "network_error",
        "unknown",
      );
    }
    let payload: Record<string, unknown> = {};
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        payload = parsed;
    } catch {
      /* A malformed response cannot confirm a mutation. */
    }
    if (contextKey(options.current()) !== binding)
      throw new HumanCommandError(
        "The audience changed while awaiting confirmation. Recover this request only in its original document and audience.",
        "audience_changed",
        "unknown",
        response.status,
      );
    if (!response.ok) {
      const code =
        typeof payload.error === "string"
          ? payload.error
          : "unconfirmed_response";
      const fallback =
        response.status === 429
          ? "This document is receiving too many changes. Wait before checking this same submission."
          : "The server could not confirm this change. Keep the request until its outcome is known.";
      throw new HumanCommandError(
        typeof payload.message === "string"
          ? payload.message.slice(0, 1000)
          : fallback,
        code,
        response.status >= 500 || !payload.error ? "unknown" : "refused",
        response.status,
        retryTime(response, payload),
      );
    }
    const validId = (value: unknown) =>
      typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
    const valid =
      response.status === 200 &&
      payload.requestId === command.requestId &&
      payload.kind === command.kind &&
      (command.kind === "suggest"
        ? validId(payload.suggestionId)
        : validId(payload.threadId)) &&
      (command.kind === "suggest" ||
        command.kind === "comment" ||
        payload.threadId === command.threadId) &&
      (!["comment", "reply"].includes(command.kind) ||
        validId(payload.commentId)) &&
      (command.kind !== "resolve" || payload.resolved === command.resolved);
    if (!valid)
      throw new HumanCommandError(
        "The response did not confirm this exact submission. Keep it and check the same request.",
        "invalid_response",
        "unknown",
        response.status,
      );
    return payload as unknown as HumanCollabResult;
  };
}

/**
 * The command transport the live editor uses (NP-CO-12 activation). One POST per
 * call, never retried automatically: the composer decides, and a retry passes
 * the SAME command object (same requestId and body), which the server applies at
 * most once. Throws `HumanCommandFailure` for anything but a confirmed 200 whose
 * ids match this exact request — ids are only ever read from a 200.
 *
 * Credentials ride the normal transport (cookie on the PWA, device bearer in the
 * native shell); a capability link's token is sent as `?t=` exactly like the
 * socket's. The workspace headers are the active context's (absent for a link
 * guest, so the server binds the request to the link's own vault).
 */
export function sendHumanCommand(noteId: string, capabilityToken: string | null) {
  return async (command: HumanCollabCommand): Promise<HumanCollabResult> => {
    const body = JSON.stringify(command);
    if (!humanNoteId(noteId) || !parseHumanCommand(body))
      throw new HumanCommandFailure("This change can’t be sent as written.", "invalid_command", "not-sent");
    const query = capabilityToken ? `?t=${encodeURIComponent(capabilityToken)}` : "";
    let response: Response;
    try {
      response = await serverFetch(`${humanCollabCommandPath(noteId)}${query}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(capabilityToken ? {} : contextHeaders()) },
        body,
      });
    } catch {
      throw new HumanCommandFailure("You appear to be offline.", "network_error", "unknown");
    }
    let payload: Record<string, unknown> = {};
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      /* a malformed body cannot confirm anything */
    }
    if (!response.ok) {
      const code = (typeof payload.error === "string" ? payload.error : "upstream_error") as HumanCollabErrorCode;
      const message = typeof payload.message === "string" ? payload.message.slice(0, 500) : "The change could not be confirmed.";
      const unknown = response.status >= 500 || !payload.error;
      throw new HumanCommandFailure(message, code, unknown ? "unknown" : "refused", response.status, retryTime(response, payload) ? retryTime(response, payload)! - Date.now() : undefined);
    }
    const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
    const ok =
      payload.requestId === command.requestId &&
      payload.kind === command.kind &&
      (command.kind === "suggest" ? validId(payload.suggestionId) : validId(payload.threadId)) &&
      (command.kind === "suggest" || command.kind === "comment" || payload.threadId === command.threadId) &&
      (!["comment", "reply"].includes(command.kind) || validId(payload.commentId)) &&
      (command.kind !== "resolve" || payload.resolved === command.resolved);
    if (!ok) throw new HumanCommandFailure("The reply did not confirm this change.", "invalid_response", "unknown", response.status);
    return payload as unknown as HumanCollabResult;
  };
}
