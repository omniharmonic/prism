/**
 * Simulate N idle Prism clients against a SANDBOX server so the vault request rate can be
 * compared before/after WP7.2 (see docs/events.md "Measuring").
 *
 *   node --import tsx scripts/measure-idle-clients.ts --base http://127.0.0.1:8899 \
 *        --token <bearer: device token pd_… or owner session cookie via --cookie> \
 *        --clients 3 --mode poll|events --seconds 120
 *
 *  poll   = the pre-WP7.2 cadence: each client re-lists message-thread (30 s), email (30 s),
 *           person (60 s), skills (30 s) and dispatches (20 s) notes through the gateway.
 *  events = each client only holds one `GET /api/events` stream open (what an idle client does now),
 *           plus the slow 5-min safety-net list.
 *
 * Run the server with PRISM_VAULT_TRACE=1 and count vault calls in its log for the window:
 *   grep -c '\[trace\]' server.log
 * REFUSES :1940 and :8787 (the live vault / prod server).
 */
const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg("base", "")!;
const token = arg("token");
const cookie = arg("cookie");
const clients = Number(arg("clients", "3"));
const mode = arg("mode", "events");
const seconds = Number(arg("seconds", "120"));
if (!base || /:(1940|8787)(\/|$)/.test(base)) {
  console.error("Give --base of a sandbox server (never :1940 / :8787).");
  process.exit(2);
}
const headers: Record<string, string> = {};
if (token) headers.Authorization = `Bearer ${token}`;
if (cookie) headers.cookie = cookie;

const POLLS: Array<[string, number]> = [
  ["/api/notes?tag=message-thread&limit=500", 30_000],
  ["/api/notes?tag=email&limit=200", 30_000],
  ["/api/notes?tag=person&limit=2000", 60_000],
  ["/api/notes?tag=agent-skill&limit=200", 30_000],
  ["/api/notes?tag=agent-dispatch&limit=100", 20_000],
];
const SAFETY_NET = 300_000;

const ac = new AbortController();
setTimeout(() => ac.abort(), seconds * 1000).unref?.();
let requests = 0;
const get = async (path: string) => {
  requests++;
  await fetch(base + path, { headers, signal: ac.signal }).then((r) => r.arrayBuffer()).catch(() => {});
};

async function stream() {
  requests++;
  try {
    const r = await fetch(`${base}/api/events`, { headers, signal: ac.signal });
    if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
    const reader = r.body.getReader();
    while (!(await reader.read()).done) {
      /* idle */
    }
  } catch (e) {
    if (!ac.signal.aborted) console.warn(`stream ended: ${(e as Error).message}`);
  }
}

const tasks: Promise<unknown>[] = [];
for (let c = 0; c < clients; c++) {
  if (mode === "events") tasks.push(stream());
  for (const [p, every] of POLLS) {
    const period = mode === "poll" ? every : SAFETY_NET;
    tasks.push(
      (async () => {
        while (!ac.signal.aborted) {
          await get(p);
          await new Promise((r) => {
            const t = setTimeout(r, period + Math.random() * 1000);
            ac.signal.addEventListener("abort", () => (clearTimeout(t), r(undefined)), { once: true });
          });
        }
      })(),
    );
  }
}
await Promise.allSettled(tasks);
console.log(`mode=${mode} clients=${clients} window=${seconds}s client->server requests=${requests} (${(requests / seconds).toFixed(2)}/s)`);
console.log("Now count vault calls in the sandbox server log: grep -c '\\[trace\\]' (PRISM_VAULT_TRACE=1). Owner reads are coalesced (5 s), so compare the vault-side count, not this one.");
