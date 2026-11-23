/** Comms: owner-only messaging API module. Public declarations. */
export const COMMS_CAPABILITIES = {
  integration: "comms",
  clientId: "comms-native",
  restricted: true,
  schemaVersions: [1],
  operations: ["threads:read", "messages:read", "media:read", "stream:read"],
  networks: ["whatsapp", "telegram", "discord", "messenger", "x", "signal", "slack", "instagram", "linkedin", "matrix", "imessage", "sms"],
} as const;
