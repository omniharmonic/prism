/**
 * The server settings `prism config set` may change in the install's `.env` (the host CLI), and
 * which of them open a way OUT — a message, an email, a calendar change — to someone else.
 *
 * Dependency-free: the host CLI bundles this file, and the server's setup checklist names the same
 * keys in its sentences. Only ON/OFF switches and a few plain values are here. Secrets
 * (`SESSION_SECRET`, `SECRETS_KEY`, `PARACHUTE_TOKEN`, …), sign-in routing (`APP_ORIGIN`,
 * `OWNER_EMAIL`, `RESEND_API_KEY`) and connection credentials are never settable this way:
 * credentials go into the app (Workspace settings → Server → Connections), the vault token
 * through `prism token`.
 *
 * THE ONE DOOR. Every message any Prism app sends leaves through the server, and only while the
 * switches for it are on. They are off on a new install. Turning one on is the person's decision:
 * `prism config set` refuses a send switch without `--confirm-send`, and the setup skills pass it
 * only after the person has said yes to that exact switch in their own words.
 */

export type HostConfigKind = "switch" | "loopback-url" | "bundle-id";

export interface HostConfigKey {
  key: string;
  kind: HostConfigKind;
  /** Turning it on lets the server send to other people (needs --confirm-send). */
  send?: boolean;
  /** One line a person can read. */
  about: string;
}

export const HOST_CONFIG_KEYS: readonly HostConfigKey[] = [
  // Comms (the messaging module the Comms app reads).
  { key: "COMMS_ENABLED", kind: "switch", about: "Comms: the messaging module and the Comms app's sign-in" },
  { key: "COMMS_NOTIFY_ENABLED", kind: "switch", about: "Comms: notifications for important threads on the Comms app" },
  { key: "COMMS_APNS_TOPIC", kind: "bundle-id", about: "Comms: the Comms app's bundle id (its notification topic)" },
  { key: "COMMS_PINS_ENABLED", kind: "switch", about: "Comms: pinned conversations" },
  { key: "COMMS_SEARCH_ENABLED", kind: "switch", about: "Comms: search across conversations" },
  { key: "COMMS_FOLDERS_ENABLED", kind: "switch", about: "Comms: your own folders" },
  { key: "COMMS_THREAD_ACTIONS_ENABLED", kind: "switch", about: "Comms: mute, archive and status from the app" },
  { key: "COMMS_TIDY_ENABLED", kind: "switch", about: "Comms: contact tidy-up" },
  { key: "COMMS_EMAIL_ENABLED", kind: "switch", about: "Comms: email threads shown in Comms (reading only)" },
  { key: "COMMS_OMNI_ENABLED", kind: "switch", about: "Comms: Omni's drafts shown in Comms (reading only)" },
  { key: "COMMS_RECEIPTS_ENABLED", kind: "switch", about: "Comms: delivery receipts shown in Comms" },
  { key: "COMMS_READ_RECEIPTS_ENABLED", kind: "switch", send: true, about: "Comms: tell other people when you have read their message" },
  { key: "COMMS_SYNC_LONGPOLL", kind: "switch", about: "Comms: faster Matrix sync (long polling)" },
  // iMessage and SMS through BlueBubbles Server on a Mac signed in to Messages.
  { key: "BLUEBUBBLES_ENABLED", kind: "switch", about: "iMessage/SMS: read through BlueBubbles Server on this Mac" },
  { key: "BLUEBUBBLES_URL", kind: "loopback-url", about: "iMessage/SMS: BlueBubbles Server's local address (default http://127.0.0.1:1235)" },
  // The send switches (the one door).
  { key: "COMMS_SEND_ENABLED", kind: "switch", send: true, about: "Sending from Comms at all (each network family needs its own switch too)" },
  { key: "ACTIONS_MATRIX_ENABLED", kind: "switch", send: true, about: "Sending chat messages through your Matrix bridges (WhatsApp, Signal, Telegram, Slack, …)" },
  { key: "COMMS_EMAIL_SEND_ENABLED", kind: "switch", send: true, about: "Sending email replies from Comms (through Omni's approved email door)" },
  { key: "ACTIONS_EMAIL_ENABLED", kind: "switch", send: true, about: "Prism live actions: sending email" },
  { key: "ACTIONS_CALENDAR_ENABLED", kind: "switch", send: true, about: "Prism live actions: creating and changing calendar events (invitations go out)" },
  // Ingest switches (reading only).
  { key: "CALENDAR_SYNC_ENABLED", kind: "switch", about: "Calendar sync into the vault (reading only)" },
  { key: "GMAIL_SYNC_ENABLED", kind: "switch", about: "Gmail sync into the vault (reading only)" },
  { key: "PROTON_SYNC_ENABLED", kind: "switch", about: "Proton Mail Bridge sync into the vault (reading only)" },
];

export const SEND_SWITCHES: readonly string[] = HOST_CONFIG_KEYS.filter((k) => k.send).map((k) => k.key);

export const hostConfigKey = (key: string): HostConfigKey | undefined => HOST_CONFIG_KEYS.find((k) => k.key === key);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The value as it will be written, or a sentence saying why it is refused. Switches take
 * true/false (also on/off, yes/no, 1/0); a BlueBubbles URL must be loopback http(s) with nothing
 * but a host and port; a bundle id is reverse-DNS.
 */
export function normaliseHostConfigValue(def: HostConfigKey, raw: string): { value: string } | { problem: string } {
  const v = raw.trim();
  if (def.kind === "switch") {
    const on = ["true", "on", "yes", "1"].includes(v.toLowerCase());
    const off = ["false", "off", "no", "0"].includes(v.toLowerCase());
    if (!on && !off) return { problem: `${def.key} is a switch: use true or false` };
    return { value: on ? "true" : "false" };
  }
  if (def.kind === "loopback-url") {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return { problem: `${def.key} must be a URL like http://127.0.0.1:1235` };
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !LOOPBACK.has(u.hostname.toLowerCase()) || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== ""))
      return { problem: `${def.key} must be a loopback http(s) address with a port and no path, like http://127.0.0.1:1235` };
    return { value: `${u.protocol}//${u.host}` };
  }
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v)) return { problem: `${def.key} must be a bundle id like com.example.comms` };
  return { value: v };
}
