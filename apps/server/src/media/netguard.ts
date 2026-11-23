/**
 * SSRF guard for the media + map proxies (Client parity C).
 *
 * The server fetches URLs that come from note content (anyone with edit rights
 * can write one), so every outbound request must be provably aimed at the
 * public internet:
 *
 *  - `parseTarget` accepts only `https:` (or `http:` for an explicitly
 *    allowlisted host), the default/allowlisted port, a DNS NAME (an IP-literal
 *    host is refused outright — this sidesteps every decimal/hex/octal/short
 *    IPv4 spelling and IPv6 zone/mapped trick), no userinfo, and never the
 *    server's own origin or the vault/hub.
 *  - `resolvePublic` resolves the name ITSELF and refuses the whole answer set if
 *    ANY address is non-public (private, loopback, link-local, CGNAT, multicast,
 *    reserved, documentation, benchmarking, metadata, 0.0.0.0, IPv4-mapped /
 *    -compatible / NAT64 / 6to4 / Teredo IPv6 that embed one of those). The
 *    caller then connects to the returned address (pinned — no second lookup, so
 *    no DNS-rebinding TOCTOU).
 *
 * Pure apart from the injectable resolver (tests stub it; nothing here touches
 * the network in tests).
 */
import { Resolver as DnsResolver } from "node:dns/promises";
import { isIP } from "node:net";

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 (strict: exactly 4 decimal octets, no leading zeros). */
export function parseIPv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** Parse an IPv6 address (no zone id) into a 128-bit bigint; embedded dotted IPv4 tail allowed. */
export function parseIPv6(input: string): bigint | null {
  let s = input;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.includes("%")) return null; // zone ids are never acceptable
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const lastColon = s.lastIndexOf(":");
  if (lastColon < 0) return null;
  if (s.slice(lastColon + 1).includes(".")) {
    // Embedded dotted IPv4 tail (::ffff:127.0.0.1) → two hex groups.
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const toGroups = (x: string): number[] | null => {
    if (x === "") return [];
    const out: number[] = [];
    for (const g of x.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(dbl[0] ?? "");
  const rest = dbl.length === 2 ? toGroups(dbl[1] ?? "") : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return n;
}

type V4Cidr = [number, number];
const v4 = (cidr: string): V4Cidr => {
  const [a = "", l] = cidr.split("/");
  return [parseIPv4(a)!, Number(l)];
};
/** Every IPv4 range that is NOT ordinary public unicast (IANA special-purpose registry + multicast/reserved). */
const V4_BLOCKED: V4Cidr[] = [
  "0.0.0.0/8", // "this network" (incl. 0.0.0.0)
  "10.0.0.0/8", // private
  "100.64.0.0/10", // CGNAT (also Tailscale)
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local (cloud metadata 169.254.169.254)
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.31.196.0/24", // AS112
  "192.52.193.0/24", // AMT
  "192.88.99.0/24", // 6to4 relay anycast
  "192.168.0.0/16", // private
  "192.175.48.0/24", // AS112
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved + 255.255.255.255
].map(v4);

function inV4(n: number, [base, len]: V4Cidr): boolean {
  if (len === 0) return true;
  const mask = len === 32 ? 0xffffffff : (~((1 << (32 - len)) - 1)) >>> 0;
  return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}

export function isPublicIPv4(n: number): boolean {
  return !V4_BLOCKED.some((c) => inV4(n, c));
}

const v6 = (cidr: string): [bigint, number] => {
  const [a = "", l] = cidr.split("/");
  return [parseIPv6(a)!, Number(l)];
};
const inV6 = (n: bigint, [base, len]: [bigint, number]): boolean => {
  if (len === 0) return true;
  const shift = BigInt(128 - len);
  return n >> shift === base >> shift;
};
const V6_GLOBAL = v6("2000::/3");
/** Inside 2000::/3 but still not plain public unicast. */
const V6_BLOCKED = [
  "2001::/23", // IETF protocol assignments (incl. Teredo 2001::/32, ORCHID, benchmarking 2001:2::/48)
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4 (embeds an IPv4; refused rather than decoded)
  "3fff::/20", // documentation (RFC 9637)
].map(v6);

export function isPublicIPv6(n: bigint): boolean {
  // Everything outside global unicast 2000::/3 is non-public: ::, ::1, IPv4-mapped
  // (::ffff:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96), ULA fc00::/7,
  // link-local fe80::/10, site-local fec0::/10, multicast ff00::/8, discard 100::/64.
  if (!inV6(n, V6_GLOBAL)) return false;
  return !V6_BLOCKED.some((c) => inV6(n, c));
}

/** Is this resolved address public unicast? Anything unparseable is NOT. */
export function isPublicAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 4) {
    const n = parseIPv4(addr);
    return n !== null && isPublicIPv4(n);
  }
  if (fam === 6) {
    const n = parseIPv6(addr);
    return n !== null && isPublicIPv6(n);
  }
  return false;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export interface TargetPolicy {
  /** Hosts allowed over plain http (lower-case, exact). Default none. */
  httpHosts?: readonly string[];
  /** Allowed ports besides the scheme default (443 / 80). Default none. */
  extraPorts?: readonly number[];
  /** If set, ONLY these hosts (lower-case, exact) are allowed (the map proxy). */
  hostAllowlist?: readonly string[];
  /** Hosts that must never be fetched (our own origin, the vault, the hub). */
  forbiddenHosts?: readonly string[];
}

export interface Target {
  url: URL;
  host: string; // lower-case DNS name
  port: number;
  protocol: "https:" | "http:";
}

export class GuardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_URL_LENGTH = 4096;

/** Validate a candidate URL string against the policy. Throws GuardError. */
export function parseTarget(raw: string, policy: TargetPolicy = {}): Target {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new GuardError("bad_url", "missing or oversized url");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardError("bad_url", "not an absolute URL");
  }
  const protocol = url.protocol;
  if (protocol !== "https:" && protocol !== "http:") throw new GuardError("bad_scheme", "only https is allowed");
  if (url.username || url.password) throw new GuardError("bad_url", "userinfo is not allowed");
  // WHATWG has already normalised "2130706433", "0x7f.1", "0177.0.0.1" etc. to a
  // dotted quad, and "[::ffff:7f00:1]" to an IPv6 literal — refuse ALL literals.
  const hostRaw = url.hostname.toLowerCase();
  if (hostRaw.startsWith("[") || isIP(hostRaw) !== 0 || /^[\d.]+$/.test(hostRaw)) {
    throw new GuardError("ip_literal", "IP-address hosts are not allowed");
  }
  const host = hostRaw.replace(/\.+$/, ""); // trailing-dot FQDN(s) name the same host
  const labels = host.split(".");
  if (
    !host ||
    !/^[a-z0-9.-]+$/.test(host) ||
    labels.length < 2 ||
    host.length > 253 ||
    // empty labels ("a..b"), over-long labels, and labels starting/ending with "-"
    labels.some((l) => l.length === 0 || l.length > 63 || l.startsWith("-") || l.endsWith("-"))
  ) {
    // "localhost", single-label intranet names, IDN that didn't punycode, etc.
    throw new GuardError("bad_host", "host must be a public DNS name");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    throw new GuardError("bad_host", "host must be a public DNS name");
  }
  if (protocol === "http:" && !(policy.httpHosts ?? []).includes(host)) {
    throw new GuardError("bad_scheme", "only https is allowed");
  }
  const defaultPort = protocol === "https:" ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  if (port !== defaultPort && !(policy.extraPorts ?? []).includes(port)) {
    throw new GuardError("bad_port", `port ${port} is not allowed`);
  }
  if (policy.hostAllowlist && !policy.hostAllowlist.includes(host)) {
    throw new GuardError("host_not_allowed", "host is not on the allowlist");
  }
  if ((policy.forbiddenHosts ?? []).includes(host)) {
    throw new GuardError("forbidden_host", "this server and its vault are never proxied");
  }
  return { url, host, port, protocol };
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------
//
// Resolution uses c-ares (`dns.promises.Resolver`), NOT `dns.lookup`:
// getaddrinfo runs on libuv's 4-thread pool and cannot be aborted, so a few
// hung lookups (a slow authoritative server, an attacker's black-hole zone)
// would also stall fs reads and async scrypt (login) for everyone. A c-ares
// query runs on the event loop's own socket, has its own `timeout`/`tries`, and
// is `cancel()`ed when the request deadline fires. (c-ares does not read
// /etc/hosts — irrelevant here: only public DNS names are ever resolved.)

/** Resolve `host` to addresses. Must reject (or settle) when `signal` aborts. */
export type Resolver = (host: string, signal: AbortSignal) => Promise<string[]>;

/** The constructor shape we need from `dns.promises.Resolver` (injectable for tests). */
export interface CaresResolverLike {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel(): void;
}
export type CaresResolverCtor = new (opts: { timeout: number; tries: number }) => CaresResolverLike;

export const DNS_TIMEOUT_MS = 2500;
export const DNS_TRIES = 2;

/**
 * Build the production resolver around a c-ares Resolver class. One Resolver
 * instance per lookup, so `cancel()` on abort only cancels that lookup's queries.
 */
export function createCaresResolver(Ctor: CaresResolverCtor = DnsResolver as unknown as CaresResolverCtor): Resolver {
  return (host, signal) =>
    new Promise<string[]>((resolve, reject) => {
      const r = new Ctor({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
      const onAbort = () => {
        r.cancel();
        reject(new Error("dns aborted"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.allSettled([r.resolve4(host), r.resolve6(host)])
        .then(([a, b]) => {
          const out = [...(a.status === "fulfilled" ? a.value : []), ...(b.status === "fulfilled" ? b.value : [])];
          if (out.length) resolve(out);
          else reject(new Error("no addresses"));
        })
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
}

const systemResolver: Resolver = createCaresResolver();

let resolver: Resolver = systemResolver;
/** Test seam: replace the DNS resolver (null = the c-ares system resolver). */
export function setResolver(r: Resolver | null): void {
  resolver = r ?? systemResolver;
  negative.clear();
}

/** Hosts that recently failed to resolve or resolved non-public: refused for NEGATIVE_TTL_MS without a new query. */
const negative = new Map<string, number>();
export const NEGATIVE_TTL_MS = 60_000;
export function clearDnsNegativeCache(): void {
  negative.clear();
}

/**
 * Resolve `host` and return ONE address to pin the connection to. Refuses the
 * host if the answer is empty or if ANY address is non-public (a split answer
 * like [public, 127.0.0.1] is an attack, not a fallback). `signal` bounds the
 * lookup (the request deadline): on abort the c-ares query is cancelled.
 */
export async function resolvePublic(host: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
  const neg = negative.get(host);
  if (neg !== undefined) {
    if (neg > Date.now()) throw new GuardError("dns_failed", "host recently failed to resolve");
    negative.delete(host);
  }
  const fail = (code: string, msg: string): never => {
    if (negative.size > 5000) negative.clear(); // bound memory
    negative.set(host, Date.now() + NEGATIVE_TTL_MS);
    throw new GuardError(code, msg);
  };
  let addrs: string[] = [];
  try {
    // Race the resolver against the deadline too, so even a resolver that
    // ignores the signal can't hold the request past it.
    addrs = await new Promise<string[]>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const onAbort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      resolver(host, signal)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  } catch {
    fail("dns_failed", "could not resolve host");
  }
  if (!Array.isArray(addrs) || addrs.length === 0) fail("dns_failed", "could not resolve host");
  for (const a of addrs) {
    if (typeof a !== "string" || !isPublicAddress(a)) fail("private_address", "host resolves to a non-public address");
  }
  // Prefer IPv4 (most home hosts lack IPv6 egress), else the first answer.
  return addrs.find((a) => isIP(a) === 4) ?? addrs[0]!;
}
