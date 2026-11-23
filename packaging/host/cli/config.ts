/**
 * `prism config get [KEY…]` and `prism config set KEY=VALUE… [--confirm-send] [--no-restart]`:
 * the server switches an agent may change in the install's `.env` without hand-editing it.
 *
 * Only the keys in apps/server/src/host-config.ts. A secret, the vault token or sign-in routing
 * is never readable or settable here. Turning on a SEND switch (a way out to other people — the
 * one door) needs `--confirm-send`: the setup skills pass it only after the person has said yes
 * to that exact switch. Turning one off never needs it. The file stays 0600, every other line is
 * kept byte for byte, and a running server is restarted so it reads the change.
 */
import { parseEnv } from "../../../apps/server/scripts/lib/env-file";
import { HOST_CONFIG_KEYS, hostConfigKey, normaliseHostConfigValue } from "../../../apps/server/src/host-config";
import { bool, type Parsed } from "./args";
import { prefixOf, requireInstalled, type Ctx, type Result } from "./commands";
import { CliError, EXIT } from "./exit-codes";
import { readTextOrNull, writeFileAtomic } from "./fsutil";
import { setKeys } from "./hostenv";
import { SECRET_FILE_MODE } from "./paths";
import { restartIfRunning } from "./token";

export async function cmdConfig(ctx: Ctx, p: Parsed): Promise<Result> {
  const [verb, ...args] = p.positional;
  const layout = prefixOf(ctx, p);
  const state = requireInstalled(layout);
  const text = readTextOrNull(layout.envFile);
  if (text === null) throw new CliError(EXIT.NOT_INSTALLED, `${layout.envFile} does not exist (run \`prism install\`)`);
  const env = parseEnv(text);

  if (verb === "get" || verb === undefined) {
    const keys = args.length ? args : HOST_CONFIG_KEYS.map((k) => k.key);
    const values: Record<string, { value: string | null; send: boolean; about: string }> = {};
    for (const key of keys) {
      const def = hostConfigKey(key);
      if (!def) throw new CliError(EXIT.USAGE, `${key} is not a setting \`prism config\` can show (see \`prism config get\`)`);
      values[key] = { value: env[key] ?? null, send: !!def.send, about: def.about };
    }
    return { code: EXIT.OK, values };
  }

  if (verb !== "set") throw new CliError(EXIT.USAGE, "usage: prism config get [KEY…] | prism config set KEY=VALUE… [--confirm-send] [--no-restart]");
  if (!args.length) throw new CliError(EXIT.USAGE, "prism config set needs at least one KEY=VALUE");
  const entries: Array<[string, string]> = [];
  const opened: string[] = [];
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new CliError(EXIT.USAGE, `"${arg}" is not KEY=VALUE`);
    const key = arg.slice(0, eq);
    const def = hostConfigKey(key);
    if (!def) throw new CliError(EXIT.USAGE, `${key} cannot be set with \`prism config\` (secrets go through \`prism token\` or the app's Connections; see \`prism config get\` for what can)`);
    const v = normaliseHostConfigValue(def, arg.slice(eq + 1));
    if ("problem" in v) throw new CliError(EXIT.USAGE, v.problem);
    if (def.send && v.value === "true" && env[key] !== "true") opened.push(key);
    entries.push([key, v.value]);
  }
  if (opened.length && !bool(p, "confirm-send")) {
    throw new CliError(
      EXIT.NEEDS_CONFIRMATION,
      `${opened.join(", ")} would let this server send to other people. Every message leaves through these switches (the one door); they stay off until the owner says yes. Ask the owner, and only after they agree to exactly this, run it again with --confirm-send. Nothing was changed.`,
      { sendSwitches: opened },
    );
  }
  const changed = entries.filter(([k, v]) => env[k] !== v).map(([k]) => k);
  if (bool(p, "dry-run") || !changed.length) return { code: EXIT.OK, dryRun: bool(p, "dry-run"), changed, ...(opened.length ? { opened } : {}) };
  // Re-read just before the write: only these keys change.
  const fresh = readTextOrNull(layout.envFile) ?? text;
  writeFileAtomic(layout.envFile, setKeys(fresh, entries.filter(([k]) => changed.includes(k))), SECRET_FILE_MODE);
  const restart = bool(p, "no-restart") ? { ran: false, needed: true, reason: "--no-restart: run `prism restart` so the server reads the change" } : await restartIfRunning(ctx, layout, state);
  return { code: restart.ran && restart.ok === false ? EXIT.DEGRADED : EXIT.OK, changed, ...(opened.length ? { opened } : {}), restart };
}
