/**
 * Client error capture (L-1, 2026-11-08) — dependency-free on purpose: the web shell's tiny
 * boot script installs it before the app's main chunk exists.
 *
 * The incident: during an agent's edit burst the Mac client's window turned flat grey. Nothing
 * was recorded — no console in the release web view, the macOS log needs admin, and the error
 * never reached the app's error boundary (React 19 unmounts the WHOLE root when an error escapes
 * every boundary, leaving only the page background). So:
 *
 *  - `reportClientError` keeps the last few errors on the device (localStorage, cleared at
 *    sign-out with the other device-local keys) and hands each to the shell's reporter (web:
 *    POST /api/admin/client-errors — server owner only; anyone else's POST is refused and
 *    dropped). Deduplicated (same kind + message within a minute) and budgeted per page load.
 *  - `showStoppedScreen` draws a Reload screen in plain DOM — it works when React is gone.
 *  - `startStallWatch` records main-thread stalls with a heartbeat (WebKit has no Long Tasks
 *    API, and the Mac and iOS apps ARE WebKit).
 *
 * A report holds a message, a stack, the route PATH (never its query: a share link's `?t=` must
 * not travel), the build and the platform — no note content is ever put in one.
 */

export type ClientErrorKind = "error" | "rejection" | "boundary" | "uncaught" | "stall";
export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  route?: string;
  build?: string;
  platform?: string;
  detail?: string;
  at: number;
}
type Reporter = (r: ClientErrorReport) => Promise<unknown>;

export const LAST_ERRORS_KEY = "prism:client-errors";
const KEEP = 5;
const PER_LOAD = 20;
const DEDUPE_MS = 60_000;

let reporter: Reporter | null = null;
/** Reports made before the shell installed its reporter (boot errors) are sent once it does. */
const early: ClientErrorReport[] = [];
let sent = 0;
const recent = new Map<string, number>();
let context: { build?: string; platform?: string } = {};

/** Errors that say nothing actionable (and would only spend the budget). */
export function isNoise(message: string): boolean {
  return (
    /^ResizeObserver loop/.test(message) || // a layout notification, harmless
    message === "Script error." || message === "Script error" || // opaque cross-origin error: nothing to learn
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message) || // chunk retry/reload owns these
    /^AbortError\b|The (user aborted|operation was aborted)/.test(message) // a cancelled request
  );
}

export function setClientErrorContext(c: { build?: string; platform?: string }): void {
  context = { ...context, ...c };
}

export function setClientErrorReporter(fn: Reporter | null): void {
  reporter = fn;
  if (fn) for (const r of early.splice(0)) void fn(r).catch(() => {});
}

const cap = (s: string | undefined, n: number) => (s ? s.slice(0, n) : undefined);
function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: `${err.name && err.name !== "Error" ? err.name + ": " : ""}${err.message || String(err)}`, stack: err.stack };
  if (typeof err === "string") return { message: err };
  try { return { message: JSON.stringify(err) ?? String(err) }; } catch { return { message: String(err) }; }
}

/** Record one error: kept on the device and handed to the reporter. Never throws. */
export function reportClientError(kind: ClientErrorKind, err: unknown, detail?: string): ClientErrorReport | null {
  try {
    const { message, stack } = describe(err);
    if (!message || isNoise(message)) return null;
    const now = Date.now();
    const sig = `${kind}:${message}`;
    const last = recent.get(sig);
    if (last !== undefined && now - last < DEDUPE_MS) return null;
    recent.set(sig, now);
    if (recent.size > 100) recent.delete(recent.keys().next().value!);
    const r: ClientErrorReport = {
      kind,
      message: message.slice(0, 500),
      at: now,
      ...(cap(stack, 4_000) ? { stack: cap(stack, 4_000) } : {}),
      ...(typeof location !== "undefined" ? { route: location.pathname.slice(0, 200) } : {}),
      ...(context.build ? { build: context.build } : {}),
      ...(context.platform ? { platform: context.platform } : {}),
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
    };
    try {
      const kept = JSON.parse(localStorage.getItem(LAST_ERRORS_KEY) ?? "[]") as ClientErrorReport[];
      localStorage.setItem(LAST_ERRORS_KEY, JSON.stringify([r, ...(Array.isArray(kept) ? kept : [])].slice(0, KEEP)));
    } catch { /* private mode / quota: the report still goes to the server */ }
    if (sent < PER_LOAD) {
      sent++;
      if (reporter) void reporter(r).catch(() => {});
      else if (early.length < PER_LOAD) early.push(r);
    }
    return r;
  } catch {
    return null;
  }
}

