/**
 * launchd user agents owned by Prism (docs/host-bundle.md § launchd).
 *
 * Three agents under one reverse-DNS prefix (packaging/host/launchd/identity.json):
 *   <prefix>.server  — Prism Server, through `prism run server`
 *   <prefix>.hub     — Parachute hub: stock `parachute serve` (stock mode, cli/parachute-stock.ts),
 *                      or the embedded payload once it ships
 *   <prefix>.vault   — Parachute vault (embedded mode only; in stock mode the hub runs the vault)
 *
 * launchd has no dependencies between jobs, so the ORDER is the server supervisor's job:
 * `prism run server` waits for the hub's /api/ready and the vault's /health (bounded) and
 * exits 75 when they are not ready, so launchd starts it again after ThrottleInterval.
 *
 * A plist holds paths only. Secrets stay in the install's `.env` (0600), which the
 * supervisor hands to Node with `--env-file`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./paths";

export type AgentName = "server" | "hub" | "vault";
export const AGENTS: readonly AgentName[] = ["hub", "vault", "server"];

export interface Identity {
  labelPrefix: string;
}

export function loadIdentity(launchdDir: string): Identity {
  const id = JSON.parse(readFileSync(join(launchdDir, "identity.json"), "utf8")) as Partial<Identity>;
  if (!id.labelPrefix || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(id.labelPrefix)) throw new Error("identity.json: labelPrefix must be a reverse-DNS name");
  return { labelPrefix: id.labelPrefix };
}

export function loadTemplate(launchdDir: string, name: AgentName): string {
  return readFileSync(join(launchdDir, `${name}.plist.in`), "utf8");
}

export function labelFor(identity: Identity, name: AgentName): string {
  return `${identity.labelPrefix}.${name}`;
}

export function plistPath(launchAgents: string, label: string): string {
  return join(launchAgents, `${label}.plist`);
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Replace every `{{KEY}}`; a key without a value, or a value with a control character, throws. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`plist template: no value for {{${k}}}`);
    if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(v) || /[\r\n]/.test(v)) throw new Error(`plist template: unsafe value for {{${k}}}`);
    return xmlEscape(v);
  });
  return out;
}

/** The PATH the agents run with: launchd's default plus the usual tool folders (non-secret). */
export function agentPath(home: string): string {
  return [join(home, ".local/bin"), join(home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

export interface RenderedAgent {
  name: AgentName;
  label: string;
  path: string;
  xml: string;
}

export function renderAgent(opts: { name: AgentName; template: string; identity: Identity; layout: Layout; home: string; launchAgents: string; throttleSeconds?: number }): RenderedAgent {
  const { name, template, identity, layout, home, launchAgents } = opts;
  const label = labelFor(identity, name);
  const xml = renderTemplate(template, {
    LABEL: label,
    // Through `bin/prism` → app/current/bin/prism, so an update is picked up by a restart.
    PRISM_BIN: layout.binPrism,
    PRISM_HOME: layout.prefix,
    PATH: agentPath(home),
    WORKING_DIR: name === "server" ? layout.config : layout.parachuteHome,
    THROTTLE: String(opts.throttleSeconds ?? 10),
    LOG_DIR: layout.logs,
  });
  return { name, label, path: plistPath(launchAgents, label), xml };
}
