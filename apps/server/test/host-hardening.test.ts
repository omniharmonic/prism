/**
 * Small host-CLI hardening from the launch security review:
 *  - `prism reach` looks for `tailscale` only in ABSOLUTE PATH folders (a relative one would run a
 *    planted ./tailscale from the current folder);
 *  - the Tailscale DNS name becomes APP_ORIGIN, so anything but a DNS name is not taken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, tailscaleCandidates } from "../../../packaging/host/cli/reach";

test("tailscaleCandidates: relative PATH folders are ignored", () => {
  const c = tailscaleCandidates({ PATH: ".:bin:/usr/bin::./x" });
  assert.ok(c.includes("/usr/bin/tailscale"));
  assert.deepEqual(c.filter((p) => !p.startsWith("/")), []);
});

test("parseStatus: a DNSName that is not a plain DNS name is not used as the origin", () => {
  const status = (dns: string) =>
    parseStatus("/x", { code: 0, stderr: "", stdout: JSON.stringify({ Version: "1.102.2", BackendState: "Running", Self: { DNSName: dns, TailscaleIPs: ["100.64.0.1"], CapMap: { https: null } }, CertDomains: [], CurrentTailnet: { MagicDNSEnabled: true } }) });
  const good = status("mac.tail1234.ts.net.");
  assert.equal(good.state === "ready" && good.dnsName, "mac.tail1234.ts.net");
  for (const bad of ["mac.ts.net/evil", "mac.ts.net\nAPP_ORIGIN=x", "user@mac.ts.net", "mac.ts.net:444", "single"]) {
    const t = status(bad);
    assert.equal(t.state === "ready" && t.dnsName, "", bad);
  }
});
