/** Sign-in and accept-invite screens, as `main.tsx` mounts them. No server: the spec answers `/auth/*`. */
import React from "react";
import { createRoot } from "react-dom/client";
import "@prism/core/shell";
import { LoginScreen } from "../src/auth/LoginScreen";
import { RegisterScreen } from "../src/auth/RegisterScreen";

const params = new URLSearchParams(location.search);
const screen = params.get("screen") ?? "login";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {screen === "register" ? <RegisterScreen token="fixture-invite-token" /> : <LoginScreen notice={params.get("notice") ?? undefined} />}
  </React.StrictMode>,
);
