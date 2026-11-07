<p align="center">
  <img src="https://img.shields.io/badge/status-public%20preview-orange" alt="Public preview" />
  <img src="https://img.shields.io/badge/host-Apple%20silicon%20Mac-black?logo=apple" alt="Apple-silicon Mac" />
  <img src="https://img.shields.io/badge/License-AGPL--3.0-blue" alt="License: AGPL-3.0" />
</p>

<h1 align="center">Prism</h1>

<p align="center"><strong>Your documents, messages, tasks, calendar and notes in one workspace — on your own Mac.</strong></p>

---

## What Prism is

Prism is a workspace you run yourself. Your data lives in a [Parachute](https://parachute.computer)
vault on your Mac; Prism is the server and apps on top of it.

- **Pages that work like Notion:** a block editor with live collaboration, comments and
  suggested edits, databases with table, board, calendar and gallery views, templates,
  version history, import and export.
- **Your inbound world in one place:** email, chat (Matrix bridges), calendar, meeting
  transcripts and tasks, pulled into the same vault and linked to the people involved.
- **Sharing on your terms:** invite people by link, share a page or a whole folder,
  publish a tag as a public wiki. Nobody else ever holds a key to your vault.
- **An agent that works inside it:** Claude, through Claude Code, can read and edit your
  workspace with the same permissions as the account it acts for.
- **On every screen:** the web app, the Prism Client for Mac, and the iPhone and iPad app.

## Status

Prism is a **public preview** (v0.9.2). It is for people who are comfortable installing
things but don't write code, and it is set up **by an agent**: you run
[Claude Code](https://claude.com/claude-code), and it walks you through every step while
Prism's in-app setup checklist ticks off what's done.

- **Host:** a Mac with Apple silicon, macOS 14 or newer. Intel, Linux and Windows come later.
- **Apps:** the web app, [Prism Client for Mac](https://github.com/omniharmonic/prism/releases/latest)
  (signed and notarized), and Prism for iPhone and iPad (TestFlight first, then the App Store).

## Get started

You need **Claude Code** and git. The host bundle brings its own Node.js.

1. **Download** the [Mac app](https://github.com/omniharmonic/prism/releases/latest) (`Prism-Client_*.dmg`)
   and the [host bundle](https://github.com/omniharmonic/prism/releases/tag/prism-host-v0.9.2)
   (`prism-host-*-darwin-arm64.tar.gz` and `SHA256SUMS`).
2. **Get the setup skills and unpack the bundle beside them:**

   ```bash
   git clone https://github.com/omniharmonic/prism.git
   cd prism
   tar xzf ~/Downloads/prism-host-0.9.2-darwin-arm64.tar.gz
   ```

   To check the download first: `cd ~/Downloads && shasum -a 256 -c SHA256SUMS --ignore-missing`.
3. **Let the agent set it up:** run `claude` in that folder and ask it to *"set up Prism"*.

The `prism-setup` skill runs `prism setup`, one resumable command: the vault, the server's
secrets, the vault's tag schemas, starting the server under launchd, your first sign-in, the
Mac and phone apps, and (optionally) reaching Prism from outside your Mac and connecting your
inboxes. Each step checks before it acts, so you can stop and resume at any time. Prism runs on
a [Parachute](https://parachute.computer) vault; the agent installs Parachute with your
permission when the setup asks for it. The details are in
[`docs/host-bundle.md`](docs/host-bundle.md) and [`docs/onboarding.md`](docs/onboarding.md).

Updates are signed: `prism update` verifies the release's minisign signature and checksum,
keeps a backup, and rolls back if the new version does not come up healthy.

## For developers

```bash
npm run check                       # type checks + static guards (what CI runs first)
cd apps/server && npm test          # the server suite
npm run dev -w @prism/web           # the web app with hot reload
```

| Path | What it is |
|---|---|
| `packages/core` | The shared React UI: editor, renderers, databases, stores |
| `apps/server` | Prism Server: auth, the permission gateway, collaboration, ingest, MCP |
| `apps/web` | The web app (PWA), and the page the native apps load |
| `apps/client` | Prism Client: the thin Tauri shell for macOS and iOS |
| `apps/desktop` | The legacy desktop app (kept as a rollback path only) |

How it all fits together, and the rules every change follows:
[`docs/engineering/reference.md`](docs/engineering/reference.md).

## Licence

Prism is free and open-source software under the [GNU Affero General Public License v3.0](./LICENSE.md)
(`AGPL-3.0-only`). Use it, study it, change it and share it. If you run a changed copy for other
people over a network, offer them its source too: set `PRISM_SOURCE_URL` and every server links to
it. See [NOTICE.md](./NOTICE.md) for the copyright notice, earlier versions, and how Prism works
with [Parachute](https://github.com/ParachuteComputer) (also AGPL-3.0, a separate program).

## Credits

Built by Benjamin Gleason Ross ([@omniharmonic](https://github.com/omniharmonic)), on
[Parachute](https://parachute.computer), [Tauri](https://tauri.app),
[TipTap](https://tiptap.dev), [Yjs](https://yjs.dev) and [Hocuspocus](https://tiptap.dev/hocuspocus),
with [Claude Code](https://claude.com/claude-code).
