#!/usr/bin/env node
/**
 * universal-links — produce the Associated Domains entitlement for a Prism
 * Client build (NP-NA-04). The server host is per-install configuration, so the
 * entitlement is GENERATED at build time, never committed with a host in it.
 *
 *   node apps/client/scripts/universal-links.mjs                      # show what would be written
 *   node apps/client/scripts/universal-links.mjs --write              # macOS: entitlements + tauri config overlay
 *   node apps/client/scripts/universal-links.mjs --write --profile ~/…/Prism_Client.provisionprofile
 *   node apps/client/scripts/universal-links.mjs --ios                # patch gen/apple/…/*.entitlements (when the iOS project exists)
 *   node apps/client/scripts/universal-links.mjs --self-test          # pure checks, writes nothing
 *
 * Hosts (comma-separated DNS names, https only — Apple fetches
 * https://<host>/.well-known/apple-app-site-association), in order:
 *   --hosts a.example.com,b.example.com
 *   PRISM_ASSOCIATED_DOMAINS
 *   the host of PRISM_SERVER_ORIGIN (the origin baked into the build)
 *   the host of DEFAULT_ORIGIN in src-tauri/src/origin.rs
 *
 * The app only opens a link whose origin EQUALS its configured server
 * (src-tauri/src/links.rs), so listing a host here grants nothing by itself;
 * a host that is not the app's server is simply never opened.
 *
 * macOS: `com.apple.developer.associated-domains` is a RESTRICTED entitlement.
 * An app carrying it only launches when it is signed with a certificate of the
 * team AND embeds a provisioning profile whose App ID has the Associated
 * Domains capability (--profile). An ad-hoc or unsigned build with this
 * entitlement is killed at launch — which is why it is an opt-in overlay
 * (`tauri build --config src-tauri/gen/universal-links/tauri.macos.conf.json`)
 * and not part of tauri.conf.json.
 *
 * `--developer` appends `?mode=developer` (debug/development-signed builds
 * only: the device fetches the association file directly instead of through
 * Apple's CDN; needs Settings → Developer → Associated Domains Development).
 * Never use it for a distribution build.
 *
 * Dependency-free (node:fs).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, "../src-tauri");
const outDir = join(tauriDir, "gen/universal-links");

export const TEAM_ID = /^[A-Z0-9]{10}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** One DNS name, lowercased; or null. Accepts `https://host` (no port/path); refuses everything else. */
export function associatedHost(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("https://")) {
    s = s.slice("https://".length);
    if (s.endsWith("/")) s = s.slice(0, -1);
  }
  // No scheme, port, path, query, userinfo, wildcard, IP literal or single label.
  if (!HOST.test(s)) return null;
  if (/^\d+(\.\d+){3}$/.test(s)) return null;
  if (s === "localhost" || s.endsWith(".localhost") || s.endsWith(".local") || s.endsWith(".internal")) return null;
  return s;
}

export function associatedHosts(raw) {
  const out = [];
  const bad = [];
  for (const part of String(raw ?? "").split(",")) {
    if (!part.trim()) continue;
    const h = associatedHost(part);
    if (!h) bad.push(part.trim());
    else if (!out.includes(h)) out.push(h);
  }
  return { hosts: out, bad };
}

export const domainEntries = (hosts, developer = false) => hosts.map((h) => `applinks:${h}${developer ? "?mode=developer" : ""}`);

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const domainsBlock = (entries, indent = "\t") =>
  `${indent}<key>com.apple.developer.associated-domains</key>\n${indent}<array>\n${entries.map((e) => `${indent}\t<string>${xml(e)}</string>\n`).join("")}${indent}</array>\n`;

