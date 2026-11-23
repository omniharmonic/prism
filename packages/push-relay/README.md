# Prism Push Relay

A small Cloudflare Worker that lets **self-hosted** Prism Servers notify the App Store build of
the Prism iPhone app (decision D-I in `docs/roadmap/one-download-setup.md`).

APNs takes notifications for an app only from a provider holding the publisher's APNs key. A
self-hosted server cannot have that key. It registers with this relay and sends
`{deviceToken, environment, kind, id}`; the relay writes the notification itself with fixed,
generic copy and sends it to Apple. The publisher's own server has the key and sends
directly. It never uses the relay.

The threat model (what the relay can and cannot see) is in `docs/push.md` § Relay.

## API

All bodies are JSON. Signed requests carry `X-Relay-Server`, `X-Relay-Timestamp` (unix ms),
`X-Relay-Nonce` and `X-Relay-Signature`. The signature is Ed25519 over:

```
prism-push-relay-v1\n<METHOD>\n<PATH>\n<TIMESTAMP>\n<NONCE>\n<hex sha256(body)>
```

| Route | Auth | Result |
|---|---|---|
| `GET /health` | none | `{ok, apns}` (`apns` = the APNs secrets are usable) |
| `POST /v1/servers` `{publicKey}` | signed with that key (+ `Bearer REGISTRATION_SECRET` when set) | `201 {serverId}`; idempotent |
| `GET /v1/servers/self` | signed | `{serverId, createdAt, revoked:false}` |
| `DELETE /v1/servers/self` | signed | `{serverId, revoked:true}` (self-revoke) |
| `POST /v1/send` `{deviceToken, environment, kind, id?}` | signed | `{result:"sent"}` · `{result:"pruned", reason}` (the token is dead; drop it) · `{result:"failed", reason}` |
| `GET /v1/admin/servers/:id` | `Bearer ADMIN_TOKEN` | the record |
| `POST /v1/admin/servers/:id/revoke` · `…/restore` | `Bearer ADMIN_TOKEN` | the record |

The send schema is strict:

- `kind` is one of four values:
  - `notification`: `id` is the notification id, `[A-Za-z0-9_-]{1,64}`.
  - `agent`: `id` is the agent session id, a uuid.
  - `agent-attention`: the same id rule as `agent`.
  - `test`: no `id`.
- `environment` is `production` or `sandbox`.
- `deviceToken` is hex, 64 to 200 characters.
- **Any other key refuses the request.** There is no field for text, a title, a URL or a
  payload.

The bodies the relay sends to Apple are the Prism Server's own generic notifications
(`apps/server/src/apns.ts`).

Errors:

- `401 unauthorized`: one answer for an unknown server, a bad signature, a timestamp more
  than 5 minutes off, or a replayed nonce.
- `403 revoked`.
- `429 rate_limited` with `scope` (`server` | `device` | `registration`) and `Retry-After`.
- `503 unavailable` with `Retry-After`: APNs answered 429, 5xx or 403, or did not answer.
  Retry later.
- `503 paused` / `503 apns_unconfigured`.
- `400` / `413`. A body may be at most 1 KB, and a query string is never accepted.

## Design choices

- **Ed25519 request signing, not a shared secret.**
  - The relay stores public keys only, so a leak of its storage lets nobody send as a server.
  - A server's id is derived from its key (`base64url(sha256(raw key))[0..22]`), so an id can
    never be re-pointed at another key.
  - Each request is bound to its method, path and body. A timestamp window plus a nonce kept
    for 15 minutes stops replay.
  - Registering is proof of possession: the request is signed by the key being registered.
- **Durable Objects for state, not KV.** A rate limit is a read-modify-write counter that must
  be exact. KV is eventually consistent and takes about one write per second per key. A
  Durable Object handles one request at a time per name, so each check-and-increment is
  atomic. There are three shard kinds:
  - `srv:<id>`: the record, its nonces and its send counters.
  - `dev:<sha256(token)>`: a token's counters, shared across servers, plus each sending
    server's share of them (servers with no live window are forgotten; at most 64 tracked).
  - `ip:<sha256(ip)>`: registration counters.
