/**
 * `prism setup` — one-shot Prism Server provisioning.
 *
 * Ports scripts/bootstrap.sh (secret generation + .env writer) to a dependency-free
 * Node script, then seeds the vault tag schemas idempotently via seedTagSchemas().
 *
 *   node --import tsx scripts/prism-setup.ts            # interactive
 *   node --import tsx scripts/prism-setup.ts --force    # overwrite an existing .env
 *   node --import tsx scripts/prism-setup.ts --dry-run  # show the .env it WOULD write
 *                                                       # + dry-run the tag seed (no writes)
 *
 * Dependency-free: node:crypto, node:readline, node:fs, fetch.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { seedTagSchemas } from "./lib/seed-tag-schemas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, "../.env");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const FORCE = argv.includes("--force");

/** base64 secret, newline-stripped (matches bootstrap.sh `openssl rand -base64`). */
function gen(bytes = 48): string {
  return randomBytes(bytes).toString("base64").replace(/\n/g, "");
}

/** url-safe collab token (matches bootstrap.sh `collab_<...>` shape). */
function genCollabToken(): string {
  const b = randomBytes(30).toString("base64").replace(/\//g, "_").replace(/\+/g, "-").replace(/=+$/g, "");
  return `collab_${b}`;
}

/** Derive a default From address from the origin host, mirroring bootstrap.sh. */
function defaultMagicFrom(appOrigin: string): string {
  // strip scheme + leading subdomain (e.g. https://prism.example.com → example.com)
  const host = appOrigin.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const apex = host.split(".").slice(-2).join(".") || host;
  return `Prism <login@${apex}>`;
}

async function main() {
  console.log("Prism Server setup — generating secrets and collecting config.");
  if (DRY_RUN) console.log("(--dry-run: NO files written, NO vault changes.)");
  console.log("(Press Enter to accept the [default].)\n");

  if (existsSync(ENV_FILE) && !FORCE && !DRY_RUN) {
    console.error(`✗ ${ENV_FILE} already exists. Re-run with --force to overwrite (this rotates secrets), or --dry-run to preview.`);
    process.exit(1);
  }

  // Interactive (TTY) → readline prompts. Non-TTY (piped/automated) → consume
  // pre-supplied lines from stdin in order (readline/promises misbehaves on EOF).
  const interactive = !!stdin.isTTY;
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  let pipedLines: string[] = [];
  if (!interactive) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    pipedLines = Buffer.concat(chunks).toString("utf8").split("\n");
  }
  const ask = async (prompt: string, def = ""): Promise<string> => {
    if (rl) {
      const a = (await rl.question(prompt)).trim();
      return a || def;
    }
    stdout.write(prompt);
    const a = (pipedLines.shift() ?? "").trim();
    stdout.write(a + "\n");
    return a || def;
  };

  try {
    const APP_ORIGIN = await ask(
      "Public https origin (your tunnel hostname) [https://prism.example.com]: ",
      "https://prism.example.com",
    );

    let OWNER_EMAIL = await ask("Owner email (full-access admin): ");
    while (!/.+@.+\..+/.test(OWNER_EMAIL)) {
      OWNER_EMAIL = await ask("  Please enter a valid email: ");
    }

    const PARACHUTE_URL = await ask("Parachute URL [http://localhost:1940]: ", "http://localhost:1940");
    const PARACHUTE_VAULT = await ask("Parachute vault name [default]: ", "default");

    console.log("Mint a vault token with:");
    console.log(`  parachute auth mint-token --scope vault:${PARACHUTE_VAULT}:write --expires-in 31536000`);
    let PARACHUTE_TOKEN = await ask("Paste the Parachute vault token (PARACHUTE_TOKEN): ");
    while (!PARACHUTE_TOKEN) {
      PARACHUTE_TOKEN = await ask("  Required. Paste the token: ");
    }

    const RESEND_API_KEY = await ask("Resend API key for emailed magic links/invites (optional, Enter to skip): ");
    const MAGIC_FROM = await ask(
      `Magic-link From address [${defaultMagicFrom(APP_ORIGIN)}]: `,
      defaultMagicFrom(APP_ORIGIN),
    );

    rl?.close();

    // Generate fresh secrets — but if dry-run and an .env exists, preserve its secrets
    // in the preview so we don't imply a rotation that won't happen.
    let SESSION_SECRET = gen(48);
    let CAPABILITY_SECRET = gen(48);
    let COLLAB_TOKEN = genCollabToken();
    if (DRY_RUN && existsSync(ENV_FILE)) {
      const cur = readEnv(ENV_FILE);
      SESSION_SECRET = cur.SESSION_SECRET ?? SESSION_SECRET;
      CAPABILITY_SECRET = cur.CAPABILITY_SECRET ?? CAPABILITY_SECRET;
      COLLAB_TOKEN = cur.COLLAB_TOKEN ?? COLLAB_TOKEN;
    }

    const envBody = [
      `APP_ORIGIN=${APP_ORIGIN}`,
      `PORT=8787`,
      `PARACHUTE_URL=${PARACHUTE_URL}`,
      `PARACHUTE_VAULT=${PARACHUTE_VAULT}`,
      `PARACHUTE_TOKEN=${PARACHUTE_TOKEN}`,
      `SESSION_SECRET=${SESSION_SECRET}`,
      `CAPABILITY_SECRET=${CAPABILITY_SECRET}`,
      `COLLAB_TOKEN=${COLLAB_TOKEN}`,
      `OWNER_EMAIL=${OWNER_EMAIL}`,
      `RESEND_API_KEY=${RESEND_API_KEY}`,
      `MAGIC_FROM=${MAGIC_FROM}`,
      `DB_PATH=./prism-server.db`,
      `WEB_ROOT=../web/dist`,
      "",
    ].join("\n");

    if (DRY_RUN) {
      console.log("\n--- .env that WOULD be written" + (existsSync(ENV_FILE) ? " (existing .env left untouched, secrets preserved in preview)" : "") + " ---");
      console.log(maskSecrets(envBody));
      console.log("--- end .env preview ---\n");
    } else {
      writeFileSync(ENV_FILE, envBody, { mode: 0o600 });
      chmodSync(ENV_FILE, 0o600);
      console.log(`\n✓ Wrote ${ENV_FILE} (chmod 600).`);
    }

    // Seed vault tag schemas (idempotent).
    console.log(`\n${DRY_RUN ? "[dry-run] " : ""}Seeding vault tag schemas against ${PARACHUTE_URL} (vault: ${PARACHUTE_VAULT})...`);
    try {
      const seed = await seedTagSchemas({
        vaultUrl: PARACHUTE_URL,
        vault: PARACHUTE_VAULT,
        token: PARACHUTE_TOKEN,
        dryRun: DRY_RUN,
        log: (m) => console.log("  " + m),
      });
      console.log(
        `\n${DRY_RUN ? "[dry-run] " : ""}Tag schemas: ${seed.created.length} created, ${seed.updated.length} updated, ${seed.unchanged.length} unchanged, ${seed.skipped.length} skipped.`,
      );
      if (seed.created.length) console.log(`  created:   ${seed.created.join(", ")}`);
      if (seed.updated.length) console.log(`  updated:   ${seed.updated.join(", ")}`);
    } catch (e) {
      console.error(`\n✗ Tag-schema seed failed: ${(e as Error).message}`);
      console.error("  (Secrets were written; re-run the seed once the vault is reachable.)");
    }

    // Next steps.
    console.log("\nNEXT — point the desktop app at this server (so its edits sync + it can share):");
    console.log("  Add to the desktop config (macOS: ~/Library/Application Support/prism/prism-config.json):");
    console.log(`    "collab_url":   "ws://localhost:8787/collab",`);
    console.log(`    "collab_token": "${DRY_RUN ? "<generated on real run>" : COLLAB_TOKEN}"`);
    console.log("\nThen: npm run build -w @prism/web && (cd apps/server && npm start)");
    console.log("Keep .env secret. Never commit it.");
  } finally {
    rl?.close();
  }
}

/** Minimal .env parser (KEY=VALUE per line). */
function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Mask secret values in a .env preview. */
function maskSecrets(envBody: string): string {
  const SECRET_KEYS = new Set(["PARACHUTE_TOKEN", "SESSION_SECRET", "CAPABILITY_SECRET", "COLLAB_TOKEN", "RESEND_API_KEY"]);
  return envBody
    .split("\n")
    .map((line) => {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && SECRET_KEYS.has(m[1]!) && m[2]) {
        const v = m[2];
        const shown = v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-2)}` : "********";
        return `${m[1]}=${shown}`;
      }
      return line;
    })
    .join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
