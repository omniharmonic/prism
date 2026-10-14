---
name: Prism Setup — Reach and devices
description: "Give a Prism server an https address that a phone and other computers can open, with Tailscale (recommended: no domain needed) or a Cloudflare tunnel (your own domain), then sign a device in. Covers the checklist steps reachable and device."
version: 0.3.0
---

# Prism Setup — Reach and devices

After the core steps Prism works on the computer it runs on, at
`http://localhost:8787`. A phone needs an **https** address. There are two
supported ways; ask which the person wants if they have not said.

Never expose port 8787 to the internet directly, and never set
`TRUST_LOCAL=true` on a server whose port is reachable without a proxy in front
of it: with that setting, a request that carries no forwarding header is treated
as coming from the owner's own machine.

## Option A — Tailscale (recommended)

For one person's own devices. No domain, nothing public.

1. Tailscale is installed and signed in on the server's computer and on the
   phone, in the same tailnet. (Installing and signing in are the person's
   actions; check with `tailscale status`.)
2. HTTPS certificates are enabled for the tailnet (Tailscale admin console →
   DNS → HTTPS Certificates). Person's action.
3. Serve the port: `tailscale serve --bg 8787`. `tailscale serve status` shows
   the address, `https://<machine>.<tailnet>.ts.net`.
4. Set `APP_ORIGIN` to that address in `apps/server/.env` and restart the
   server. The app's sign-in links and device sign-in use this value.

People outside the tailnet cannot open it. To share with them, either invite
them to the tailnet or use Option B.

## Option B — Cloudflare tunnel

For a public address on a domain the person owns.

1. The domain is on Cloudflare (person's action: buying a domain and moving its
   DNS cannot be done for them).
2. `cloudflared tunnel login`, then `cloudflared tunnel create prism`.
3. Route a hostname to it: `cloudflared tunnel route dns prism
   prism.<their-domain>`.
4. A config that sends that hostname to `http://localhost:8787`, and
   `cloudflared tunnel run prism` kept running (a login item or service).
5. Set `APP_ORIGIN=https://prism.<their-domain>` in `apps/server/.env` and
   restart the server.

## Check (`reachable`)

- `curl -s https://<address>/health?live=1` answers `{"ok":true,"live":true}`
  from **another device** (the phone's browser is enough).
- `APP_ORIGIN` in `.env` is that address, and the checklist step has ticked.

## Sign in a device (`device`)

1. Install Prism on the phone (App Store) or the other computer.
2. Enter the server's https address when the app asks for it.
3. Sign in: the app opens the browser, the person signs in and approves the
   device.

The device then appears under **Settings → Account → Signed-in devices**, where
it can be removed. Approving the device is the person's action.

## Limits

- Notifications on an iPhone need the app publisher's push service; a
  self-hosted server may not deliver them yet.
- Changing `APP_ORIGIN` signs nobody out, but links already sent point at the
  old address.
