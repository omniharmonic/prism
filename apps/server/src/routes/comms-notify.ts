// Comms read state + notifications (Sprint Task 1). Mounted on commsApi (routes/comms.ts); every
// handler starts with requireCommsOwner. Writes are JSON + csrfRefusal (a device bearer passes).
//
//   POST   /api/comms/threads/:id/read      {upTo?: ISO, viewing?: bool, explicit?: bool} → {thread, receipt}
//   POST   /api/comms/threads/:id/unread    {}                          → {thread}
//   GET    /api/comms/notifications/settings                            → {settings, available, devices[]}
//          devices[]: {platform, environment, thisDevice, registeredAt, lastSeenAt,
//                      lastDelivery: {status, reason, outcome, at} | null} (what APNs last answered)
//   POST   /api/comms/notifications/test    {}  → {devices[]} (a fixed test alert to each device; 503 push_unavailable)
//   PUT    /api/comms/notifications/settings  <partial settings>        → {settings, available}
//          (merged key by key; `folders: {<folderId>: "default"|"all"|"none"}` — "default" removes the rule)
//   POST   /api/comms/devices/apns          {token, environment, platform} → {ok, pushEnabled}
//   DELETE /api/comms/devices/apns                                       → {ok}
//
// `viewing` (read): true = this device shows the thread now (a 90 s lease, renewed by the app while
// the thread is on screen) — no push for it meanwhile; false = it closed.
// `explicit` = the owner's own "Mark as Read" (row action): it sends a receipt where the network
// supports it even with the receipts toggle off (D10 ruling); opening/viewing never does.
// `receipt`: sent | off | unsupported | nothing | failed — see comms/read-state.ts (D10 gates).
import { isForumThread, resolveThreadRedirect } from "../comms/forums";
import type { Context } from "hono";
import { requireCommsOwner } from "../comms/guard";
import { appendEvent, getThread } from "../comms/store";
import { threadOut } from "../comms/timeline";
import { markThreadRead, markThreadUnread, markTopicRead, maybeSendReceipt, setViewing } from "../comms/read-state";
import { getNotifySettings, invalidNotifySettingsKey, unknownFolderIds, updateNotifySettings } from "../comms/notify-settings";
import { actionOrigin, csrfRefusal, readCapped } from "./actions";
import { requestVia } from "../auth/actor";
import { config } from "../config";
import {
  apnsApplicationForDevice, apnsEnabled, isApnsEnvironment, isApnsToken, isCommsPlatform, liveCommsApnsTokens, removeCommsApnsTokenForDevice, saveCommsApnsToken,
} from "../apns";
import { lastDelivery, sendTestNotification } from "../comms/notify";
import { consumeRateLimit } from "../middleware/ratelimit";

const MAX_BODY = 4096;
const MAX_THREAD_ID = 200;

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const raw = await readCapped(c.req.raw, MAX_BODY);
  if (raw === null) return null;
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const available = () => ({
  push: config.commsNotifyEnabled && apnsEnabled("comms"),
  readReceipts: config.commsReadReceiptsEnabled,
});

export async function postRead(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const id = resolveThreadRedirect(c.req.param("id") ?? "");
  if (!id || id.length > MAX_THREAD_ID || !getThread(id)) return c.json({ error: "thread_unavailable" }, 404);
  const b = await jsonBody(c);
  if (!b) return c.json({ error: "invalid", detail: "JSON object body required" }, 422);
  if (b.upTo !== undefined && (typeof b.upTo !== "string" || b.upTo.length > 40 || !Number.isFinite(Date.parse(b.upTo))))
    return c.json({ error: "invalid", detail: "upTo must be an ISO date" }, 422);
  if (b.viewing !== undefined && typeof b.viewing !== "boolean") return c.json({ error: "invalid", detail: "viewing must be a boolean" }, 422);
  if (b.explicit !== undefined && typeof b.explicit !== "boolean") return c.json({ error: "invalid", detail: "explicit must be a boolean" }, 422);
  if (b.topic !== undefined && (typeof b.topic !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.topic))) return c.json({ error: "invalid", detail: "topic must be a topic id" }, 422);
  const explicit = b.explicit === true;
  // A Telegram forum topic (fix round 1, I-4): only that topic's read point moves.
  const forum = typeof b.topic === "string" && isForumThread(id);
  const tr = forum ? markTopicRead(id, b.topic as string, b.upTo as string | undefined) : null;
  if (forum && !tr) return c.json({ error: "topic_unavailable" }, 404);
  const r = tr ?? markThreadRead(id, b.upTo as string | undefined);
  if (!r) return c.json({ error: "thread_unavailable" }, 404);
  if (b.viewing !== undefined) setViewing(id, g.actor.deviceId ?? `session:${g.actor.email}`, b.viewing as boolean);
  // A receipt for a read that moved the marker, or for an explicit Mark as Read (even when it did
  // not move: the thread may have been opened — read locally, no receipt — just before).
  const { via, origin } = actionOrigin(c);
  const receipt = r.changed || explicit
    ? await maybeSendReceipt(id, g.vaultId, {
        humanDevice: via === "device" && origin === "human", explicit, readAt: r.readAt,
        ...(isForumThread(id) ? { before: r.before, topic: tr?.topic ?? null } : {}),
      })
    : "nothing";
  const thread = getThread(id);
  return c.json({ thread: thread ? threadOut(thread, g.actor) : null, receipt });
}

