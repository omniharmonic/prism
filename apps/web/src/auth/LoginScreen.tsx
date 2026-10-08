import { PrismMark } from "@prism/core/shell";
import { useEffect, useRef, useState } from "react";
import { login, requestMagicLink, postLoginTarget, hasSession } from "../config";
import { takeSignOutNotice } from "../config";

/**
 * Sign-in screen. Prism is invite-only: people log in with the email + password
 * they set when accepting an invite. The owner can also request a one-time email
 * link (bootstrap / recovery). No self-signup — entering an unknown email does
 * nothing.
 */
/** Read once per page load: the previous sign-out never reached the server (review low 9). */
const signedOutUnreached = takeSignOutNotice();

export function LoginScreen({ notice }: { notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "linksent" | "error">("idle");
  const [error, setError] = useState("");
  const [linkMode, setLinkMode] = useState(false);
  // false when the server has no Resend key — the link was printed to its console.
  const [emailDelivery, setEmailDelivery] = useState(true);

  // Mid native sign-in (`?next=/auth/device/continue`) the emailed link opens in ANOTHER
  // window: the app's sign-in sheet shows this page, the mail app hands the link to the
  // browser. Both share one cookie jar, so once the link has signed the browser in, this
  // page can go on by itself (qa/ios-simulator-findings-2026-10-08.md, findings 2 and 3).
  //
  // All it does is ask "is there a session?" (GET /auth/me) and then go where a password
  // login goes: `postLoginTarget()`, which is only ever the fixed path /auth/device/continue.
  // The server still decides everything there — it needs the session AND this browser's
  // parked request, and it answers with the CONSENT page. Nothing is approved from here.
  const resumeTarget = status === "linksent" ? postLoginTarget() : null;
  const resuming = useRef(false);
  const [notYet, setNotYet] = useState(false);
  async function resumeIfSignedIn(): Promise<boolean> {
    if (!resumeTarget || resuming.current) return false;
    resuming.current = true;
    const signedIn = await hasSession();
    if (signedIn) {
      window.location.replace(resumeTarget); // stays "resuming": one navigation, no more asks
      return true;
    }
    resuming.current = false;
    return false;
  }
  useEffect(() => {
    if (!resumeTarget) return;
    const check = () => { if (document.visibilityState !== "hidden") void resumeIfSignedIn(); };
    // Coming back from the mail app / browser is the moment that matters; the timer covers a
    // sheet that stayed in front. It stops with the parked request (15 min, like the link).
    const timer = setInterval(check, 3000);
    const stop = setTimeout(() => clearInterval(timer), 15 * 60_000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeTarget]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("working");
    setError("");
    try {
      if (linkMode) {
        const { emailDelivery } = await requestMagicLink(email.trim().toLowerCase());
        setEmailDelivery(emailDelivery);
        setStatus("linksent");
      } else {
        await login(email.trim().toLowerCase(), password);
        // Re-enter the app with a session — or, mid native sign-in, resume the
        // device consent page (postLoginTarget only ever returns that fixed path).
        window.location.assign(postLoginTarget() ?? "/");
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    }
  }

  const field: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--glass-border, rgba(255,255,255,0.12))",
    background: "var(--glass, rgba(255,255,255,0.04))",
    color: "var(--text-primary, rgba(255,255,255,0.92))",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div role="main" style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <form
        onSubmit={submit}
        className="workspace-auth-card"
        style={{ width: "100%", maxWidth: 400, padding: 28, borderRadius: 16, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <PrismMark width={72} height={48} decorative />
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Sign in to Prism</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted, #888)" }}>
            {linkMode ? "We'll email you a one-time sign-in link." : "Prism is invite-only — log in with your account."}
          </p>
        </div>

        {notice && <div style={{ fontSize: 13, color: "var(--text-muted, #888)" }}>{notice}</div>}
        {signedOutUnreached && <div role="status" data-testid="signout-unreached" style={{ fontSize: 13, color: "var(--text-muted, #888)" }}>Signed out on this device. The server could not be reached, so this session may still be listed there until it expires — sign in and check Settings → Account when you are back online.</div>}

        {status === "linksent" ? (
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            {emailDelivery ? (
              <>If <strong>{email}</strong> is allowed, a sign-in link is on its way. {resumeTarget ? "Open it, then come back here — this page continues on its own." : "You can close this tab."}</>
            ) : (
              <>
                Email isn't configured on this server, so no message was sent. If{" "}
                <strong>{email}</strong> is the owner, the one-time sign-in link was printed to the{" "}
                <strong>server console</strong> (the terminal running the Prism Server) — open it from there.
              </>
            )}
            {resumeTarget && (
              <>
                {/* For a sheet whose timers were paused in the background: the same check, by hand. */}
                <button
                  type="button"
                  onClick={async () => { setNotYet(false); if (!(await resumeIfSignedIn())) setNotYet(true); }}
                  style={{ display: "block", width: "100%", marginTop: 14, padding: "11px 16px", minHeight: 44, borderRadius: 8, border: "none", background: "var(--action-bg)", color: "var(--action-fg)", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                >
                  I’ve opened the link — continue
                </button>
                {notYet && <div role="status" style={{ marginTop: 10, fontSize: 13, color: "var(--text-muted, #888)" }}>Not signed in yet. Open the link from the email first, then try again.</div>}
              </>
            )}
          </div>
        ) : (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
              Email
              <input style={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required />
            </label>

            {!linkMode && (
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                Password
                <input style={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" required />
              </label>
            )}

            {status === "error" && <div style={{ fontSize: 13, color: "var(--color-danger, #EB5757)" }}>{error}</div>}

            <button
              type="submit"
              disabled={status === "working" || !email.trim() || (!linkMode && !password)}
              style={{
                marginTop: 4,
                padding: "11px 16px",
                borderRadius: 8,
                border: "none",
                background: "var(--action-bg)",
                color: "var(--action-fg)",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                opacity: status === "working" || !email.trim() || (!linkMode && !password) ? 0.6 : 1,
              }}
            >
              {status === "working" ? "…" : linkMode ? "Email me a link" : "Log in"}
            </button>

            <button
              type="button"
              onClick={() => {
                setLinkMode((m) => !m);
                setStatus("idle");
                setError("");
              }}
              style={{ background: "none", border: "none", color: "var(--text-muted, #888)", fontSize: 12, cursor: "pointer", textAlign: "center", minHeight: 44 }}
            >
              {linkMode ? "← Back to password login" : "Owner? Email me a sign-in link instead"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
