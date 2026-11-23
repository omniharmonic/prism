/**
 * `npm run signin -w @prism/server [-- --print]` — sign in as the server owner without email,
 * for a server run from a checkout (`npm run dev`). The host install has the same thing as
 * `prism signin`. Reads `./.env` (PORT, DB_PATH, HOST_KEY_FILE) from apps/server, asks the
 * running server over loopback for a one-time link and opens it in the browser.
 * `--print` writes the link to stdout instead (headless only — it is a credential).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "./lib/env-file";
import { hostKeyFileFor, openInBrowser, readHostKey, requestLocalLink, PRINTED_LINK_WARNING, type SigninFetch } from "./lib/local-signin-client";

async function main(): Promise<number> {
  const print = process.argv.includes("--print");
  const envPath = resolve(process.cwd(), ".env");
  let env: Record<string, string> = {};
  try {
    env = parseEnv(readFileSync(envPath, "utf8"));
  } catch {
    process.stderr.write(`signin: no ${envPath} (run this from apps/server)\n`);
    return 3;
  }
  const port = Number(env.PORT) || 8787;
  const keyFile = hostKeyFileFor(env, process.cwd());
  if (!keyFile) {
    process.stderr.write("signin: this server keeps no host key (DB_PATH is :memory: or HOST_KEY_FILE is empty)\n");
    return 4;
  }
  const key = readHostKey(keyFile);
  if ("problem" in key) {
    process.stderr.write(`signin: ${key.problem}\n`);
    return 4;
  }
  const r = await requestLocalLink(fetch as unknown as SigninFetch, `http://127.0.0.1:${port}`, key.key);
  if (!r.ok) {
    process.stderr.write(`signin: ${r.kind === "unreachable" ? `the server does not answer on 127.0.0.1:${port}` : `refused (${r.error ?? r.status ?? r.kind})`}\n`);
    return r.kind === "unreachable" ? 10 : 4;
  }
  if (print) {
    process.stderr.write(`signin: ${PRINTED_LINK_WARNING}\n`);
    process.stdout.write(r.link.url + "\n");
    return 0;
  }
  await openInBrowser(r.link.url);
  process.stdout.write("A one-time sign-in link was opened in your browser. It works once, on this computer only, for 10 minutes.\n");
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  process.stderr.write(`signin: ${(e as Error).message}\n`);
  process.exit(1);
});
