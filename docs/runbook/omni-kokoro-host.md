# Kokoro on the paired Mac server

This named rollout adds an optional isolated speech process without restarting Hermes/Telegram, changing agent policy or writing vault content. Build17 is the owner-accepted iOS lifecycle baseline. Kokoro uses the existing authenticated route and playback lifecycle. Existing voice choices remain preserved; select Kokoro in Voice & Playback.

## Stage and verify

1. Verify the retained cache with checked-in `kokoro-spike/download.py --cache <cache>` (offline default): 57 pinned files, 213,544,176 bytes, including notices. Record model manifest and FluidAudio revision `503b4bd1bbf7220882de39fe8ae6716aae4132da`; only SDK change is the isolated cache-root seam.
2. Build `tools/voice-evaluation/kokoro-worker` Release, verify system-only dynamic libraries, run synthetic protocol/WAV/cancellation checks, and record executable SHA256.
3. Prepare a unique private `~/release-artifacts/omni-kokoro-v18` on the Mini. Transfer only checksummed runtime artifacts: `launch-kokoro.sh`, `bin/KokoroWorker`, `asset-tools/{assets.py,download.py,asset-manifest.json,base-index.json}`, and pinned original model files under `cache`. Compare archive SHA before extraction. Do not copy source checkout, environment, transcripts or local Core ML compilation products. The artifact launcher verifies original assets before every start.
4. Set `OMNI_TTS_EVALUATION_CACHE` to the absolute staged cache and run the launcher against synthetic protocol requests. Measure first warmup, output correctness, memory, cancellation/restart and a 15-minute sustained synthetic soak. No microphone, agent or real messages in this probe.

Initial Mini inventory: Mac16,10, 16GiB, macOS26.5.2. Owner subsequently upgraded to27.0.1; a separate full15-minute synthetic soak passed164 replies before production activation. See `qa/omni-voice-v18-tracker.md` for current activation receipts. The SDK flags intermittent Core ML BNNS crashes on this OS; its documented Mac fix is26.6. Process isolation contains failures but does not establish reliability. Do not activate if host soak fails. Do not silently update macOS. On-device iOS Kokoro stays disabled because the pinned SDK documents uncatchable crashes there.

## Activate tagged code

1. Merge/tag reviewed source and use agent `scripts/deploy.sh prism <tag>` dry-run then `--apply`, preserving normal health/rollback. Unconfigured servers spawn no worker.
2. In the clean tagged Mini checkout run `python3 apps/server/scripts/configure-omni-tts.py --server-dir /Users/benjaminlife/dev/prism/apps/server --kokoro-executable <release>/launch-kokoro.sh --kokoro-cache <release>/cache`. Review dry-run paths, then repeat with `--apply`. Only those two nonsensitive variables change; private backup preserves all existing Edge configuration and credentials.
3. Activate with a newer tagged deployment or the explicit configuration-only procedure in `omni-hermes-tts.md`: baseline health/desktop independence, existing template renderer, exactly `pm2 restart prism-server` without `--update-env`, and repeat health/worker checks. Same-tag deploy no-op does not activate configuration.
4. After warmup, run `node --env-file=.env --import tsx scripts/verify-omni-tts.ts kokoro-local` from tagged apps/server. This creates/deletes only its short-lived owner session, uses fixed synthetic text, checks WAV and scoped cancellation, and never logs credentials. Keep the existing Edge smoke valid too.
5. Install matching native client. Verify preview, long reply, interruption and return to Listening physically. Kokoro falls back to Apple, never silently to Microsoft. Readiness is honest: after cold start a reply may use Apple until the worker is ready. Record device acceptance separately.

## Rollback

Restore the config helper's exact private env/template backup and activate with the existing configuration-only runbook; deploy the prior server tag if needed. Check old workers exit on closed stdin/service shutdown. Retain accepted build17 and previous app bundle. No vault, model or credential deletion is required.
