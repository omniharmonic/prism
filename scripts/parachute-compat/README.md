# Parachute compatibility suite

Checks a Parachute install (hub + vault CLIs) against what Prism relies on
(`docs/roadmap/parachute-embedded-mode-request.md` §2 and §5, launch plan §3).
Run it against every Parachute pre-release before Prism adopts it.

```bash
node scripts/parachute-compat/run.mjs --home /tmp/pc/home \
  [--bin /path/to/parachute] [--vault-bin /path/to/parachute-vault] [--dry-run]
node --test scripts/parachute-compat/selftest.test.mjs   # the suite's own tests
```

**Isolation rules (enforced before anything runs):**

- `--home` is a throwaway `PARACHUTE_HOME`. It must be absolute and must not exist or be empty (`--reuse` allows a previous run's). The live `~/.parachute`, anything inside it, and your home directory are refused.
- Ports 1939, 1940 and 8787 are refused, and so is a port in use. Without `--hub-port` / `--vault-port` the suite picks free ports.
- The children get an environment allowlist, `PARACHUTE_HOME`, the test hub as `PARACHUTE_HUB_ORIGIN` / `PARACHUTE_HUB_JWKS_ORIGIN` / `PARACHUTE_HUB_PORT`, and `PARACHUTE_BIND_HOST=127.0.0.1`. By default their `HOME` is a throwaway too (`<out>/fakehome`), so nothing a CLI resolves from the home directory (launchd plists, `~/.claude.json`) reaches yours; `--real-home` turns that off.
- At the end it checks that `launchctl list` shows no new Parachute job and that the live `~/.parachute` has no new entries.

**What it checks:** versions; advertised embedded-mode features (help / `version --json`); hub start, `/health`, `/api/ready`; bootstrap (`bootstrap --embedded` twice when offered, otherwise the admin seeded from env + `auth rotate-operator`); `parachute-vault create --mint --json`; vault start; `auth mint-token` read / write / admin (`iss`, `aud`, `sub`, scope, lifetime); JWKS; REST note CRUD, `if_updated_at` and `if_exists` 409s, lean lists, history; tag-schema `PUT` (403 with a write token, 200 with admin); MCP `tools/list` per scope against Prism's allowlists; `revoke-token`, the revocation list, and how long the vault keeps accepting a revoked token; loopback listeners, file modes, secrets in logs and `ps`, outbound connections (sampled with `lsof`), SIGTERM exit. Each of E1–E9 is reported, SKIP when the binary does not offer it.

**Output:** `<out>/report.json` and `<out>/report.md` (default `<home>-report/`), plus `hub.log` / `vault.log`. Tokens and the generated admin password are scrubbed from the report. Exit code 0 = no FAIL, 1 = a FAIL, 2 = refused.

**Stock-CLI shim:** stock 0.7.x `auth mint-token` and `rotate-operator` take the token issuer from `hub/run/hub.port`, not `PARACHUTE_HUB_ORIGIN`, and `parachute serve` does not write that file. The suite records this as a FAIL, then writes the file itself so the remaining checks can run.

Not covered yet (request §5): artifact signing / read-only mount (only a checksum with `--artifact`), exit-code fixtures, upgrade + rollback, load, and Prism's end-to-end suites against the install.
