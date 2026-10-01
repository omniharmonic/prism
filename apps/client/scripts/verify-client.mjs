#!/usr/bin/env node
/**
 * verify-client — static invariants of the Prism Client shell (WP4.1).
 *
 *   node apps/client/scripts/verify-client.mjs           assert on the existing apps/web/dist-native
 *   node apps/client/scripts/verify-client.mjs --build   run `npm run build:native -w @prism/web` first
 *
 * Asserts:
 *  1. identity: identifier/product/binary differ from the legacy desktop, so both install side by side;
 *  2. CSP (tauri.conf.json): no localhost / :1940 / :1939, no wildcard http(s)/ws(s) sources,
 *     connect-src is exactly 'self' + Tauri IPC + one https origin + its wss twin;
 *  3. the frontend is the native web build (no devUrl, no localhost dev server);
 *  4. each capability file lists exactly its window's commands (main: 8; quick-capture: 1, never get_token);
 *     no core:*, fs, shell, opener, http, dialog, notification, global-shortcut or remote grants (WP4.2);
 *  5. Rust: no process spawning, no vault port, no fs/shell/http/sql plugins;
 *  6. dist-native: no service worker; the only `localhost:1940` strings are the known inert
 *     UI placeholders/defaults of the shared UI (desktop vault-switcher, server-side hub hint) —
 *     nothing new may appear, and the CSP forbids connecting there regardless; no token-shaped literal;
 *  7. WP4.3 "no vault token on the client": the shell names no vault-token key/env/scope, the settings
 *     file has no credential field, and the web shim routes none of the desktop config commands.
 * Dependency-free (node:fs + child_process).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tauriDir = resolve(here, "../src-tauri");
const dist = resolve(root, "apps/web/dist-native");

let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => {
  console.error(`✗ ${m}`);
  failed++;
};
const check = (cond, pass, fail) => (cond ? ok(pass) : bad(fail ?? `NOT: ${pass}`));
const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

if (process.argv.includes("--build")) {
  execSync("npm run build:native -w @prism/web", { cwd: root, stdio: "inherit" });
}

// 1. identity
const conf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
const desk = JSON.parse(readFileSync(resolve(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
check(conf.identifier !== desk.identifier, `identifier ${conf.identifier} differs from the desktop's`);
check(conf.productName !== desk.productName, `product name "${conf.productName}" differs from the desktop's ("${desk.productName}")`);

// 2. CSP
const csp = conf.app?.security?.csp ?? "";
const dirs = Object.fromEntries(
  csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [k, ...v] = d.split(/\s+/);
    return [k, v];
  }),
);
check(!/localhost:|127\.0\.0\.1|1940|1939/.test(csp), "CSP names no localhost / vault / hub");
const wild = csp.split(/[\s;]+/).filter((s) => /^(https?|wss?):$/.test(s));
check(wild.length === 0, "CSP has no scheme-wide wildcards (https: / wss: / ws: / http:)", `CSP wildcards: ${wild.join(" ")}`);
const connect = dirs["connect-src"] ?? [];
const remote = connect.filter((s) => !["'self'", "ipc:", "http://ipc.localhost"].includes(s));
check(
  remote.length === 2 && /^https:\/\/[^/*]+$/.test(remote[0]) && remote[1] === remote[0].replace(/^https/, "wss"),
  `connect-src = self + IPC + ${remote.join(" ")}`,
  `connect-src must be self + IPC + one https origin + its wss twin, got: ${connect.join(" ")}`,
);
check(dirs["default-src"]?.join(" ") === "'self'", "default-src 'self'");
check(conf.app?.withGlobalTauri === false, "withGlobalTauri is off (no window.__TAURI__ API surface)");

// 3. frontend
check(!conf.build?.devUrl, "no devUrl (dev also serves the bundled native build)");
check(conf.build?.frontendDist === "../../web/dist-native", "frontendDist is apps/web/dist-native");
check(JSON.stringify(conf.build).includes("build:native"), "before{Dev,Build}Command builds the native web bundle");

// 4. capabilities: each capability file lists EXACTLY its window's commands (WP4.2).
const EXPECTED_CAPS = {
  "default.json": {
    windows: ["main"],
    permissions: ["allow-get-token", "allow-sign-in", "allow-sign-out", "allow-get-server-origin", "allow-set-server-origin", "allow-open-external", "allow-notify", "allow-export-note"],
  },
  // The capture window gets ONE command and never get_token: the bearer must not enter that webview.
  "quick-capture.json": { windows: ["quick-capture"], permissions: ["allow-quick-capture"] },
};
const capFiles = readdirSync(join(tauriDir, "capabilities")).filter((f) => f.endsWith(".json"));
check(
  JSON.stringify([...capFiles].sort()) === JSON.stringify(Object.keys(EXPECTED_CAPS).sort()),
  `capability files are exactly ${Object.keys(EXPECTED_CAPS).join(", ")}`,
  `unexpected capability files: ${capFiles.join(", ")}`,
);
const granted = new Map(); // permission -> windows that hold it
for (const f of capFiles) {
  const cap = JSON.parse(readFileSync(join(tauriDir, "capabilities", f), "utf8"));
  const perms = (cap.permissions ?? []).map((p) => (typeof p === "string" ? p : p.identifier));
  const want = EXPECTED_CAPS[f];
  if (want) {
    check(
      JSON.stringify([...perms].sort()) === JSON.stringify([...want.permissions].sort()),
      `${f}: grants exactly ${want.permissions.join(", ")}`,
      `${f}: permissions are [${perms.join(", ")}], expected [${want.permissions.join(", ")}]`,
    );
    check(
      JSON.stringify(cap.windows ?? []) === JSON.stringify(want.windows),
      `${f}: applies only to window(s) ${want.windows.join(", ")}`,
      `${f}: windows are ${JSON.stringify(cap.windows)}`,
    );
  }
  check(
    !perms.some((p) => /^(core|opener|fs|shell|http|dialog|notification|global-shortcut|clipboard|process|updater)[:-]/.test(p)),
    `${f}: no core:/plugin permissions`,
  );
  check(!cap.remote, `${f}: no remote-origin IPC`);
  for (const p of perms) granted.set(p, [...(granted.get(p) ?? []), ...(cap.windows ?? [])]);
}
check(!(granted.get("allow-get-token") ?? []).includes("quick-capture"), "quick-capture window can NOT call get_token");
check((granted.get("allow-quick-capture") ?? []).join() === "quick-capture", "quick_capture is granted to the quick-capture window only");
// Every command declared in build.rs is granted to some window, and nothing else is granted.
const buildRs = readFileSync(join(tauriDir, "build.rs"), "utf8");
const declared = [...buildRs.matchAll(/^\s*"([a-z_]+)",\s*(?:\/\/.*)?$/gm)].map((m) => `allow-${m[1].replace(/_/g, "-")}`);
check(
  declared.length === 9 && declared.every((d) => granted.has(d)) && [...granted.keys()].every((g) => declared.includes(g)),
  `build.rs declares ${declared.length} commands, each granted to a window, none extra`,
  `build.rs commands [${declared.join(", ")}] vs granted [${[...granted.keys()].join(", ")}]`,
);
// The capture page itself: static, calls only quick_capture, no network of its own.
const capPage = readFileSync(join(root, "apps/web/public/quick-capture.js"), "utf8");
const capCmds = [...capPage.matchAll(/invoke\(\s*"([a-z_:|-]+)"/g)].map((m) => m[1]);
check(capCmds.length > 0 && capCmds.every((c) => c === "quick_capture"), "quick-capture.js invokes only quick_capture", `quick-capture.js invokes: ${capCmds.join(", ")}`);
check(!/get_token|__PRISM_HOST__|fetch\(|XMLHttpRequest|WebSocket/.test(capPage), "quick-capture.js has no token access and no network of its own");

// 5. Rust
const cargo = readFileSync(join(tauriDir, "Cargo.toml"), "utf8");
// The notification/dialog plugins inject JS shims (window.Notification, alert, confirm) into every webview and
// add webview-callable commands; WP4.2 uses notify-rust / rfd from Rust instead. global-shortcut adds no script.
for (const dep of ["tauri-plugin-shell", "tauri-plugin-fs", "tauri-plugin-http", "tauri-plugin-sql", "rusqlite", "tauri-plugin-notification", "tauri-plugin-dialog", "tauri-plugin-clipboard-manager"]) {
  check(!new RegExp(`^\\s*${dep}\\s*=`, "m").test(cargo), `Cargo.toml has no ${dep}`);
}
const rs = walk(join(tauriDir, "src")).filter((f) => f.endsWith(".rs") || f.endsWith(".js"));
for (const f of rs) {
  // Production code only: comments and #[cfg(test)] modules (which assert these very things) are skipped.
  const src = readFileSync(f, "utf8").split("#[cfg(test)]")[0].replace(/^\s*\/\/.*$/gm, "");
  const rel = f.slice(tauriDir.length + 1);
  if (/process::Command|Command::new/.test(src)) bad(`${rel}: spawns a process`);
  if (/localStorage|sessionStorage/.test(src)) bad(`${rel}: touches web storage`);
  if (/:1940\b|:1939\b/.test(src)) bad(`${rel}: references a vault/hub URL`);
}
ok("Rust/JS shell sources: no process spawning, no web storage, no vault/hub URL");

// 6. dist-native
if (!existsSync(dist)) {
  bad("apps/web/dist-native missing — run with --build (or npm run build:native -w @prism/web)");
} else {
  const files = walk(dist);
  check(!files.some((f) => /(^|\/)(sw|registerSW|workbox-[^/]*)\.js$|\.webmanifest$/.test(f)), "no service worker / manifest in dist-native");
  const js = files.filter((f) => f.endsWith(".js") || f.endsWith(".html")).map((f) => readFileSync(f, "utf8")).join("\n");
  const total = (js.match(/localhost:1940/g) ?? []).length;
  // Known-inert UI strings from the shared UI (placeholders, desktop vault-switcher default,
  // the server-side hub hint). Each pattern contains exactly one occurrence.
  const INERT = [
    /placeholder:"http:\/\/localhost:1940"/g,
    /hint:"The Parachute hub root, e\.g\. http:\/\/localhost:1940\."/g,
    /url:"http:\/\/localhost:1940",isActive/g,
    /activeVaultUrl:"http:\/\/localhost:1940"/g,
    /useState\(\w+\|\|"http:\/\/localhost:1940"\)/g,
  ];
  const inert = INERT.reduce((n, re) => n + (js.match(re) ?? []).length, 0);
  check(
    total === inert,
    `dist-native: ${total} localhost:1940 string(s), all inert UI placeholders/defaults`,
    `dist-native: ${total - inert} unexplained localhost:1940 occurrence(s) — a new vault URL crept into the bundle`,
  );
  check(js.includes("__PRISM_HOST__"), "bundle reads the host hook");
  // WP4.3: no vault credential is baked into the bundle. (The shared UI still contains the legacy
  // desktop Settings form's field NAMES `parachute_api_key` / `collab_token`; that form is gated off
  // in this shell and its config commands are refused by the shim, checked below.)
  const tokenShapes = [/\bpvt_[A-Za-z0-9]{8,}/, /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./, /\bpd_[A-Za-z0-9_-]{20,}/, /\bpp_[A-Za-z0-9_-]{20,}/];
  const hits = tokenShapes.filter((re) => re.test(js)).map(String);
  check(hits.length === 0, "dist-native: no vault/device/PAT token-shaped literal", `dist-native contains token-shaped literal(s): ${hits.join(" ")}`);
}

// 7. WP4.3: the client path holds no vault token
{
  const shellSrc = rs.map((f) => readFileSync(f, "utf8").split("#[cfg(test)]")[0].replace(/^\s*\/\/.*$/gm, "")).join("\n");
  check(
    !/parachute_api_key|collab_token|PARACHUTE_TOKEN|COLLAB_TOKEN|pvt_|vault:[a-z0-9_-]+:(read|write|admin)/.test(shellSrc),
    "Rust/JS shell: no vault-token config key, env var or scope",
  );
  const settingsRs = readFileSync(join(tauriDir, "src/settings.rs"), "utf8").split("#[cfg(test)]")[0];
  const fields = [...settingsRs.matchAll(/^\s*pub\s+([a-z_]+)\s*:/gm)].map((m) => m[1]);
  check(
    fields.length > 0 && !fields.some((f) => /token|key|secret|password|parachute|collab|vault/.test(f)),
    `client-settings.json fields carry no credential (${fields.join(", ")})`,
  );
  const shim = readFileSync(resolve(root, "apps/web/src/tauri-shim/core.ts"), "utf8");
  check(
    !/case\s+"(update_config|get_collab_config|set_anthropic_key|api_request|acl_request)"/.test(shim),
    "web shim routes none of the desktop config/credential commands (update_config, get_collab_config, …)",
  );
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nverify-client — all checks passed");
