/** When and how a card interrupts. Content is built per device and never enters the notice bus. */
import type { ApnsNotification, NotificationPreview } from "../apns";
import type { Card } from "./cards";
import { nudgeSettings } from "./nudges";
import { attentionPreferences } from "./attention-preferences";
import { localClock, withinQuietHours } from "./nudge-policy";
import { cardAlert } from "./push-text";

/** Off, the kill switch and quiet hours hold every card push (same owner settings as nudges). */
export function cardPushAllowed(owner: string, now: number = Date.now()): boolean {
  const s = nudgeSettings(owner);
  if (s.killed || s.dial === "off") return false;
  const quiet = attentionPreferences(owner).quiet_hours;
  return !(quiet && withinQuietHours(quiet, localClock(now)));
}

export function cardNotification(c: Card, preference: NotificationPreview, genericBody: string): ApnsNotification {
  return {
    payload: {
      aps: { alert: cardAlert(c, preference, genericBody), sound: "default", "interruption-level": "active", category: "OMNI_CARD", "thread-id": "omni-cards" },
      type: "omni", category: "OMNI_CARD", id: c.id, url: `omni://card/${encodeURIComponent(c.id)}`,
    },
    collapseId: `omni-card-${c.id}`.slice(0, 64),
  };
}