export async function postUnread(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const id = resolveThreadRedirect(c.req.param("id") ?? "");
  if (!id || id.length > MAX_THREAD_ID || markThreadUnread(id) === null) return c.json({ error: "thread_unavailable" }, 404);
  const thread = getThread(id);
  return c.json({ thread: thread ? threadOut(thread, g.actor) : null });
}

/**
 * The owner's registered Comms devices and what APNs last answered for each (owner-testing round
 * 4: "notifications seem off on iOS"). Platform, APNs environment, dates, status + Apple's reason;
 * never the token or anything from a message.
 */
function devicesOut(email: string, thisDevice: string | undefined) {
  return liveCommsApnsTokens(email).map((r) => {
    const d = lastDelivery(r.device_id);
    return {
      platform: r.platform,
      environment: r.environment,
      thisDevice: r.device_id === thisDevice,
      registeredAt: new Date(r.created_at).toISOString(),
      lastSeenAt: new Date(r.last_seen_at).toISOString(),
      lastDelivery: d ? { status: d.status, reason: d.reason, outcome: d.outcome, at: new Date(d.at).toISOString() } : null,
    };
  });
}

export function getSettings(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  return c.json({ settings: getNotifySettings(), available: available(), devices: devicesOut(g.actor.email, g.actor.deviceId) });
}

/** `POST /notifications/test` — a fixed "Notifications are working" alert to each of the owner's
 *  Comms devices; answers what APNs said per device. A person's tap only; 5 per 10 minutes. */
export async function postTestNotification(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const { origin } = actionOrigin(c);
  if (origin !== "human") return c.json({ error: "agent_origin_refused" }, 403);
  const retry = consumeRateLimit(`comms-notify-test:${g.actor.email}`, 5, 10 * 60_000);
  if (retry !== null) {
    c.header("Retry-After", String(retry));
    return c.json({ error: "rate_limited" }, 429);
  }
  const results = await sendTestNotification();
  if (!results) return c.json({ error: "push_unavailable" }, 503);
  return c.json({ devices: devicesOut(g.actor.email, g.actor.deviceId) });
}

export async function putSettings(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const csrf = csrfRefusal(c, requestVia(c));
  if (csrf) return csrf;
  const b = await jsonBody(c);
  if (!b) return c.json({ error: "invalid", detail: "JSON object body required" }, 422);
  const bad = invalidNotifySettingsKey(b);
  if (bad) return c.json({ error: "invalid", detail: `bad setting: ${bad.slice(0, 60)}` }, 422);
  // Settings change what reaches the lock screen and what the networks see: a person's choice only.
  const { origin } = actionOrigin(c);
  if (origin !== "human") return c.json({ error: "agent_origin_refused" }, 403);
  // A folder rule names an owner folder that exists (deleted meanwhile on another device → 422).
  const gone = unknownFolderIds(b);
  if (gone.length) return c.json({ error: "invalid", detail: `bad setting: folders.${gone[0]!.slice(0, 60)}` }, 422);
  const settings = updateNotifySettings(b);
  // Folder rules show in every device's folder menus: announced like a folder change (clients
  // refetch folders + settings). Other settings are read when the Settings screen opens.
  if (b.folders !== undefined) appendEvent("thread.updated", null, { threadId: null, reason: "folders" });
  return c.json({ settings, available: available() });
}

/** The Comms app's own device credential (`pd_…` of comms-native), else null. */
function commsDevice(c: Context, g: { actor: { deviceId?: string } }): string | null {
  if (requestVia(c) !== "device") return null;
  const id = g.actor.deviceId;
  return id && apnsApplicationForDevice(id) === "comms" ? id : null;
}

export async function postDeviceApns(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const deviceId = commsDevice(c, g);
  if (!deviceId) return c.json({ error: "device_token_required" }, 403);
  const csrf = csrfRefusal(c, "device");
  if (csrf) return csrf;
  const b = await jsonBody(c);
  if (!b || !isApnsToken(b.token) || !isApnsEnvironment(b.environment) || !isCommsPlatform(b.platform))
    return c.json({ error: "invalid", detail: "token (hex) + environment (sandbox|production) + platform (ios|macos) required" }, 422);
  saveCommsApnsToken({ deviceId, token: b.token, environment: b.environment, platform: b.platform, email: g.actor.email, vaultId: g.vaultId });
  return c.json({ ok: true, pushEnabled: available().push });
}

export function deleteDeviceApns(c: Context) {
  const g = requireCommsOwner(c);
  if (!g.ok) return g.res;
  const deviceId = commsDevice(c, g);
  if (!deviceId) return c.json({ error: "device_token_required" }, 403);
  return c.json({ ok: removeCommsApnsTokenForDevice(deviceId) });
}
