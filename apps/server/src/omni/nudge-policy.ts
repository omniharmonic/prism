/** Pure M3 interrupt policy. Unknown calendar holds; unknown Focus uses standard OS-controlled notifications. */
export const DIALS = ["off", "conservative", "balanced", "eager"] as const;
export type Dial = typeof DIALS[number];
export interface NudgePolicyInput {
  score: number; priority: number; deadline: number | null; urgentAt: number | null;
  surfaces: number; lastSurfaceAt: number | null; snoozedUntil: number | null; dismissed: boolean;
}
export interface InterruptContext { observedAt: number; inMeeting: boolean; focus: "none" | "work" | "unknown"; meetingObservedAt?: number; focusObservedAt?: number }
export const MAX_SURFACES = 2;
export const CONTEXT_TTL = 5 * 60_000;
export const BARS: Record<Dial, number> = { off: Infinity, conservative: .6, balanced: .5, eager: .4 };
export const CAPS: Record<Dial, number> = { off: 0, conservative: 1, balanced: 2, eager: 4 };
const zone = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function localClock(ts: number): { date: string; hour: number; minute: number } {
  const p = Object.fromEntries(zone.formatToParts(ts).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
export function consequenceScore(base: number, deadline: number | null, commitment: boolean, penalty: number, now: number): number {
  const proximity = deadline === null ? 0 : deadline <= now ? .25 : deadline - now <= 86_400_000 ? .15 : deadline - now <= 7 * 86_400_000 ? .05 : 0;
  return Math.max(0, Math.min(1, base + proximity + (commitment ? .1 : 0) - penalty));
}
export function interruptDecision(n: NudgePolicyInput, context: InterruptContext | null, dial: Dial, killed: boolean, pushesLastHour: number, now: number): "now" | "digest" | "hold" | "later" {
  if (n.dismissed || n.surfaces >= MAX_SURFACES) return "later";
  if (killed || dial === "off" || (n.snoozedUntil ?? 0) > now || n.score < BARS[dial] && n.priority < .6) return "hold";
  if (!context || context.observedAt > now || now - context.observedAt > CONTEXT_TTL) return "hold";
  if (context.focus === "work" && now - (context.focusObservedAt ?? context.observedAt) <= CONTEXT_TTL) return "hold";
  if (pushesLastHour >= CAPS[dial] || n.lastSurfaceAt !== null && now - n.lastSurfaceAt < 4 * 3_600_000) return "hold";
  const clock = localClock(now);
  const recentUrgent = n.priority >= .7 && n.urgentAt !== null && n.urgentAt <= now && now - n.urgentAt <= 3_600_000;
  const deadlineToday = n.deadline !== null && localClock(n.deadline).date === clock.date;
  if (clock.hour >= 21 || clock.hour < 7) return recentUrgent && !context.inMeeting ? "now" : "hold";
  if (context.inMeeting) return n.score >= .85 && deadlineToday ? "now" : "hold";
  if (n.score >= .85 && (deadlineToday || recentUrgent)) return "now";
  // A five-minute window makes restart/timer jitter harmless. Repeat spacing prevents re-push within a slot.
  return [9, 11, 13, 15, 17].includes(clock.hour) && clock.minute < 5 ? "digest" : "hold";
}
