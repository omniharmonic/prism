/**
 * L-1 capture fixture: a React root created the way main.tsx creates it (`onUncaughtError:
 * onRootUncaughtError`), the window capture and the stall watch as bootstrap.ts installs them,
 * and a fake reporter that records what the owner's client would POST.
 *
 * `window.prismClientErrors`: `posted` (reports handed to the reporter), `crashOutside()` (an
 * error in a commit-phase effect with NO boundary above it — React unmounts the whole root, the
 * grey-window case), `crashInBoundary()` (the app's real error boundary catches it), `reject()`,
 * `block(ms)` (busy-waits the main thread), `report(kind, message)`.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../../../packages/core/src/App";
import "../../../packages/core/src/styles/tokens.css";
import { installWindowErrorCapture, onRootUncaughtError, reportClientError, setClientErrorContext, setClientErrorReporter, startStallWatch, type ClientErrorReport } from "@prism/core/client-errors";

const posted: ClientErrorReport[] = [];
setClientErrorContext({ build: "test-build", platform: "web" });
installWindowErrorCapture();
startStallWatch();
setClientErrorReporter(async (r) => { posted.push(r); });

let setMode: (m: "ok" | "outside") => void = () => {};
function Bomb(): null {
  useEffect(() => { throw new Error("effect blew up outside any boundary"); }, []);
  return null;
}
function Root() {
  const [mode, set] = useState<"ok" | "outside">("ok");
  setMode = set;
  return <div data-testid="app">{mode === "outside" ? <Bomb /> : "Working app"}</div>;
}
const params = new URLSearchParams(location.search);
const root = createRoot(document.getElementById("root")!, { onUncaughtError: onRootUncaughtError });
if (params.has("boundary")) {
  // The real App's boundary, around a child that throws while rendering.
  const Throws = () => { throw new Error("render blew up inside the app boundary"); };
  root.render(<ErrorBoundary><Throws /></ErrorBoundary>);
} else root.render(<Root />);

Object.assign(window, {
  prismClientErrors: {
    posted,
    crashOutside: () => setMode("outside"),
    reject: () => { void Promise.reject(new Error("nobody handled this")); },
    block: (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* busy */ } },
    report: (kind: ClientErrorReport["kind"], message: string) => reportClientError(kind, new Error(message)),
  },
});
