/** Sign-in, accept-invite, set-password and reconnect screens, as `main.tsx` mounts them. No server: the spec answers `/auth/*`. */
import React from "react";
import { createRoot } from "react-dom/client";
import "@prism/core/shell";
import { LoginScreen } from "../src/auth/LoginScreen";
import { RegisterScreen } from "../src/auth/RegisterScreen";
import { SetPasswordScreen } from "../src/auth/SetPasswordScreen";
import { ReconnectScreen } from "../src/auth/ReconnectScreen";

const params = new URLSearchParams(location.search);
const screen = params.get("screen") ?? "login";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {screen === "register" ? <RegisterScreen token="fixture-invite-token" />
      : screen === "set-password" ? <SetPasswordScreen />
      : screen === "reconnect" ? <ReconnectScreen />
      : <LoginScreen notice={params.get("notice") ?? undefined} />}
  </React.StrictMode>,
);
