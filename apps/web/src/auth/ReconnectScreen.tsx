import { useEffect } from "react";
import { PrismMark } from "@prism/core/shell";

/** Do not turn a failed auth check into a false sign-out or open cached private data. */
export function ReconnectScreen() {
  useEffect(() => {
    const retry = () => window.location.reload();
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  return <main className="flex min-h-dvh items-center justify-center p-6">
    <div className="workspace-auth-card w-full max-w-md rounded-2xl p-7">
      <PrismMark width={72} height={48} decorative />
      <h1 className="mt-4 text-xl font-semibold">Reconnect to your workspace</h1>
      <p role="status" className="mt-3 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>Prism couldn't reach your server to check access. Your saved changes remain on this device. Reconnect to open your workspace.</p>
      <button className="focus-ring mt-5 rounded-lg px-4 py-3 text-sm font-medium" style={{ background: "var(--action-bg)", color: "var(--action-fg)" }} onClick={() => window.location.reload()}>Try again</button>
    </div>
  </main>;
}
