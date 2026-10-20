/**
 * Register this Prism Server with the push relay (decision D-I, docs/push.md § Relay).
 *
 *   npm run push-relay:register -w @prism/server   make the key (if none) + register
 *   npm run push-relay:status   -w @prism/server   ask the relay whether it knows us
 *   npm run push-relay:revoke   -w @prism/server   withdraw this server's registration
 *
 * Reads PUSH_RELAY_URL (and PUSH_RELAY_KEY_PATH, default beside DB_PATH) from
 * apps/server/.env. An invite-only relay also needs PUSH_RELAY_REGISTRATION_SECRET
 * in the environment (never on the command line, where `ps` shows it). The
 * private key is written once, 0600, never printed; the relay learns the PUBLIC
 * key only. Restart the server afterwards so it picks the key up.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { relayBaseUrl, relayCall, relayKey, relayKeyPath } from "../src/push-relay";

const cmd = process.argv[2] ?? "register";

function fail(msg: string): never {
  console.error(`push-relay: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!relayBaseUrl()) fail("set PUSH_RELAY_URL in apps/server/.env (an https URL) first");
  const path = relayKeyPath();
  if (!path) fail("no key path: set PUSH_RELAY_KEY_PATH (or DB_PATH to a file)");
  if (cmd === "register" && !existsSync(path)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    // wx: never overwrite a key someone else just wrote.
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600, flag: "wx" });
    console.log(`push-relay: made a new relay key at ${path} (0600)`);
  }
  const key = relayKey();
  if (!key.ok) fail(key.reason);

  if (cmd === "register") {
    const secret = process.env.PUSH_RELAY_REGISTRATION_SECRET?.trim();
    const res = await relayCall("POST", "/v1/servers", JSON.stringify({ publicKey: key.publicKey }), {
      key,
      extraHeaders: secret ? { authorization: `Bearer ${secret}` } : {},
    });
    if (res.status === 201) {
      console.log(`push-relay: registered as server ${key.serverId}. Restart the Prism Server to send through the relay.`);
      return;
    }
    if (res.status === 401 && res.body.includes("registration_closed")) fail("this relay is invite-only: set PUSH_RELAY_REGISTRATION_SECRET in the environment and try again");
    if (res.status === 403) fail("this server's key was revoked at the relay; ask the relay operator, or move the key file away and register a new one");
    if (res.status === 429) fail(`too many registrations from this address; try again in ${res.retryAfterS ?? 60} s`);
    fail(`the relay answered ${res.status}`);
  }
  if (cmd === "status") {
    const res = await relayCall("GET", "/v1/servers/self", undefined, { key });
    if (res.status === 200) return void console.log(`push-relay: registered as server ${key.serverId}`);
    if (res.status === 403) fail(`server ${key.serverId} is revoked at the relay`);
    if (res.status === 401) fail(`the relay does not know server ${key.serverId} — run push-relay:register`);
    fail(`the relay answered ${res.status}`);
  }
  if (cmd === "revoke") {
    const res = await relayCall("DELETE", "/v1/servers/self", undefined, { key });
    if (res.status === 200) return void console.log(`push-relay: server ${key.serverId} is revoked at the relay. Its key can no longer send.`);
    fail(`the relay answered ${res.status}`);
  }
  fail(`unknown command "${cmd}" (register | status | revoke)`);
}

main().catch((e) => fail(e instanceof Error ? e.message : "failed"));
