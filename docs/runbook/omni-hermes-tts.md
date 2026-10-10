# Hermes speech through authenticated Omni

The backend exposes a typed `VoiceProvider` descriptor/registry with identity, name, cloud disclosure, fixed voices/default, per-provider limits, availability and synthesis. Adding a vetted local adapter requires a code registration in `shippedProviders`, without route validation or metadata edits. No request/configuration can load modules or arbitrary commands. Adapters currently deliver MP3 through the fixed native transport; a new audio format requires a separately reviewed transport change. Initially only `hermes-edge` / `en-US-AriaNeural` is allowed. The native client selects the provider explicitly and explains that response text goes to Microsoft. Apple speech remains the unavailable-provider fallback. Local models and their retained assets are unchanged; a future local adapter can implement this interface without replacing the native conversation lifecycle.

Read-only Mini inventory on 2026-10-10 verified Hermes revision `791e2ae3257e211d14ca77e654dfe10ee1976a1c`, configured Edge/Aria, and `edge-tts` 7.2.7. The installed native `_generate_edge_tts` accepts text/output/config and produces MP3. Hermes' HTTP API has no TTS endpoint, so a fixed Prism worker imports that generator with a controlled Edge configuration. It does not call agent tools, arbitrary command providers, load TTS secrets/config, mutate Hermes configuration, or fall back to another cloud provider. This integration depends on that generator signature; its importability and installed Edge dependency are checked before availability is advertised.

[Hermes TTS documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/tts/) describes the provider interface; [Edge's upstream README](https://github.com/rany2/edge-tts) confirms synthesis uses Microsoft's online service. No API key is needed, but availability is not an SLA and cloud processing is not local inference.

## API contract

All endpoints inherit `/api/omni` enabled, server-owner session/device authentication and mutation CSRF gates. Capabilities, anonymous users, other accounts, loopback owner tokens and agent credentials cannot synthesize.

- `GET /api/omni/voice/providers`: provider ID/name, checked `available`, cloud disclosure, fixed voice list/default, 4,000-character and 10MiB limits. No text or filesystem paths.
- `POST /api/omni/voice/synthesis`: JSON `{sessionID, requestID, providerID, voiceID, text}`. Session/request IDs must be UUIDs. Returns authenticated `audio/mpeg` bytes, `Cache-Control: no-store, private`. Fixed voice/provider only; extra keys including file paths are refused.
- `DELETE /api/omni/voice/synthesis/:requestID`: JSON `{sessionID}`. Cancels exactly this request within the authenticated owner/vault/device (or browser credential) scope. A 60-second bounded tombstone handles DELETE arriving before POST. Cancellation cannot stop a newer session/request or another device.

One active request per credential, two globally, 30 starts/minute/credential, 30-second deadline, bounded request/child output and 10MiB audio. The native caller chunks long narration and cancels on stop, lock, sign-out or session replacement. Child processes receive an environment allowlist, never Prism tokens. Text uses stdin and is never logged; provider errors return fixed codes. Temporary audio lives in a generated 0700 directory with no public fetch route; completion/error/disconnect/cancel removes it after the process exits. Cancellation suppresses late bytes. SIGKILL follows SIGTERM after one second. A size monitor aborts growing oversized output. Service crash/host power loss may leave a private OS temporary directory; ordinary cancellation paths are tested, and no persistent shared voice cache is created.

## Named rollout (parent owns deployment)

Read `HANDOFF-LAPTOP.md` section 2 in the agent repository. No ad hoc production edits. Use the existing agent `scripts/deploy.sh prism <tag>` dry-run/tagged apply flow and health rollback. Do not restart Hermes or Telegram.

1. Merge reviewed Prism code, tag it, and run the existing deploy dry run. Record source tag/commit and verification. The native client can ship first: unconfigured backend advertises unavailable and uses Apple.
2. On the Mini, run the reviewed helper from the checked-out **tagged** Prism release. Dry-run is default:

   ```sh
   python3 apps/server/scripts/configure-omni-tts.py --server-dir /Users/benjaminlife/dev/prism/apps/server --hermes-root /Users/benjaminlife/.hermes/hermes-agent --python /Users/benjaminlife/.hermes/hermes-agent/venv/bin/python
   ```

   Review only its two nonsensitive path variables. Run the same command with `--apply` to create a private timestamped backup of existing `.env` / `.env.tmpl` and atomically update only `OMNI_TTS_HERMES_ROOT` and `OMNI_TTS_PYTHON`. It selects `.env.tmpl` if present, otherwise `.env`; every other setting and Keychain reference is preserved. It performs no restart and never prints existing environment contents.
3. Continue the existing tagged `deploy.sh` flow. Its existing `render_env` invokes `secrets.sh env-file` for templates and otherwise retains `.env`; its `pm2 restart prism-server` deliberately does not use `--update-env`, preserving production PATH. Do not add environment variables through shell-export/pm2 overrides. If deploying code first to obtain the tagged helper, run the same tagged deployment again after reviewed configuration to render/restart normally.
4. Verify owner-authenticated metadata reports available; then synthesize a **synthetic** sentence with a fresh request/session UUID and verify nonempty MP3, no-store and cancellation. Never put bearer tokens in argv/logs or use private text as a smoke test. Record only status/type/byte count/timing. Check owner/device isolation and native Apple fallback.
5. Rollback uses existing `deploy.sh` release rollback. To restore configuration, follow this named runbook: restore the exact prior `.env` and, when present, `.env.tmpl` from the helper's printed backup directory with mode 0600, then redeploy the prior verified tag through `deploy.sh`. Never print backup contents or copy them off the Mini.

Backend tests use synthetic injected providers and a fake Hermes generator; no tests call Microsoft or a live agent. Physical listening preference, network latency, interruption/cancel and mobile parity remain owner acceptance gates.

## Deferred existing audio attachments

The new synthesis endpoint speaks supplied completed reply prose; it does not deliver a pre-existing Hermes TTS file. Current Hermes API replies can contain `MEDIA:<local path>` but its resolver inlines images only. A media-only reply therefore has no narrated prose or usable audio reference today. The client filters file directives from narration and must not claim attachment playback or fetch a path taken from assistant text.

Proposed separately reviewed contract: the Hermes producer registers its actual generated audio in its existing principal-scoped artifact store and emits a trusted receipt. Omni persists a message-bound descriptor `{id, type:"audio", contentType, byteCount, sha256, durationSeconds?, expiresAt}` tied to thread/turn/message identity. An owner-authenticated `GET /api/omni/threads/:threadID/messages/:messageID/media/:mediaID` verifies that binding and receipt before bounded audio delivery, with no raw path/URL query, redirects, arbitrary filesystem fetch or public cache route. The native caller uses the same cancellation epoch and audio drain as prose synthesis, suppresses duplicate narration, and reports unavailable/expired media honestly. Hermes currently has a one-shot `/v1/artifacts/download/:artifact_id` route, but TTS output is not automatically registered there. Producer registration and message metadata must be implemented before this delivery can be claimed. Legacy path recovery is deferred.
