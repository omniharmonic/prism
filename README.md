# Prism

**Prism** is a desktop app that aims to be a single place for documents, messages, tasks, calendar, and more—backed by a Tauri + Rust core and a React UI. The product direction and specs live in `.claude/` (for example `prism-prd-v3.md` and `prism-implementation-plan.md`).

## Stack

- **Frontend:** React 19, Vite 7, TypeScript, Tailwind CSS 4
- **Desktop:** [Tauri 2](https://v2.tauri.app/) (Rust)
- **Package manager:** npm (see `package-lock.json`)

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- [Rust](https://www.rust-lang.org/tools/install) and a normal native toolchain for your OS (Tauri will prompt if anything is missing)
- For **optional** MCP integration with Parachute Vault: [Bun](https://bun.sh/) and a local checkout of the vault server (see below)

## Development

Install dependencies:

```bash
npm install
```

Run the app in dev mode (starts Vite on port 1420 and the Tauri shell):

```bash
npm run tauri dev
```

Frontend only (no desktop shell):

```bash
npm run dev
```

## Build

```bash
npm run tauri build
```

Artifacts follow Tauri’s usual output under `src-tauri/target/` and the bundled app per your OS.

## Repository layout

| Path | Role |
|------|------|
| `src/` | React app (UI, hooks, components, lib clients) |
| `src-tauri/` | Rust crate: commands, sync engine, integrations |
| `.claude/` | Internal planning and PRD-style docs (not required to run the app) |

## Optional: Parachute Vault MCP (Cursor)

This repo includes a root `.mcp.json` that wires a **`parachute-vault`** MCP server. The server entry uses a **path relative to this repository**, not an absolute path:

- Default: `../parachute-vault/src/server.ts` (expects the Parachute Vault repo cloned **next to** this repo, as a sibling folder named `parachute-vault`).

If your vault lives elsewhere, edit `.mcp.json` and point `args` at your `server.ts` (or a small wrapper script). The MCP server is started with `bun`; install Bun if you use this integration.

## License

No license file is included yet; add one when you decide how you want to distribute the project.
