# Prism

*The universal interface for your entire digital life.*

---

You should never have to think about **where** your data lives.

A **message** is a message—whether it crossed WhatsApp, Telegram, email, or a dozen other paths. You read it in one thread of attention. You reply in one voice. The platform becomes a footnote: a small badge, not a destination you have to remember to open.

A **document** is a document—whether it began in a local vault, a Google Doc, or a Notion page. You edit in **one** editor. When you save, truth flows outward to the mirrors that need it. You do not live inside someone else’s chrome tab. **You open Prism.**

A presentation is a presentation. A task board is a task board. A calendar is a calendar. Code is code. **The interface bends to the shape of what you are doing**—not the other way around. Data moves through pipes you do not have to see. And when intelligence helps—drafting, transforming, searching—it stands **beside** your work: close enough to be useful, quiet enough to stay yours.

> **Prism is one window. Everything flows through it.**

---

## The universal data layer: Parachute

Underneath the glass, **Parachute** is the **universal data layer**: a vault where notes, links, tags, and meaning share one home. It is the **canonical source**—the place identity, structure, and search converge. Gmail, Calendar, Matrix, Notion, Google Docs—these are **mirrors**, not masters. They receive and return; they do not own the story.

Prism is the **face** of that idea: a desktop shell built to honor a single promise—**one coherent world of your information**, with editors and panels that understand *types* of work, sync that respects conflict and choice, and an agent that can act on the **same** vault the UI touches, because there was never supposed to be two truths.

This repository is **that vision, in motion**: early, honest, and under construction. The architecture is real; the poetry is the point.

---

## For builders

Prism is a **Tauri 2** app with a **React** front end: navigation, canvas, context panel, command surface, and **renderers** chosen from note metadata—wired to **Parachute’s HTTP API** (default `http://localhost:1940`), plus Rust-side clients for Matrix, Google, sync adapters, and an agent path that can use **Claude** with **Parachute MCP** tools.

```bash
npm install
npm run tauri dev
```

The full product intent—renderers, sync matrix, agent patterns, design language—lives in [`.claude/prism-prd-v3.md`](.claude/prism-prd-v3.md) and the [implementation plan](.claude/prism-implementation-plan.md). Optional Cursor MCP for the vault is configured in [`.mcp.json`](.mcp.json) (paths are relative to this repo; adjust for your layout).

---

## License

No `LICENSE` file is included yet—add one when you are ready to share the terms under which this vision travels.
