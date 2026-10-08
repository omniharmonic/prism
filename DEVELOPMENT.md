# Developing Prism (draft)

This is the plain-language guide for working on Prism without touching the
live system. Draft — some steps depend on the laptop inventory (see
`dev-environment-plan.md`).

## The one rule

- **The laptop is for building and trying things.**
- **The Mac Mini only runs what has been released.** Nobody edits files on the
  Mini, and no coding agents run there.
- The two machines only meet through **GitHub**, on the **`omniharmonic`**
  account: `github.com/omniharmonic/prism` (decided 2026-10-08). Push as
  `omniharmonic`; the deploy script refuses any other `origin`. You save work on the laptop,
  push it to GitHub, give it a version name (a "tag"), and the Mini pulls that
  exact version.

---

## 1. Start dev mode (laptop)

You need two things running: a **dev vault** (a private copy of your notes) and
the **dev Prism server**.

1. Start the dev vault (Parachute on the laptop). *[Exact command confirmed in
   the inventory — likely `parachute vault start`.]*
2. Open Terminal and run:

   ```bash
   git clone https://github.com/omniharmonic/prism ~/dev/prism   # first time
   cd ~/dev/prism
   npm ci                                  # first time, or after pulling changes
   npm run build -w @prism/web             # builds the web app
   cd apps/server
   node --env-file=.env.dev --watch --import tsx src/index.ts
   ```

3. Open **http://localhost:8787** in your browser.
4. Sign-in links do not get emailed in dev — they appear in the Terminal
   window. Copy the link from there.

To stop: press `Ctrl+C` in the Terminal window.

### Why it is safe

The dev settings file (`apps/server/.env.dev`) has every outward-facing feature
turned **off**: no email/Matrix/calendar actions (`ACTIONS_*_ENABLED=false`), no
syncing from Gmail, Proton, calendar, Notion or GitHub (`*_SYNC_ENABLED=false`),
no background skills or local model (`SKILLS_ENABLED=false`), no alert emails
(`WORKER_ALERTS_ENABLED=false`), no email service key (`RESEND_API_KEY` empty),
no push-notification keys, and no stored credentials (`SECRETS_KEY` empty). It
talks only to the dev vault on the laptop, with a dev token. It **cannot**
reach the real vault, send mail, or message anyone.

If you ever see an Ingest health card on the laptop saying a source is
running — stop and check `.env.dev`.

### Secrets

No 1Password: secrets live in the Mac's Keychain as `omni.prism.<NAME>`
(e.g. `omni.prism.SESSION_SECRET`), managed with the agent repo's
`scripts/secrets.sh` (`set` asks for the value hidden — never type a secret on
a command line; `list` shows names only). On the laptop they hold **dev**
values; the production ones exist only on the Mini. To build `.env.dev` from
them, write `apps/server/.env.dev.tmpl` with `SESSION_SECRET=@keychain` lines
and run
`~/dev/omniharmonicagent/scripts/secrets.sh --repo prism env-file apps/server/.env.dev.tmpl`.

### Running the tests (no vault needed at all)

```bash
cd ~/dev/prism
npm test                    # server tests — fake vault, in-memory database
npx tsc --noEmit            # type check
```

Never run `node --test` directly — always `npm test` (it uses the safe test
settings).

---

## 2. Refresh the dev data

Your dev vault is a **scrubbed copy** of the real one (decided 2026-10-08).
Refresh it every week or so, or when you need recent notes. Everything is run
from the laptop; the full commands are in
`omniharmonicagent/docs/dev-environment/dev-environment-plan.md` §2.

1. **Snapshot on the Mini** (read-only, safe while everything runs):
   `ssh mini 'bash ~/dev/prism/scripts/backup-parachute.sh dev-refresh'`
2. **Scrub on the Mini, before anything moves.** Copy just the vault file,
   delete any note that looks like it holds a password, key or token, and
   compact it into a fresh `vault-dev.db` (so deleted text is really gone).
   The hub database (token keys), `prism-server.db` (your stored connection
   passwords) and the `.env` are **never** copied.
3. **Copy over Tailscale:** `scp mini:<snapshot>/vault-dev.db ~/dev-data/vault.db.new`
   (`~/dev-data` is a private folder, outside iCloud).
4. **Delete the snapshot folder on the Mini** — it contains everything.
5. **Swap it in:** stop the dev vault, move the new file into place, start it,
   run the vault's `doctor` check.

The copy can't import anything new: the laptop has no ingest passwords at all
(`SECRETS_KEY` is empty in `.env.dev`, and no Gmail/Proton/Matrix/calendar
login exists there). It does contain your mail and messages: keep it on the
laptop only, never in iCloud or a shared folder.

---

## 3. Release to production (deploy)

1. Make sure your work is saved and pushed:
   ```bash
   cd ~/dev/prism
   git status                 # should say "nothing to commit"
   git push
   ```
2. Give this version a name and publish the name:
   ```bash
   git tag prism-v2026.10.08          # today's date; add -2, -3 for a second release the same day
   git push origin prism-v2026.10.08
   ```
3. Try the deploy first (nothing changes):
   ```bash
   MINI_HOST=benjaminlife@mini ~/dev/omniharmonicagent/scripts/deploy.sh prism prism-v2026.10.08
   ```
   Read what it says it *would* do.
4. Do it for real:
   ```bash
   MINI_HOST=benjaminlife@mini ~/dev/omniharmonicagent/scripts/deploy.sh prism prism-v2026.10.08 --apply
   ```

What happens: the Mini takes a full backup, switches to the new version,
rebuilds the web app, rebuilds `apps/server/.env` from the Keychain if an
`apps/server/.env.tmpl` is there, restarts Prism, and checks that Prism is up, can reach the
vault, and that no mail/message/calendar import broke. If anything fails it
**switches back to the previous version by itself** and tells you.

Results:
- "DEPLOYED" — done. Check Prism again in about 30 minutes (some import
  problems only show after a few cycles).
- "ROLLED BACK" — the new version had a problem; production is on the old one.
  Nothing is lost. Fix it on the laptop and try again.
- "ROLLBACK ALSO FAILED" — rare. Look at the Mini straight away; the backup
  folder name is printed.

### Order of releases

1. Server first (this deploy — it also serves the web app/phone PWA).
2. Then, if needed, rebuild the **Prism Client** app on the laptop.

After an editor change, never edit pages with the old Prism.app desktop.

### Things the automatic rollback cannot undo

Database changes. If a release changed how Prism stores live documents, read
the "collab_docs rollback" note in `CLAUDE.md` before going back and forward
again. The deploy script warns you when a release touches those files. That is
what the backup is for.
