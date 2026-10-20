<p align="center">
  <img src="https://img.shields.io/badge/status-pre--release-orange" alt="Pre-release" />
  <img src="https://img.shields.io/badge/host-Apple%20silicon%20Mac-black?logo=apple" alt="Apple-silicon Mac" />
  <img src="https://img.shields.io/badge/License-PolyForm%20Shield%201.0.0-blue" alt="PolyForm Shield License 1.0.0" />
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

Prism is **pre-release**. The first public release (v1) is for people who are comfortable
installing things but don't write code, and it is set up **by an agent**: you run
[Claude Code](https://claude.com/claude-code), and it walks you through every step while
Prism's in-app setup checklist ticks off what's done.

- **Host:** a Mac with Apple silicon, macOS 14 or newer. Intel, Linux and Windows come later.
- **Apps:** the web app, the Prism Client for Mac, and Prism for iPhone and iPad
  (TestFlight first, then the App Store).

A one-step installer is in progress. Until it ships, setup runs from this repository.

## Set it up (today, from source)

You need **Node.js 22.18+**, **Claude Code**, and git.

```bash
git clone https://github.com/omniharmonic/prism.git
cd prism
npm install
claude            # then ask: "set up Prism"
```

The `prism-setup` skill takes it from there: the vault, the server's secrets, the vault's
tag schemas, starting the server, your first sign-in, the Mac and phone apps, and
(optionally) reaching Prism from outside your Mac and connecting your inboxes. Each step
checks before it acts, so you can stop and resume at any time. Today you install
[Parachute](https://parachute.computer) yourself when the skill asks; in v1 the agent
installs it for you. The manual equivalent is in [`docs/onboarding.md`](docs/onboarding.md).

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

Prism is licensed under the [PolyForm Shield License 1.0.0](./LICENSE.md): use it for
anything, including your work, and change it; don't sell it, host it as a service, or build
a competing product from it. See [NOTICE.md](./NOTICE.md) for the required notice, earlier
versions, and how Prism works with [Parachute](https://github.com/ParachuteComputer)
(AGPL-3.0, a separate program).

## Credits

Built by Benjamin Gleason Ross ([@omniharmonic](https://github.com/omniharmonic)), on
[Parachute](https://parachute.computer), [Tauri](https://tauri.app),
[TipTap](https://tiptap.dev), [Yjs](https://yjs.dev) and [Hocuspocus](https://tiptap.dev/hocuspocus),
with [Claude Code](https://claude.com/claude-code).