/** A complete macOS entitlements file. */
export function macosEntitlements({ teamId, bundleId, hosts, developer = false }) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n<dict>\n` +
    `\t<key>com.apple.application-identifier</key>\n\t<string>${xml(teamId)}.${xml(bundleId)}</string>\n` +
    `\t<key>com.apple.developer.team-identifier</key>\n\t<string>${xml(teamId)}</string>\n` +
    domainsBlock(domainEntries(hosts, developer)) +
    `</dict>\n</plist>\n`
  );
}

/**
 * Set (or replace) the associated-domains array in an existing entitlements
 * plist, leaving every other key as it is. Idempotent. Throws when the text is
 * not a plist with one top-level <dict>.
 */
export function patchEntitlements(text, entries) {
  const without = text.replace(/[ \t]*<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>[\s\S]*?<\/array>[ \t]*\n?/g, "");
  const end = without.lastIndexOf("</dict>");
  if (end < 0 || !/<plist\b/.test(without)) throw new Error("not an entitlements plist");
  if (entries.length === 0) return without;
  const head = without.slice(0, end).replace(/[ \t]*$/, "");
  return `${head}${head.endsWith("\n") ? "" : "\n"}${domainsBlock(entries)}${without.slice(end)}`;
}

function defaultHosts(env) {
  if (env.PRISM_ASSOCIATED_DOMAINS) return env.PRISM_ASSOCIATED_DOMAINS;
  if (env.PRISM_SERVER_ORIGIN) return env.PRISM_SERVER_ORIGIN;
  const rs = readFileSync(join(tauriDir, "src/origin.rs"), "utf8");
  return /pub const DEFAULT_ORIGIN: &str = "([^"]+)";/.exec(rs)?.[1] ?? "";
}

function selfTest() {
  const eq = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(associatedHost("Prism.Example.com"), "prism.example.com", "lowercased");
  eq(associatedHost("https://prism.example.com/"), "prism.example.com", "an https origin");
  for (const bad of [
    "", "http://prism.example.com", "https://prism.example.com:8443", "https://prism.example.com/x", "prism.example.com/x",
    "*.example.com", "example", "localhost", "127.0.0.1", "a.local", "user@prism.example.com", "prism.example.com?mode=developer",
    "applinks:prism.example.com", "prism..example.com", "-a.example.com", "prism.example.com\nwebcredentials:evil.example",
    "prism.example.com</string><string>applinks:evil.example",
  ]) eq(associatedHost(bad), null, `refused ${JSON.stringify(bad)}`);
  eq(associatedHosts("a.example.com, b.example.com ,a.example.com,bad host"), { hosts: ["a.example.com", "b.example.com"], bad: ["bad host"] }, "list");
  eq(domainEntries(["a.example.com"]), ["applinks:a.example.com"], "entries");
  eq(domainEntries(["a.example.com"], true), ["applinks:a.example.com?mode=developer"], "developer mode");

  const mac = macosEntitlements({ teamId: "83Y42N33H8", bundleId: "com.benjaminlife.prism.client", hosts: ["a.example.com"] });
  if (!mac.includes("<string>83Y42N33H8.com.benjaminlife.prism.client</string>") || !mac.includes("<string>applinks:a.example.com</string>")) throw new Error("macOS entitlements content");
  if (/webcredentials|activitycontinuation|appclips/.test(mac)) throw new Error("only applinks is ever written");

  const ios =
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<!-- APNs -->\n\t<key>aps-environment</key>\n\t<string>production</string>\n</dict>\n</plist>`;
  const once = patchEntitlements(ios, ["applinks:a.example.com"]);
  if (!once.includes("<key>aps-environment</key>\n\t<string>production</string>")) throw new Error("other keys are kept");
  if ((once.match(/associated-domains/g) ?? []).length !== 1) throw new Error("one associated-domains key");
  eq(patchEntitlements(once, ["applinks:a.example.com"]), once, "idempotent");
  const swapped = patchEntitlements(once, ["applinks:b.example.com"]);
  if (swapped.includes("a.example.com") || !swapped.includes("applinks:b.example.com")) throw new Error("replaces, never appends");
  eq(patchEntitlements(once, []), patchEntitlements(ios, []), "an empty list removes the key");
  let threw = false;
  try { patchEntitlements("not a plist", ["applinks:a.example.com"]); } catch { threw = true; }
  if (!threw) throw new Error("a non-plist is refused");
  console.log("universal-links — self-test passed");
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (flag("--self-test")) return selfTest();

  const conf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
  const bundleId = conf.identifier;
  const teamId = value("--team") ?? process.env.APPLE_TEAM_ID ?? "83Y42N33H8";
  if (!TEAM_ID.test(teamId)) throw new Error(`not a team id: ${teamId}`);
  const { hosts, bad } = associatedHosts(value("--hosts") ?? defaultHosts(process.env));
  if (bad.length) throw new Error(`not a host Apple can verify (https DNS name, no port/path): ${bad.join(", ")}`);
  if (hosts.length === 0) throw new Error("no host: pass --hosts or set PRISM_ASSOCIATED_DOMAINS / PRISM_SERVER_ORIGIN");
  const developer = flag("--developer");
  const entries = domainEntries(hosts, developer);

  console.log(`app id      ${teamId}.${bundleId}`);
  console.log(`domains     ${entries.join(", ")}`);
  console.log(`server      each host must answer https://<host>/.well-known/apple-app-site-association with that app id (APPLE_APP_ID on the Prism Server)`);

  if (flag("--ios")) {
    const dir = join(tauriDir, "gen/apple/prism-client_iOS");
    const files = ["prism-client_iOS.entitlements", "prism-client_iOS.debug.entitlements"].map((f) => join(dir, f)).filter(existsSync);
    if (files.length === 0) throw new Error(`no iOS entitlements under ${dir} (the iOS project is not in this checkout)`);
    for (const f of files) {
      // `?mode=developer` only ever goes into the debug entitlements.
      const list = /\.debug\.entitlements$/.test(f) ? entries : domainEntries(hosts, false);
      writeFileSync(f, patchEntitlements(readFileSync(f, "utf8"), list));
      console.log(`patched     ${f}`);
    }
    return;
  }

  const entitlements = macosEntitlements({ teamId, bundleId, hosts, developer });
  const overlay = { bundle: { macOS: { entitlements: "gen/universal-links/macos.entitlements" } } };
  const profile = value("--profile");
  if (profile) {
    const p = profile.startsWith("~/") ? join(homedir(), profile.slice(2)) : isAbsolute(profile) ? profile : resolve(process.cwd(), profile);
    if (!existsSync(p)) throw new Error(`provisioning profile not found: ${p}`);
    overlay.bundle.macOS.files = { "embedded.provisionprofile": p };
  }
  if (!flag("--write")) {
    console.log(`\n(dry run — pass --write)\n\n${entitlements}\n${JSON.stringify(overlay, null, 2)}`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "macos.entitlements"), entitlements);
  writeFileSync(join(outDir, "tauri.macos.conf.json"), JSON.stringify(overlay, null, 2) + "\n");
  console.log(`wrote       ${join(outDir, "macos.entitlements")}`);
  console.log(`wrote       ${join(outDir, "tauri.macos.conf.json")}`);
  if (!profile) console.log("WARNING     no --profile: a build with this entitlement and no matching embedded provisioning profile will not launch.");
  console.log(`build       cd apps/client && npm run tauri build -- --bundles app --config src-tauri/gen/universal-links/tauri.macos.conf.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`✗ universal-links — ${e.message}`);
    process.exit(1);
  }
}
