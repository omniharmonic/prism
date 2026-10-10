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
