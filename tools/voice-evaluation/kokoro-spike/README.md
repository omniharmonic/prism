# Isolated Mac Kokoro measurement

This executable is an engineering spike, not an Omni speech backend. It uses a copy of the already-pinned FluidAudio v0.17.7 checkout (503b4bd1bbf7220882de39fe8ae6716aae4132da), default af_heart and v3. No playback, microphone or personal data is used. The package disables the optional NeMo trait; number/currency normalization therefore differs from a complete production frontend. Record that limitation in listening comparisons.

Public models are pinned individually in asset-manifest.json. download.py uses a 750,000,000-byte cap and verifies SHA-256 for LFS files or Git blob SHA-1 for ordinary files. The one-time evaluation cache lives at /private/tmp/omni-kokoro-cache. The generated base-index.json avoids a runtime directory-listing request. ModelHub.offlineMode is enabled before initialization; missing assets fail instead of downloading anything else.

Run `python3 prepare.py /path/to/the/existing/FluidAudio/checkout` to verify the SDK commit and prepare the temporary SDK copy at /private/tmp/omni-kokoro-fluid-audio from the existing checkout. Its only source change is a temporary cache seam at the start of TtsCacheDirectory.ensure(): when OMNI_TTS_EVALUATION_CACHE is set, create and return that directory. This redirects the SDK’s shared English frontend cache as well as v3 assets; it does not modify the production dependency or user cache. Run `python3 download.py` from this directory to prepopulate the pinned cache. The following command builds only this tool:

```
swift build --package-path tools/voice-evaluation/kokoro-spike --scratch-path /private/tmp/omni-kokoro-spike-build -c release
OMNI_TTS_EVALUATION_CACHE=/private/tmp/omni-kokoro-cache /private/tmp/omni-kokoro-spike-build/release/KokoroSpike /private/tmp/omni-apple-voice-baseline-valid/passages.json /private/tmp/omni-kokoro-first-three 3
```

Run in a foreground Mac subprocess with Core ML compilation available. Begin with three passages; extend to ten only after nonempty finite PCM succeeds. Every passage is rendered three times in the same initialized manager. JSON is written after each successful output so a process-level Core ML crash preserves earlier results.

Reported millisecondsToWholePCM measures completed PCM for the whole utterance, including text processing. It is not first streaming PCM or first audible latency. engineStageMilliseconds is the SDK’s narrower stage timing. peakRSSBytes is macOS process peak resident memory. This tool does not measure audible latency, subjective quality, underruns or a 15-minute soak. Keep those fields unmeasured until physical evaluation.

Retain ANE/LICENSE and mattmireles-LICENSE in the downloaded cache with the model files. The model repository card and selected conversion notices are Apache-2.0. No model files or rendered WAVs belong in Git.

### Hosted Mac worker preparation

The optional provider runs on the Mac host. Client devices request synthesis from the authenticated service. Preparation is an explicit operator action; inference uses the isolated SDK copy and `ModelHub.offlineMode = true` before initialization. This avoids changing offline behavior in the client's ASR/VAD process.

`download.py` now verifies by default. The reusable `assets.py` module validates immutable revisions, individual file sizes/checksums and relative paths, rejects symlinks within the selected cache, streams files instead of loading weights into memory, and publishes each verified download atomically. It never extracts archives. Both license notices in the manifest remain required. Missing or corrupt files fail before inference. Use `--download` only for installation; it preflights the missing-file byte budget before network access and rejects oversized responses.

On the existing evaluation Mac, reuse the retained cache without fetching assets:

```sh
python3 tools/voice-evaluation/kokoro-spike/download.py --cache /private/tmp/omni-kokoro-cache
```

For the Mini, choose a service-owned persistent cache directory, prepare the exact pinned SDK checkout with `prepare.py`, and install once with:

```sh
python3 tools/voice-evaluation/kokoro-spike/download.py --cache "$KOKORO_CACHE" --download --budget 750000000
```

Pass that identical absolute directory to the worker through `OMNI_TTS_EVALUATION_CACHE`. The SDK seam redirects both models and the independently loaded English frontend. Verify again before startup with the command above, omitting `--download`; if verification fails, the worker must refuse startup. Keep the SDK revision receipt, downloaded model notices and asset manifest available alongside deployment records. The default evaluation `/private/tmp` SDK copy and cache are temporary and may disappear after reboot; production deployment must deliberately select and retain its service-owned location. No model weights or generated speech belong in Git.

Run preparation safety tests with `python3 -m unittest discover -s tools/voice-evaluation/kokoro-spike -p 'test_assets.py'`.
