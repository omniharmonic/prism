---
name: Prism Setup — Vault
description: "Ensure a Parachute vault + hub are running and mint a long-lived write token for Prism. Verifies the token is a hub-issued JWT (Parachute 0.5.x), not a legacy pvt_* token. Emits PARACHUTE_URL / PARACHUTE_VAULT / PARACHUTE_TOKEN for the server and desktop setup skills."
version: 0.1.0
---

# Prism Setup — Vault + hub + token

Get a Parachute vault running and produce the write token everything else needs.
This is **step 1**; the token you mint here is consumed by `prism-setup-server`
and `prism-setup-desktop`. **Do not write the token to disk in this skill** —
hand it forward in-session (the server skill writes it into `apps/server/.env`).

## When to use

First step of `prism-setup`, or standalone when a user needs a fresh vault token.

## Steps

1. **Detect the hub + vault.** Parachute runs a hub on **:1939** (token issuer)
   and the vault API on **:1940**.
   ```bash
   curl -fsS http://localhost:1940/health && echo "  vault OK"
   ```
   If this fails: the vault isn't running. Instruct the user to install/start
   Parachute (you cannot install system software silently), then re-check. Ask
   for the vault name if it isn't `default`.
2. **Mint a long-lived write token** (1-year TTL):
   ```bash
   parachute auth mint-token --scope vault:default:write --expires-in 31536000
   ```
   Capture the JWT it prints as `PARACHUTE_TOKEN`. (Replace `default` with the
   chosen vault name.)
3. **Record** `PARACHUTE_URL=http://localhost:1940`, `PARACHUTE_VAULT=default`,
   `PARACHUTE_TOKEN=<jwt>` for the next skills.

## Verify (pass / fail)

- **PASS:** `curl -fsS http://localhost:1940/health` → 200; and an authed call
  succeeds (not 401):
  ```bash
  curl -fsS -H "Authorization: Bearer $PARACHUTE_TOKEN" \
    http://localhost:1940/vault/default/api/tags >/dev/null && echo "  token OK"
  ```
- **FAIL — 401 on the authed call:** wrong/expired token, or a legacy `pvt_*`
  opaque token (Parachute 0.5.x rejects those). Re-mint a hub JWT.
- **FAIL — connection refused:** the hub/vault isn't running.

## Notes

- The token is a **hub JWT** (`vault:<name>:write`, ≤1yr). The pre-0.5 `pvt_*`
  tokens are rejected. The issuer is the hub on :1939.
- This skill produces no file of its own — it emits the three values forward.