- **No device token is stored.** Its SHA-256 only names a shard.
- **Provider token.** Every isolate signs a JWT whose `iat` is the start of the current
  30-minute bucket. All copies therefore change together once per 30 minutes. That meets
  Apple's "not more often than every 20 minutes, not older than 60" without any coordination.

Default limits (`wrangler.jsonc` vars):

| Limit | Default |
|---|---|
| Sends per server, per minute | 120 |
| Sends per server, per day | 20 000 |
| Sends per device token (across servers), per minute | 10 |
| Sends per device token (across servers), per hour | 120 |
| One server's share of a device token's budget, per minute / hour (`DEVICE_SERVER_SENDS_PER_MINUTE` / `_PER_HOUR`) | half the device's (5 / 60), never above it |
| Registrations per IP, per day (charged only after the request's signature verified) | 5 |

Abuse controls:

- the per-token limit, and each server's share inside it: one server (a compromised or
  misbehaving one) cannot use up the budget another server needs to reach the same device
  (`429 {scope: "device_server"}`);
- the per-server limit;
- `REGISTRATION_SECRET`, which makes the relay invite-only. **Recommended for any public
  relay**: without it anyone can register a server (5 per IP per day) and spend the relay's
  APNs standing. The default stays open (decision recorded in the launch plan), so a relay run
  for a closed group should set it;
- cheap refusals before any Durable Object is touched: malformed signing headers and a
  timestamp outside ±5 min answer 401 at the edge; a registration's signature is verified
  before the per-IP budget is charged, so unsigned junk from a shared address cannot use it up;
- bodies read as a stream with a 1 KB cap (a larger declared length is refused unread, a
  chunked body is cancelled at the cap, never buffered whole);
- admin revoke;
- the `RELAY_PAUSED=true` kill switch.

## Tests

```bash
npm run test -w @prism/push-relay       # fake APNs, in-memory shards — no network
npm run typecheck -w @prism/push-relay
```

`apps/server/test/push-relay.test.ts` also runs the Prism Server's real sender against this
relay's real handler.

## Deploy (the owner; nothing in the repo deploys it)

1. Install Wrangler and sign in (`npx wrangler login`). Wrangler is not a repo dependency.
2. Set the secrets from this directory:
   ```bash
   npx wrangler secret put APNS_KEY_P8      # paste the whole AuthKey_XXXXXXXXXX.p8 (PEM)
   npx wrangler secret put APNS_KEY_ID      # 10-character key id
   npx wrangler secret put APNS_TEAM_ID     # 10-character team id
   npx wrangler secret put APNS_TOPIC       # the App Store app's bundle id
   npx wrangler secret put ADMIN_TOKEN      # a long random string (openssl rand -base64 32)
   npx wrangler secret put REGISTRATION_SECRET   # recommended for a public relay: invite-only registration
   ```
   Durable Objects need the Workers Paid plan or the SQLite-backed free tier. The migration in
   `wrangler.jsonc` uses `new_sqlite_classes`.
3. Deploy: `npx wrangler deploy`. Optionally attach a custom domain, for example
   `push.<your domain>`.
4. **Prove APNs from the Worker.** APNs is HTTP/2 only, and Cloudflare does not document which
   HTTP version a Worker's outbound `fetch()` uses toward an origin. This has not been verified
   against Apple. Check it end to end:
   1. On a test Prism Server with **no** `APNS_*` values, set `PUSH_RELAY_URL=https://<relay>`.
   2. Run `npm run push-relay:register -w @prism/server` and restart the server.
   3. Sign the iPhone app in to that server and turn notifications on.
   4. Tap "Send a test notification".
   5. Run `npx wrangler tail` and expect `[relay] send <id> test sent`.

   An `unavailable Network` or `unavailable 400`-style failure on every send means the fetch
   path cannot reach APNs. The fallback is then a small HTTP/2 forwarder, which is a design
   change and not a configuration change.
5. Publish the relay URL in the self-host docs. Self-hosters set `PUSH_RELAY_URL` and run the
   register command. Hand `REGISTRATION_SECRET` out when the relay is invite-only.

Revoking a server:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<relay>/v1/admin/servers/<serverId>/revoke
```

Use `…/restore` to undo a revoke.
