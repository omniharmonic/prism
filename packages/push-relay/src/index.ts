/**
 * Prism Push Relay — the Cloudflare Worker entry (decision D-I).
 *
 * The App Store build of the Prism Client receives APNs only from a provider that
 * holds the publisher's APNs key. A self-hosted Prism Server cannot hold that key,
 * so it registers with this relay and sends `{deviceToken, environment, kind, id}`;
 * the relay writes the notification itself (fixed generic copy, ids only) and
 * sends it to Apple. See README.md and docs/push.md § Relay.
 *
 * Cloudflare types are declared minimally below (no @cloudflare/workers-types
 * dependency): only what this file uses.
 */
import { createRelay, type RelayEnv } from "./relay";
import { runShard, type ShardOp, type ShardStorage } from "./shard";

interface DurableObjectId {
  toString(): string;
}
interface DurableObjectStub {
  fetch(input: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectState {
  storage: ShardStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export interface Env extends RelayEnv {
  RELAY_SHARD: DurableObjectNamespace;
}

/**
 * One instance per name (`srv:<id>`, `dev:<hash>`, `ip:<hash>`). A Durable Object
 * handles one request at a time per instance (input gates), so every
 * check-and-increment in shard.ts is atomic without any locking here.
 */
export class RelayShard {
  constructor(private readonly state: DurableObjectState, _env: Env) {}
  async fetch(req: Request): Promise<Response> {
    const op = (await req.json()) as ShardOp;
    const r = await runShard(this.state.storage, op);
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const handler = createRelay({
      env,
      shard: async (name, op) => {
        const stub = env.RELAY_SHARD.get(env.RELAY_SHARD.idFromName(name));
        const res = await stub.fetch("https://shard/op", { method: "POST", body: JSON.stringify(op), headers: { "content-type": "application/json" } });
        return res.json() as Promise<Awaited<ReturnType<typeof runShard>>>;
      },
      fetch: (url, init) => fetch(url, init),
    });
    return handler(req);
  },
};
