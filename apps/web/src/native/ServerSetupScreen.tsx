// iOS first run (WP5): "Enter your server". The app ships with no server
// built in; the owner types the address of their Prism Server once. The shell
// checks it answers like a Prism Server, saves it, and from then on the page
// CSP and the bearer token are bound to exactly that origin. Changing it later
// is Settings → Account → "Sign out & change server".
//
// 🔒 Nothing here talks to the typed address. While no server is set the page's
// CSP reaches no remote origin at all (origin.rs `build_csp_for(None)`), so the
// only request to an unconfirmed address is the SHELL's probe (`GET
// /health?live=1`, no credential, no redirect — auth.rs `probe_server`), and no
// token exists yet. The checks below only give a quick, readable answer for the
// obvious mistakes; the shell validates everything again and is the boundary.
import { PrismMark } from "@prism/core/shell";
import { useState, type FormEvent } from "react";
import { iosShell, shellError } from "./ios";

/** What a person types → what the shell is asked to save (it validates again). */
export function normalizeServerInput(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  // "prism.example.com" → https://prism.example.com ; keep an explicit scheme.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why this address cannot be a Prism Server, or null when it may be one. The
 * same rules as the shell's `ServerOrigin::parse` (which decides): an https
 * origin — or http on this device only, for a local test server — with a host
 * name and nothing else (no sign-in details, path, query or fragment).
 */
export function serverInputProblem(raw: string): string | null {
  const text = normalizeServerInput(raw);
  if (!text) return "Enter the address of your Prism Server.";
  // A space, a control character or a backslash never belongs in an address.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0x5c) return "That isn’t a web address. It looks like https://prism.example.com.";
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "That isn’t a web address. It looks like https://prism.example.com.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The address must start with https://.";
  if (!url.hostname) return "That isn’t a web address. It looks like https://prism.example.com.";
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    return "Use the https:// address of your server. Plain http:// is only for a test server on this device.";
  }
  if (url.username || url.password) return "Enter only the server’s address — you sign in on the next screen.";
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return `Enter only the server’s address, like ${url.protocol}//${url.host}.`;
  }
  return null;
}

export function ServerSetupScreen() {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shell = iosShell();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!shell || busy) return;
    const problem = serverInputProblem(value);
    if (problem) {
      setError(problem); // nothing was asked of the shell, nothing was contacted
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The shell probes it, saves it and reloads the page itself, under this server's CSP + origin.
      await shell.setServerOrigin(normalizeServerInput(value));
    } catch (err) {
      setError(shellError(err));
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: "max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom))" }}>
      <form
        onSubmit={(e) => void submit(e)}
        noValidate
        className="workspace-auth-card"
        style={{ width: "100%", maxWidth: 400, padding: 28, borderRadius: 16, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <PrismMark width={72} height={48} decorative />
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Enter your server</h1>
          <p style={{ margin: "6px 0 0", fontSize: 14, opacity: 0.7, lineHeight: 1.5 }}>
            Prism connects to your own Prism Server. Type its address, then sign in.
          </p>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 600 }}>
          Server address
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="url"
            placeholder="https://prism.example.com"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            disabled={busy || !shell}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "server-setup-error" : undefined}
            // 16px: iOS zooms into smaller inputs on focus.
            style={{ fontSize: 16, padding: "11px 12px", borderRadius: 10, border: "1px solid var(--glass-border, #333)", background: "var(--surface-sunken, #0d0d10)", color: "inherit", fontWeight: 400 }}
          />
        </label>
        {error && (
          <p id="server-setup-error" role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger, #ff8080)" }}>
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !shell}
          style={{ padding: "12px 12px", borderRadius: 10, border: "none", fontSize: 16, fontWeight: 600, background: "var(--action-bg)", color: "var(--action-fg)", opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Checking…" : "Continue"}
        </button>
        <p style={{ margin: 0, fontSize: 12, opacity: 0.6, lineHeight: 1.5 }}>
          Use the https:// address you open Prism with in a browser. The app talks only to this server.
        </p>
      </form>
    </div>
  );
}
