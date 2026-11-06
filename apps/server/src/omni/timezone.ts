/** The Omni module's zone: OMNI_TZ when valid, else the host's zone, else UTC. Read per call so tests can set OMNI_TZ; never throws. */
const valid = (tz: string | undefined): tz is string => { if (!tz) return false; try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
export function omniTimeZone(): string {
  if (valid(process.env.OMNI_TZ)) return process.env.OMNI_TZ;
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return valid(host) ? host : "UTC";
}
