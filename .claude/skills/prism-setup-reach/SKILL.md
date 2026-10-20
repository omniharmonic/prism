---
name: Prism Setup — Reach and devices
description: "Give a Prism server an https address that a phone and other computers can open, with Tailscale (recommended: `prism reach tailscale`, no domain needed) or a Cloudflare tunnel (your own domain), then sign a device in. Covers the `prism setup` steps mac-client, device and reachable (the last two are also checklist steps)."
version: 0.5.0
---

# Prism Setup — Reach and devices

After the core steps Prism works on the computer it runs on, at
`http://localhost:8787`. A phone needs an **https** address. Tailscale is the
default; ask before using anything public.

Never expose port 8787 to the internet directly, and never set
`TRUST_LOCAL=true` on a server whose port is reachable without a proxy in front
of it. `prism reach` serves only Prism's port — never the hub (1939) or the vault (1940).

## Option A — Tailscale (recommended): `prism reach`

For one person's own devices. No domain, nothing public.

1. `prism reach status --json`. It reports whether Tailscale is installed,
   signed in, has MagicDNS + HTTPS certificates on, and the machine's name. When
   something is missing, `next` is one sentence to **tell the person** (install
   the Tailscale app on the Mac and the phone with the same account, sign in, turn
   on HTTPS certificates in the admin console). Never install or sign in for them.
2. `prism reach tailscale --dry-run` shows the exact commands; then
   `prism reach tailscale --json`. It runs
   `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, sets `APP_ORIGIN`
   to `https://<machine>.<tailnet>.ts.net` in the install's `.env` (nothing else
   changes), restarts the server and checks the address through Tailscale from
   this Mac. Safe to run again. Exit 9 = it needs `--yes` (APP_ORIGIN is another
   public address); exit 4 = a next step, or something else is already served on
   that name (ask the person; it never overwrites it).
3. The checklist step `reachable` ticks only when a request reaches that address
   **from another device**. Ask the person to open the address on their phone
   (Tailscale on, same account) and sign in with the owner's password. Then
   `prism reach status` shows `fromAnotherDevice`.

People outside the tailnet cannot open it. To share with them: invite them to the
tailnet, or Funnel (below), or Option B.

### Funnel (public, opt-in)

`prism reach funnel --yes` serves the same address on the **public internet**
(anyone with the link reaches the sign-in page; accounts stay invite-only). Only
with the person's explicit yes, after telling them that. The tailnet policy must
allow Funnel for the machine (`next` says so). The step ticks when a request
comes in from the internet (a phone on cellular data without Tailscale).
`prism reach tailscale` turns it back to private.

### Undo

`prism reach off` removes Prism's serve/Funnel entry and sets `APP_ORIGIN` back
to `http://localhost:<port>`.

## Option B — Cloudflare tunnel

For a public address on a domain the person owns.

1. The domain is on Cloudflare (person's action).
2. `cloudflared tunnel login`, then `cloudflared tunnel create prism`.
3. `cloudflared tunnel route dns prism prism.<their-domain>`.
4. A config that sends that hostname to `http://localhost:8787`, and
   `cloudflared tunnel run prism` kept running.
5. Set `APP_ORIGIN=https://prism.<their-domain>` in the server's `.env` and
   restart the server. The step ticks on the first request through the tunnel.

## The Mac client (`mac-client`)

`prism setup` checks for `Prism Client.app` in `/Applications` (or `~/Applications`). When it is
missing, the step's `next` carries the download link and this server's address. Downloading the
app, moving it to Applications and entering the address are the person's actions. On the server's
own Mac, `http://localhost:<port>` works; other computers need the https address below.

## Sign in a device (`device`)

**A phone (preferred): pair it with a QR code.** Needs the `reachable` step first.

1. Install Prism on the phone and open nothing in it.
2. The person presses **Pair a phone** on the checklist's devices step, scans
   the QR with the phone's Camera, taps **Pair** in the phone's prompt, and types
   the phone's 4-digit code on the computer. Never ask for that code, and never
   scan, approve or read out the QR for them: it is a one-time sign-in.

**Otherwise (another computer, or someone who isn't the server owner):**

1. Install Prism on the phone (App Store) or the other computer.
2. Enter the server's https address when the app asks for it.
3. Sign in: the app opens the browser, the person signs in and approves the
   device.

The device then appears under **Settings → Account → Signed-in devices**.
Approving the device is the person's action. Point the person at the checklist's `device` step
(Workspace settings → Server on the Mac): it shows how to pair the phone (a QR code once the
server has QR pairing). `prism setup` reports the step done as soon as any app is signed in.

## Limits

- `prism signin` keeps working on the Mac itself (it signs in at
  `http://localhost:<port>`); for daily use sign in at the https address.
- Notifications on an iPhone need the app publisher's push service; a
  self-hosted server may not deliver them yet.
- Changing `APP_ORIGIN` signs nobody out, but links already sent point at the
  old address.
