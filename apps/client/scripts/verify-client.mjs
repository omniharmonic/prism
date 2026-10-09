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
 *  4. each capability file lists exactly its window's commands (main: 9; quick-capture: 1, never get_token);
 *     no core:*, fs, shell, opener, http, dialog, notification, global-shortcut or remote grants (WP4.2);
 *  5. Rust: no process spawning, no vault port, no fs/shell/http/sql plugins;
 *  6. dist-native: no service worker; the only `localhost:1940` strings are the known inert
 *     UI placeholders/defaults of the shared UI (desktop vault-switcher, server-side hub hint) —
 *     nothing new may appear, and the CSP forbids connecting there regardless; no token-shaped literal;
 *  7. WP4.3 "no vault token on the client": the shell names no vault-token key/env/scope, the settings
 *     file has no credential field, and the web shim routes none of the desktop config commands;
 *  8. Client parity C: img-src stays exactly 'self' data: blob: + the server (external images and the
 *     basemap come through the server's /api/media + /api/map proxies, never a widened CSP), and the
 *     bundle carries the proxy wiring (blob-URL image proxy, prismmap:// basemap protocol);
 *  9. Links + New Page (NP-NA-04 / NP-SB-13): the prism:// scheme is the only registered URL type; no
 *     Associated Domains host is committed (the entitlement is generated per install by universal-links.mjs,
 *     whose self-test runs here); an incoming link reaches the page only as a validated path through the
 *     host hook — no new IPC command, no navigation; the File menu has "New Page" on CmdOrCtrl+N;
 *     the IPC surface is pinned per platform (desktop: 9 main-window commands + quick_capture; iOS: its own
 *     exact list, pinned separately in §10);
 * 10. WP5 iOS: the iOS capability is iOS-only and grants exactly the shared sign-in/server/link commands,
 *     export_note + save_export (→ the share sheet) and the six iOS commands (never quick capture / notify), the desktop
 *     capability never reaches iOS, the Swift plugin registers no webview-callable command and is linked
 *     for iOS only; identity (same bundle id, display name "Prism", version/build, deployment target),
 *     Info.plist (no export-compliance encryption, Face ID usage string, no arbitrary loads, exactly the
 *     prism:// URL scheme), entitlements (aps-environment=production, no committed associated domains),
 *     opaque 1024 app icon, settings stored inside the app container, the CSP/origin seam (unconfigured =
 *     no server), links (no server = every link refused; a link waits for the app lock), and the sign-in
 *     redirect returning through ASWebAuthenticationSession (never through links.rs).
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
// Client parity C: external images + the basemap are PROXIED by the server — img-src never widens.
const img = dirs["img-src"] ?? [];
check(
  img.length === 4 && img[0] === "'self'" && img[1] === "data:" && img[2] === "blob:" && img[3] === remote[0],
  `img-src = 'self' data: blob: ${remote[0]} (external images come through /api/media/proxy as blob: URLs)`,
  `img-src must be exactly 'self' data: blob: <server>, got: ${img.join(" ")}`,
);
check(!/openfreemap|tile|\*/i.test(csp), "CSP names no tile host and no wildcard host (basemap comes through /api/map)");
// Embeds in the apps (owner decision c.7, 2026-10-08): YouTube (no-cookie) and Vimeo ONLY, each
// scoped to its player path. Everything else the PWA frames stays an "Open in …" card.
const EMBED_PLAYERS = ["https://www.youtube-nocookie.com/embed/", "https://player.vimeo.com/video/"];
const frame = dirs["frame-src"] ?? [];
check(
  frame.length === 3 && frame[0] === "'self'" && frame[1] === EMBED_PLAYERS[0] && frame[2] === EMBED_PLAYERS[1],
  `frame-src = 'self' + the two embed players (${EMBED_PLAYERS.join(" ")})`,
  `frame-src must be exactly 'self' ${EMBED_PLAYERS.join(" ")}, got: ${frame.join(" ")}`,
);
{
  const originSrc = readFileSync(join(tauriDir, "src/origin.rs"), "utf8").split("#[cfg(test)]")[0];
  const listed = [...(originSrc.match(/pub const EMBED_FRAME_SOURCES: \[&str; 2\] = \[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check(JSON.stringify(listed) === JSON.stringify(EMBED_PLAYERS), "origin.rs EMBED_FRAME_SOURCES = the same two players (runtime CSP + navigation rule)", `origin.rs lists: ${listed.join(" ")}`);
  check(/None => "frame-src 'self'"\.to_string\(\)/.test(originSrc), "unconfigured (first-run) CSP frames nothing remote");
  const hook = readFileSync(join(tauriDir, "src/host.js"), "utf8");
  const advertised = [...(hook.match(/var FRAME_ORIGINS = Object\.freeze\(\[([^\]]*)\]\)/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check(JSON.stringify(advertised) === JSON.stringify(EMBED_PLAYERS.map((s) => new URL(s).origin)), "host.js frameOrigins = the origins of the same two players", `host.js advertises: ${advertised.join(" ")}`);
  check(/return currentOrigin\(\) \? FRAME_ORIGINS : NO_FRAMES;/.test(hook), "host.js advertises no player before a server is configured");
  const win = readFileSync(join(tauriDir, "src/window.rs"), "utf8").split("#[cfg(test)]")[0];
  check(/\(embeds && crate::origin::is_embed_player_url\(url\)\)/.test(win) && /origin\(\)\.is_some\(\);\s*let d = navigation_decision\(url, embeds\)/.test(win), "navigation rule lets ONLY those player paths load, and only with a server configured");
  const capture = readFileSync(join(tauriDir, "src/capture_window.rs"), "utf8");
  check(/navigation_decision\(url, false\)/.test(capture), "the quick-capture window frames no player");
  const views = readFileSync(resolve(root, "packages/core/src/lib/tiptap/mediaViews.ts"), "utf8");
  const embeds = readFileSync(resolve(root, "packages/core/src/lib/media/embeds.ts"), "utf8");
  check(/EMBED_SANDBOX_NATIVE = "allow-scripts allow-same-origin allow-presentation"/.test(embeds) && /sandbox: isNative\(\) \? EMBED_SANDBOX_NATIVE : EMBED_SANDBOX/.test(views), "in the apps an embed's sandbox has NO allow-popups (the block's \"Open in …\" link is the way out)");
}
check(conf.app?.withGlobalTauri === false, "withGlobalTauri is off (no window.__TAURI__ API surface)");

// 3. frontend
check(!conf.build?.devUrl, "no devUrl (dev also serves the bundled native build)");
check(conf.build?.frontendDist === "../../web/dist-native", "frontendDist is apps/web/dist-native");
check(JSON.stringify(conf.build).includes("build:native"), "before{Dev,Build}Command builds the native web bundle");

// 4. capabilities: each capability file lists EXACTLY its window's commands (WP4.2).
const EXPECTED_CAPS = {
  "default.json": {
    windows: ["main"],
    permissions: ["allow-get-token", "allow-sign-in", "allow-sign-out", "allow-get-server-origin", "allow-set-server-origin", "allow-open-external", "allow-notify", "allow-export-note", "allow-save-export"],
  },
  // The capture window gets ONE command and never get_token: the bearer must not enter that webview.
  "quick-capture.json": { windows: ["quick-capture"], permissions: ["allow-quick-capture"] },
  // WP5 iOS — pinned separately from the desktop list: the shared sign-in/server/link commands,
  // export_note + save_export (→ the system share sheet) and the six iOS commands; never
  // quick_capture or notify.
  "mobile.json": {
    windows: ["main"],
    permissions: [
      "allow-get-token", "allow-sign-in", "allow-sign-out", "allow-get-server-origin", "allow-set-server-origin", "allow-open-external",
      "allow-export-note", "allow-save-export",
      "allow-reset-server", "allow-get-app-settings", "allow-set-app-lock", "allow-push-register", "allow-push-status", "allow-push-take-opened",
    ],
  },
};
const EXPECTED_PLATFORMS = {
  "default.json": ["macOS", "windows", "linux"],
  "quick-capture.json": ["macOS", "windows", "linux"],
  "mobile.json": ["iOS"],
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
  check(
    JSON.stringify([...(cap.platforms ?? [])].sort()) === JSON.stringify([...(EXPECTED_PLATFORMS[f] ?? ["<missing>"])].sort()),
    `${f}: platforms ${JSON.stringify(cap.platforms)}`,
    `${f}: platforms are ${JSON.stringify(cap.platforms)}, expected ${JSON.stringify(EXPECTED_PLATFORMS[f])}`,
  );
  for (const p of perms) granted.set(p, [...(granted.get(p) ?? []), ...(cap.windows ?? [])]);
}
check(!(granted.get("allow-get-token") ?? []).includes("quick-capture"), "quick-capture window can NOT call get_token");
check((granted.get("allow-quick-capture") ?? []).join() === "quick-capture", "quick_capture is granted to the quick-capture window only");
// Every command declared in build.rs is granted to some window, and nothing else is granted.
const buildRs = readFileSync(join(tauriDir, "build.rs"), "utf8");
const declared = [...buildRs.matchAll(/^\s*"([a-z_]+)",\s*(?:\/\/.*)?$/gm)].map((m) => `allow-${m[1].replace(/_/g, "-")}`);
check(
  declared.length === 16 && declared.every((d) => granted.has(d)) && [...granted.keys()].every((g) => declared.includes(g)),
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
const pluginDir = join(tauriDir, "plugins/prism-ios");
const rs = [...walk(join(tauriDir, "src")), ...walk(join(pluginDir, "src")), ...walk(join(pluginDir, "ios/Sources"))].filter(
  (f) => f.endsWith(".rs") || f.endsWith(".js") || f.endsWith(".swift"),
);
for (const f of rs) {
  // Production code only: comments and #[cfg(test)] modules (which assert these very things) are skipped.
  const src = readFileSync(f, "utf8").split("#[cfg(test)]")[0].replace(/^\s*\/\/.*$/gm, "");
  const rel = f.slice(tauriDir.length + 1);
  if (/process::Command|Command::new|\bProcess\(\)|posix_spawn/.test(src)) bad(`${rel}: spawns a process`);
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
  // Client parity C: the native bundle carries the proxy wiring.
  check(js.includes("/api/media/proxy?u="), "bundle routes external images through /api/media/proxy (blob: URLs)");
  check(js.includes("prismmap") && js.includes("/api/map/"), "bundle routes the basemap through the prismmap:// protocol → /api/map");
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

// 9. Links + New Page (NP-NA-04 / NP-SB-13)
{
  const plist = readFileSync(join(tauriDir, "Info.plist"), "utf8");
  const schemes = [...(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  check(JSON.stringify(schemes) === JSON.stringify(["prism"]), "Info.plist registers exactly the prism:// scheme", `URL schemes: ${schemes.join(", ")}`);
  // The server host is per-install: nothing committed may carry an Associated Domains entitlement.
  const committed = [JSON.stringify(conf), plist, ...readdirSync(tauriDir).filter((f) => /\.(entitlements|plist|json)$/.test(f)).map((f) => readFileSync(join(tauriDir, f), "utf8"))].join("\n");
  check(!/associated-domains|applinks:/.test(committed) && !conf.bundle?.macOS?.entitlements, "no Associated Domains entitlement is committed (generated per install)");
  const ignore = readFileSync(join(tauriDir, ".gitignore"), "utf8");
  check(/^\/gen\/universal-links$/m.test(ignore), "gen/universal-links (the generated entitlement) is git-ignored");
  try {
    execSync(`node ${JSON.stringify(join(here, "universal-links.mjs"))} --self-test`, { stdio: "pipe" });
    ok("universal-links.mjs self-test (host validation, entitlement generation, idempotent iOS patch)");
  } catch (e) {
    bad(`universal-links.mjs self-test failed: ${String(e.stderr ?? e.message).trim()}`);
  }
  const src = (f) => readFileSync(join(tauriDir, "src", f), "utf8").split("#[cfg(test)]")[0];
  const links = src("links.rs");
  const code = links.replace(/^\s*\/\/.*$/gm, "");
  check(/RunEvent::Opened/.test(src("lib.rs")) && /links::on_opened/.test(src("lib.rs")), "lib.rs routes RunEvent::Opened to links::on_opened");
  check(/on_page_load/.test(src("window.rs")), "the main window re-offers a pending link after a page load (sign-in reload)");
  check(!/\.navigate\(|open_url|opener\(|location/.test(code), "links.rs never navigates and never opens a URL");
  check(/__PRISM_SHELL__\.openLink\(/.test(code) && !/tauri::command/.test(code), "an incoming link is a DOM handoff of a validated path — no IPC command");
  const hostJs = readFileSync(join(tauriDir, "src/host.js"), "utf8");
  check(/openLink: openLink/.test(hostJs) && /takePendingLink: takePendingLink/.test(hostJs) && /new CustomEvent\("prism:open-link"\)/.test(hostJs), "host hook exposes openLink/takePendingLink and a payload-free prism:open-link event");
  const menu = src("menu.rs");
  check(/NEW_PAGE_ACCELERATOR: &str = "CmdOrCtrl\+N"/.test(menu) && /"New Page"/.test(menu) && /new CustomEvent\(\\"prism:new-page\\"\)/.test(menu), "File menu: New Page on CmdOrCtrl+N → prism:new-page");
  // The IPC surface is pinned PER PLATFORM. Desktop: links and New Page added NO command; `save_export`
  // (export archives) is the ninth main-window command, added deliberately. iOS (WP5): the six shared
  // commands + export_note + save_export (both end in the share sheet) + six iOS-only ones — its own
  // exact list of 14. Anything else here is a change to review.
  const MAIN = ["get_token", "sign_in", "sign_out", "get_server_origin", "set_server_origin", "open_external", "notify", "export_note", "save_export"];
  const IOS_ONLY = ["reset_server", "get_app_settings", "set_app_lock", "push_register", "push_status", "push_take_opened"];
  const IOS_MAIN = [...MAIN.filter((c) => c !== "notify"), ...IOS_ONLY];
  const declaredNames = [...buildRs.matchAll(/^\s*"([a-z_]+)",\s*(?:\/\/.*)?$/gm)].map((m) => m[1]);
  check(
    JSON.stringify(declaredNames) === JSON.stringify([...MAIN.slice(0, 6), "quick_capture", ...MAIN.slice(6), ...IOS_ONLY]),
    `build.rs declares exactly ${MAIN.length} desktop main-window commands + quick_capture + ${IOS_ONLY.length} iOS-only commands`,
    `build.rs declares [${declaredNames.join(", ")}]`,
  );
  const capPerms = (f) => JSON.parse(readFileSync(join(tauriDir, "capabilities", f), "utf8")).permissions.map((p) => p.replace(/^allow-/, "").replace(/-/g, "_"));
  check(
    JSON.stringify(capPerms("default.json")) === JSON.stringify(MAIN),
    `desktop IPC surface is exactly ${MAIN.length} main-window commands (+ quick_capture in its own window)`,
    `default.json grants [${capPerms("default.json").join(", ")}]`,
  );
  check(
    JSON.stringify(capPerms("mobile.json")) === JSON.stringify(IOS_MAIN),
    `iOS IPC surface is exactly ${IOS_MAIN.length} main-window commands (${IOS_MAIN.join(", ")})`,
    `mobile.json grants [${capPerms("mobile.json").join(", ")}]`,
  );
  check(!IOS_ONLY.some((c) => capPerms("default.json").includes(c) || capPerms("quick-capture.json").includes(c)), "no desktop window is granted an iOS-only command");
  const handlers = [...readFileSync(join(tauriDir, "src/lib.rs"), "utf8").matchAll(/^\s*(?:commands|native_cmds|mobile_cmds)::([a-z_]+),$/gm)].map((m) => m[1]).sort();
  check(JSON.stringify(handlers) === JSON.stringify([...declaredNames].sort()), "lib.rs registers exactly the declared commands", `handlers: ${handlers.join(", ")}`);
  // host.js: everything outside the `ios` wrapper object calls desktop main-window commands only; the
  // `ios` object (exposed only when the shell says platform = ios) calls iOS-granted commands only.
  const iosBlock = /\n  var ios = \{[\s\S]*?\n  \};\n/.exec(hostJs)?.[0] ?? "";
  const cmdsIn = (src) => [...new Set([...src.matchAll(/ipc\(\s*"([a-z_]+)"/g)].map((m) => m[1]))].sort();
  const hostCmds = cmdsIn(hostJs.replace(iosBlock, ""));
  const iosCmds = cmdsIn(iosBlock);
  check(hostCmds.every((c) => MAIN.includes(c)), "host.js (shared part) invokes only desktop main-window commands", `host.js invokes: ${hostCmds.join(", ")}`);
  check(
    iosBlock !== "" && iosCmds.length > 0 && iosCmds.every((c) => IOS_MAIN.includes(c)) && IOS_ONLY.every((c) => iosCmds.includes(c)),
    "host.js `ios` wrappers invoke only iOS-granted commands, and every iOS-only command has a wrapper",
    `host.js ios wrappers invoke: ${iosCmds.join(", ")}`,
  );
  check(/ios: IOS \? Object\.freeze\(ios\) : null/.test(hostJs), "host.js exposes the iOS wrappers only on iOS (frozen), null elsewhere");
  // save_export: the page passes an id and a name; Rust builds the URL, refuses redirects, and no download handler exists.
  const archive = src("export_archive.rs").replace(/^\s*\/\/.*$/gm, "");
  const saveSig = /pub async fn save_export[\s\S]*?\) ->/.exec(src("native_cmds.rs"))?.[0] ?? "";
  check(saveSig !== "" && !/path|url|token|origin/i.test(saveSig), "save_export takes no path, URL, token or origin from the page");
  check(/redirect\(reqwest::redirect::Policy::none\(\)\)/.test(archive) && /create_new\(true\)/.test(archive) && /origin\.join\(/.test(archive), "export_archive.rs: no redirects, a fresh temp file, URL built from the configured origin");
  check(!/on_download|download_started|download_completed/.test(src("window.rs")), "the webview has NO download handler (page script cannot start downloads)");
  const webLinks = readFileSync(resolve(root, "apps/web/src/native/appLinks.ts"), "utf8");
  check(/takePendingLink/.test(webLinks) && /prism:open-link/.test(webLinks) && !/location\.(assign|replace|href\s*=)/.test(webLinks), "web: appLinks.ts takes the path from the shell and opens a tab — never a navigation");
}

// 10. WP5 iOS
{
  const plist = (file) => readFileSync(file, "utf8");
  // <key>K</key> followed by its value element (dependency-free; the files are small, flat and ours).
  const value = (xml, key) => {
    const m = xml.match(new RegExp(`<key>${key}</key>\\s*(<(true|false)\\s*/>|<string>([^<]*)</string>|<array>[\\s\\S]*?</array>|<dict>[\\s\\S]*?</dict>)`));
    if (!m) return undefined;
    if (m[2]) return m[2] === "true";
    return m[3] ?? m[1];
  };
  const iosConf = JSON.parse(readFileSync(join(tauriDir, "tauri.ios.conf.json"), "utf8"));
  check(!iosConf.identifier || iosConf.identifier === conf.identifier, `iOS bundle id = ${conf.identifier} (the registered App ID; same keychain service)`);
  check(iosConf.productName === "Prism", `iOS product/display name "Prism" (App Store name "Prism Workspace" is set in App Store Connect)`);
  check(conf.version === "0.1.0" && /^\d+$/.test(iosConf.bundle?.iOS?.bundleVersion ?? ""), `iOS version ${conf.version} build ${iosConf.bundle?.iOS?.bundleVersion}`);
  check(iosConf.bundle?.iOS?.minimumSystemVersion === "16.0", `iOS deployment target ${iosConf.bundle?.iOS?.minimumSystemVersion}`);
  check(iosConf.bundle?.iOS?.developmentTeam === "83Y42N33H8", "iOS development team set (automatic signing)");
  check(!iosConf.app?.security?.csp, "tauri.ios.conf.json does not override the CSP (origin.rs builds it)");

  const info = plist(join(tauriDir, "Info.ios.plist"));
  check(value(info, "ITSAppUsesNonExemptEncryption") === false, "Info.ios.plist: ITSAppUsesNonExemptEncryption = false");
  check(/.{10,}/.test(value(info, "NSFaceIDUsageDescription") ?? ""), "Info.ios.plist: NSFaceIDUsageDescription present");
  // The web view's file chooser offers "Take Photo or Video": iOS ends an app that opens the camera / microphone without these.
  for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]) check(/.{10,}/.test(value(info, key) ?? ""), `Info.ios.plist: ${key} present (file chooser → Take Photo or Video)`);
  check(value(info, "CFBundleDisplayName") === "Prism", "Info.ios.plist: display name Prism");
  check(!/NSAppTransportSecurity|NSAllows|NSExceptionDomains/.test(info), "Info.ios.plist (merged into every build): no ATS key at all");
  // Links (NP-NA-04): iOS registers exactly the prism:// scheme, like macOS. The sign-in redirect
  // prism://auth/callback is still NOT a link: the session returns it to signin.rs (checked below).
  const iosSchemes = (xml) => [...(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  check(JSON.stringify(iosSchemes(info)) === JSON.stringify(["prism"]), "Info.ios.plist registers exactly the prism:// scheme", `iOS URL schemes: ${iosSchemes(info).join(", ")}`);

  const apple = join(tauriDir, "gen/apple");
  const projectYml = readFileSync(join(apple, "project.yml"), "utf8");
  const pbx = readFileSync(join(apple, "prism-client.xcodeproj/project.pbxproj"), "utf8");
  const genInfo = plist(join(apple, "prism-client_iOS/Info.plist"));
  check(!/NSAppTransportSecurity/.test(genInfo), "gen/apple Info.plist (Release): no ATS key");
  check(JSON.stringify(iosSchemes(genInfo)) === JSON.stringify(["prism"]), "gen/apple Info.plist: exactly the prism:// scheme");
  check(/.{10,}/.test(value(genInfo, "NSFaceIDUsageDescription") ?? ""), "gen/apple Info.plist: NSFaceIDUsageDescription present");
  for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]) check(/.{10,}/.test(value(genInfo, key) ?? ""), `gen/apple Info.plist: ${key} present`);
  check(!/UIBackgroundModes/.test(info + genInfo), "no background modes (pushes are visible alerts; nothing runs in the background)");
  check(
    /Debug-only ATS loopback exception/.test(projectYml) && /if \[ "\$\{CONFIGURATION\}" = "debug" \]; then[\s\S]*NSAllowsLocalNetworking/.test(projectYml) && /Debug-only ATS loopback exception/.test(pbx),
    "ATS loopback exception is added by a Debug-only build phase (never Release)",
  );
  const originSrc = readFileSync(join(tauriDir, "src/origin.rs"), "utf8");
  check(/ALLOW_HTTP_LOOPBACK: bool = cfg!\(any\(not\(target_os = "ios"\), debug_assertions\)\)/.test(originSrc) && /loopback && ALLOW_HTTP_LOOPBACK/.test(originSrc), "origin.rs: http loopback refused in iOS release builds");
  const ents = plist(join(apple, "prism-client_iOS/prism-client_iOS.entitlements"));
  const dents = plist(join(apple, "prism-client_iOS/prism-client_iOS.debug.entitlements"));
  check(value(ents, "aps-environment") === "production", "Release entitlements: aps-environment = production (TestFlight/App Store)");
  check(value(dents, "aps-environment") === "development", "Debug entitlements: aps-environment = development");
  // Associated Domains (universal links) is written per install by `universal-links.mjs --ios` and never
  // committed: a host here would ship one install's server name to everyone.
  for (const [n, e] of [["Release", ents], ["Debug", dents]]) {
    check(!/associated-domains|applinks:|keychain-access-groups|get-task-allow/.test(e), `${n} entitlements (committed): nothing but aps-environment`);
  }
  check(
    /CODE_SIGN_ENTITLEMENTS = "prism-client_iOS\/prism-client_iOS\.debug\.entitlements"/.test(pbx) && /CODE_SIGN_ENTITLEMENTS = "prism-client_iOS\/prism-client_iOS\.entitlements"/.test(pbx),
    "Xcode project: Debug → development entitlements, Release → production",
  );
  const privacy = plist(join(apple, "prism-client_iOS/PrivacyInfo.xcprivacy"));
  check(
    /NSPrivacyAccessedAPICategoryFileTimestamp[\s\S]*C617\.1/.test(privacy) && /NSPrivacyAccessedAPICategorySystemBootTime[\s\S]*35F9\.1/.test(privacy) && value(privacy, "NSPrivacyTracking") === false,
    "PrivacyInfo.xcprivacy: file timestamp C617.1, system boot time 35F9.1, no tracking",
  );
  check(/PrivacyInfo\.xcprivacy in Resources/.test(pbx), "PrivacyInfo.xcprivacy is copied into the bundle");
  const exportOpts = plist(join(apple, "ExportOptions.plist"));
  check(value(exportOpts, "method") === "app-store-connect" && value(exportOpts, "signingStyle") === "manual", "ExportOptions.plist: app-store-connect, manual signing (no stale 'debugging')");
  const adhocOpts = plist(join(apple, "ExportOptions.adhoc.plist"));
  check(
    value(adhocOpts, "method") === "release-testing" && value(adhocOpts, "signingStyle") === "manual" && value(adhocOpts, "teamID") === "83Y42N33H8" && new RegExp(`<key>${conf.identifier.replace(/\./g, "\\.")}</key><string>Prism Workspace Ad Hoc</string>`).test(adhocOpts),
    "ExportOptions.adhoc.plist: release-testing (device pass), manual signing, the Ad Hoc profile",
  );
  check(projectYml.includes(`PRODUCT_BUNDLE_IDENTIFIER: ${conf.identifier}`), "Xcode project bundle id matches");
  const icon = readFileSync(join(apple, "Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"));
  // PNG IHDR: width/height at 16/20, colour type at 25 (2 = RGB, no alpha; App Store rejects alpha).
  check(
    icon.readUInt32BE(16) === 1024 && icon.readUInt32BE(20) === 1024 && icon[25] === 2,
    "App Store icon: 1024x1024, opaque RGB",
    `App Store icon must be 1024x1024 RGB without alpha (got ${icon.readUInt32BE(16)}x${icon.readUInt32BE(20)}, colour type ${icon[25]})`,
  );

  check(/target\.'cfg\(target_os = "ios"\)'\.dependencies\]\s*\ntauri-plugin-prism-ios/.test(cargo), "Swift plugin is linked for iOS only");
  const pluginBuild = readFileSync(join(pluginDir, "build.rs"), "utf8");
  const pluginLib = readFileSync(join(pluginDir, "src/lib.rs"), "utf8");
  check(/const COMMANDS: &\[&str\] = &\[\];/.test(pluginBuild) && !/invoke_handler/.test(pluginLib), "Swift plugin registers no webview-callable command");
  const swift = readFileSync(join(pluginDir, "ios/Sources/PrismIos/PrismIosPlugin.swift"), "utf8");
  const evals = [...swift.matchAll(/evaluateJavaScript\(\s*"([^"]*)"/g)].map((m) => m[1]);
  check(
    evals.length === 1 && evals[0] === "window.dispatchEvent(new CustomEvent('prism:native-push-opened'))" && (swift.match(/evaluateJavaScript/g) ?? []).length === 1,
    "Swift evaluates exactly one fixed, data-free script (the push-opened ping)",
  );
  check(/prefersEphemeralWebBrowserSession = false/.test(swift), "sign-in sheet shares Safari cookies (non-ephemeral)");
  const lockSrc = readFileSync(join(pluginDir, "ios/Sources/PrismIos/LockPolicy.swift"), "utf8");
  check(/mach_continuous_time\(\)/.test(lockSrc) && !/Date\(\)/.test(swift + lockSrc) && /LockPolicy\.shouldLock/.test(swift), "lock timer: monotonic clock that counts sleep (no wall clock)");
  check(
    /windowLevel = \.alert \+ 1/.test(swift) && /isUserInteractionEnabled = !value/.test(swift) && /endEditing\(true\)/.test(swift),
    "lock cover: its own window above alerts/sheets; webview disabled + unfocused while locked",
  );
  check(
    (swift.match(/AppLock\.shared\.isLocked/g) ?? []).length >= 3,
    "authenticate / confirm / verifyOwner refuse while locked",
  );
  check(!/profileApsEnvironment\(\) \?\? "sandbox"|return "sandbox"/.test(swift), "Swift never decides 'sandbox' itself (Rust apns_environment: no profile = production)");
  if (process.platform === "darwin") {
    try {
      execSync(`bash ${JSON.stringify(join(here, "ios-policy-tests/run.sh"))}`, { stdio: "pipe" });
      ok("lock policy tests (swiftc) pass");
    } catch (e) {
      bad(`lock policy tests failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
  }
  const hostJs = readFileSync(join(tauriDir, "src/host.js"), "utf8");
  check(/ipc\("get_token", \{ origin: currentOrigin\(\) \}\)/.test(hostJs) && /document\.head\.querySelector\('meta\[name="prism-server-origin"\]'\)/.test(hostJs), "host.js: token asked for the page's origin; origin meta read from <head> only");
  check(/\.deviceOwnerAuthentication\b/.test(swift) && !/deviceOwnerAuthenticationWithBiometrics, localizedReason/.test(swift), "app lock uses deviceOwnerAuthentication (passcode fallback)");
  const lockScreenCover = /contentInsetAdjustmentBehavior = \.never/.test(swift) && /allowsBackForwardNavigationGestures = false/.test(swift);
  check(lockScreenCover, "webview: safe areas owned by the page, no back-swipe navigation");

  const settingsSrc = readFileSync(join(tauriDir, "src/settings.rs"), "utf8");
  check(/target_os = "ios"[\s\S]*?"HOME"[\s\S]*?"Application Support"/.test(settingsSrc), "iOS settings live inside the app container (Library/Application Support)");
  const secure = readFileSync(join(tauriDir, "src/secure_store.rs"), "utf8");
  check(/AccessibleAfterFirstUnlockThisDeviceOnly/.test(secure), "keychain item: AfterFirstUnlockThisDeviceOnly");
  const originRs = readFileSync(join(tauriDir, "src/origin.rs"), "utf8").split("#[cfg(test)]")[0];
  check(/None => "connect-src 'self' ipc: http:\/\/ipc\.localhost"\.to_string\(\)/.test(originRs), "unconfigured (first-run) CSP reaches no server");
  const pkce = readFileSync(join(tauriDir, "src/pkce.rs"), "utf8");
  check(/MOBILE_REDIRECT_URI: &str = "prism:\/\/auth\/callback"/.test(pkce), "iOS redirect = prism://auth/callback (server default DEVICE_REDIRECT_URIS)");
  const serverCfg = readFileSync(resolve(root, "apps/server/src/config.ts"), "utf8");
  check(/NATIVE_ORIGINS \?\? "tauri:\/\/localhost/.test(serverCfg) && /DEVICE_REDIRECT_URIS \?\? "prism:\/\/auth\/callback"/.test(serverCfg), "server defaults already allow the iOS origin (tauri://localhost) and redirect");

  // Sign-in callback: the sheet's URL goes Swift → signin.rs → pkce::code_from_redirect (exact redirect +
  // state) → exchange with the verifier. It never passes through links.rs, which drops auth URLs silently.
  const prodSrc = (f) => readFileSync(join(tauriDir, "src", f), "utf8").split("#[cfg(test)]\nmod tests")[0];
  const signin = prodSrc("signin.rs");
  const iosArm = signin.slice(signin.indexOf('#[cfg(target_os = "ios")]'));
  check(
    /ios\.authenticate\(&url, MOBILE_CALLBACK_SCHEME\)\.await\?/.test(iosArm) &&
      /code_from_redirect\(&returned, MOBILE_REDIRECT_URI, &pkce\.state\)\?/.test(iosArm) &&
      /exchange_code\(&origin, &code, &pkce\.verifier, MOBILE_REDIRECT_URI\)/.test(iosArm) &&
      !/links::/.test(signin),
    "iOS sign-in: callback URL from the session → exact-redirect + state check → PKCE exchange (never via links.rs)",
  );
  check(/invoke\.resolve\(\["url": callback\.absoluteString\]\)/.test(swift), "Swift returns the session's callback URL to the caller (no openURL hop)");
  const linksRs = prodSrc("links.rs");
  check(/Some\(h\) if !h\.is_empty\(\) => h\.eq_ignore_ascii_case\("auth"\)/.test(linksRs) && /\("page" \| "collab", Some\(id\)\)/.test(linksRs) && !/"auth" =>|\("auth",/.test(linksRs), "links.rs: prism://auth/* is never a route");
  // Optional origin: no server = nothing accepted or kept; macOS always has one (build default).
  check(/let Some\(origin\) = origin else \{\s*return Opened::Nothing;/.test(linksRs), "links.rs: no configured server → every link refused, nothing kept");
  const libRs = prodSrc("lib.rs");
  check(/#\[cfg\(desktop\)\]\s*let origin = Some\(saved\.unwrap_or_else\(ServerOrigin::build_default\)\);/.test(libRs) && /#\[cfg\(mobile\)\]\s*let origin = saved;/.test(libRs), "desktop always has a server origin (saved or built-in); only mobile may start without one");
  // App lock gate: a link is handed to the page only after the lock state is known AND the app is unlocked.
  check(
    /lock_ready: !cfg!\(target_os = "ios"\)/.test(linksRs) &&
      /if !inner\.page_ready \|\| !inner\.lock_ready \|\| !signed_in \|\| !unlocked \{\s*return None;/.test(linksRs) &&
      /Ok\(ios\) => ios\.wait_unlocked\(\)\.await,\s*Err\(_\) => false,/.test(linksRs),
    "links.rs: delivery waits for the app lock (unknown or unreachable lock state = keep the link)",
  );
  check(/set_lock_ready\(\);\s*links::deliver\(&handle\);/.test(libRs) && libRs.indexOf("configure_lock(lock.mode.as_str(), lock.minutes, true)") < libRs.indexOf("set_lock_ready()"), "lib.rs: links are released only after the saved lock was applied at launch");
  check(/func whenUnlocked/.test(swift) && /LockPolicy\.mayDeliverLink\(mode: mode, locked: locked, active: active, backgroundedAt: backgroundedAt\)/.test(swift) && /static func mayDeliverLink/.test(lockSrc), "Swift: waitUnlocked answers by LockPolicy.mayDeliverLink (tested)");
  // Changing or clearing the server drops the waiting link.
  check(/LinkState>\(\)\.clear\(\)/.test(prodSrc("mobile_cmds.rs")) && /LinkState>\(\)\.clear\(\)/.test(prodSrc("commands.rs")), "a server change drops the pending link");
  // First run: the probe is the only request to an unconfirmed address, and carries no credential.
  const authRs = prodSrc("auth.rs");
  const probe = authRs.slice(authRs.indexOf("pub async fn probe_server"), authRs.indexOf("const PROBE_MAX_BYTES"));
  check(
    /origin\.join\("\/health\?live=1"\)/.test(probe) && /redirect\(reqwest::redirect::Policy::none\(\)\)/.test(probe) && !/bearer_auth|cookie|token/i.test(probe.replace(/^\s*\/\/.*$/gm, "")),
    "first-run probe: GET /health?live=1, no redirect, no credential",
  );
  const cmds = prodSrc("commands.rs");
  const mobileSet = cmds.slice(cmds.indexOf("#[cfg(mobile)]", cmds.indexOf("pub async fn set_server_origin")), cmds.indexOf("#[cfg(desktop)]", cmds.indexOf("pub async fn set_server_origin")));
  check(
    mobileSet.indexOf("state.origin().is_some()") > 0 && mobileSet.indexOf("state.origin().is_some()") < mobileSet.indexOf("auth::probe_server(&parsed).await?") && mobileSet.indexOf("auth::probe_server(&parsed).await?") < mobileSet.indexOf("settings::update"),
    "iOS set_server_origin: only while no server is set; probed before it is saved",
  );
  // Export archive on iOS: Rust downloads into the app's tmp, Swift shares only from that folder, Rust deletes.
  const nat = prodSrc("native_cmds.rs");
  const iosSave = nat.slice(nat.indexOf('#[cfg(target_os = "ios")]', nat.indexOf("pub async fn save_export")));
  check(
    /archive::share_dir\(&std::env::temp_dir\(\)/.test(iosSave) && /ios\.share_file\(path\)\.await/.test(iosSave) && iosSave.indexOf("ios.share_file(path)") < iosSave.indexOf("std::fs::remove_dir_all(&dir)"),
    "iOS save_export: tmp folder → share sheet → deleted (no path, URL or token from the page)",
  );
  check(/file\.path\.hasPrefix\(root\.path \+ "\/"\)/.test(swift) && /appendingPathComponent\("prism-exports", isDirectory: true\)/.test(swift) && /shareableExtensions: Set<String> = \["zip", "md", "html"\]/.test(swift), "Swift shareFile: only a .zip/.md/.html under <tmp>/prism-exports/");
  const iosNote = nat.slice(nat.indexOf('#[cfg(target_os = "ios")]', nat.indexOf("pub async fn export_note")), nat.indexOf("pub async fn save_export"));
  check(/archive::share_dir\(&std::env::temp_dir\(\)/.test(iosNote) && iosNote.indexOf("share_file(path)") > 0 && iosNote.indexOf("share_file(path)") < iosNote.indexOf("std::fs::remove_dir_all(&dir)"), "iOS export_note: tmp folder → share sheet → deleted");
  check(/purge_share_root\(&std::env::temp_dir\(\)\)/.test(libRs), "iOS launch purges leftover export archives");
  // APNs (page half): registered with the device bearer through serverFetch; removed on sign-out.
  const apns = readFileSync(resolve(root, "apps/web/src/native/apnsPush.ts"), "utf8");
  check(/serverFetch\("\/api\/push\/apns"/.test(apns) && !/[^a-zA-Z]fetch\(/.test(apns.replace(/serverFetch\(/g, "")), "web: apnsPush.ts talks to /api/push/apns through serverFetch only");
  check(/auth::delete_apns\(&origin, &token\)/.test(cmds), "sign-out removes this device's APNs registration");
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nverify-client — all checks passed");