/** The errors kept on this device, newest first. */
export function lastClientErrors(): ClientErrorReport[] {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_ERRORS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as ClientErrorReport[]) : [];
  } catch { return []; }
}

/**
 * Plain-DOM "Prism stopped" screen with a Reload button, in `#root` (or `<body>`). For when the
 * React root is gone: it must not depend on React, the app's stylesheet or the theme tokens.
 */
export function showStoppedScreen(message?: string): void {
  try {
    const host = document.getElementById("root") ?? document.body;
    if (!host || host.querySelector("[data-prism-stopped]")) return;
    const dark = document.documentElement.classList.contains("dark");
    const panel = document.createElement("div");
    panel.setAttribute("role", "alert");
    panel.setAttribute("data-prism-stopped", "");
    panel.style.cssText = `position:fixed;inset:0;display:grid;place-items:center;padding:24px;z-index:2147483647;background:${dark ? "#0f0f10" : "#ffffff"};color:${dark ? "#ececee" : "#1b1b1f"};font:15px/1.6 system-ui,-apple-system,sans-serif`;
    const box = document.createElement("div");
    box.style.cssText = "max-width:440px";
    const title = document.createElement("h1");
    title.textContent = "Prism stopped working";
    title.style.cssText = "font-size:22px;margin:0 0 8px";
    const text = document.createElement("p");
    text.textContent = "Reload to continue. Your saved work is safe, and edits to live pages are kept on this device until they sync.";
    text.style.margin = "0 0 16px";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload Prism";
    reload.style.cssText = "min-height:44px;padding:10px 18px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;cursor:pointer";
    reload.onclick = () => window.location.reload();
    box.append(title, text, reload);
    if (message) {
      const d = document.createElement("details");
      d.style.cssText = "margin-top:16px;opacity:.75;font-size:13px";
      const s = document.createElement("summary");
      s.textContent = "Details";
      const pre = document.createElement("pre");
      pre.style.cssText = "white-space:pre-wrap;word-break:break-word";
      pre.textContent = message.slice(0, 2_000);
      d.append(s, pre);
      box.append(d);
    }
    panel.append(box);
    host.append(panel);
    reload.focus();
  } catch { /* nothing more can be done */ }
}

/**
 * Window-level capture: uncaught errors and unhandled rejections are reported. Safe to call
 * once at boot; returns an uninstaller. It never draws the stopped screen by itself (most
 * window errors leave the app working) — the React root's `onUncaughtError` does that.
 */
export function installWindowErrorCapture(): () => void {
  const onError = (e: ErrorEvent) => { reportClientError("error", e.error ?? e.message); };
  const onRejection = (e: PromiseRejectionEvent) => { reportClientError("rejection", e.reason); };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

/** For `createRoot(el, { onUncaughtError })`: React has unmounted the whole root — say so and offer Reload. */
export function onRootUncaughtError(error: unknown): void {
  const r = reportClientError("uncaught", error);
  showStoppedScreen(r?.message ?? describe(error).message);
}

/**
 * Main-thread stall watch: a heartbeat every `intervalMs`; when the GAP between two beats reaches
 * `thresholdMs`, the main thread was blocked for about that long (within one interval) — reported
 * once per stall as kind "stall". Measured beat to beat, not against a schedule: a schedule hides
 * the part of a block that fell inside an ordinary interval. Not while the page is hidden (timers
 * are throttled there, which is not a stall).
 */
export function startStallWatch(opts: { thresholdMs?: number; intervalMs?: number } = {}): () => void {
  const threshold = opts.thresholdMs ?? 2_000;
  const interval = opts.intervalMs ?? 250;
  let last = performance.now();
  let wasHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    const hidden = document.visibilityState === "hidden";
    if (!hidden && !wasHidden && gap >= threshold) {
      reportClientError("stall", new Error("The main thread was blocked"), `stalled ${Math.round(gap)} ms`);
    }
    wasHidden = hidden;
  }, interval);
  return () => clearInterval(timer);
}
