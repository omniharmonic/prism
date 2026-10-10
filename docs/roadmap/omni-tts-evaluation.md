# Optional neural speech feasibility and repeatable listening protocol

Checkpoint: 2026-10-10, FluidAudio **v0.17.7**, researched from pinned sources and then measured in an isolated Mac-only offline spike. Apple premium/enhanced remains the accepted default. No neural backend is enabled by this change. The SDK already exists for VAD; importing its TTS API does not establish that assets, mobile reliability or owner preference pass our gates.

## Pinned API and asset findings

Pinned sources were retrieved through the GitHub connector after browser tag fetches failed. Verify the same tag and asset revisions before any build spike; current `main` documentation is not an API compatibility guarantee.

**Kokoro:** `KokoroAneManager(version: .v3)`, `initialize(preloadVoices:)`, and `synthesize(text:voice:)` provide a small adapter surface. V3 requires iOS 18/macOS 15, mixes CPU/ANE/GPU, downloads pinned model dependencies and voice packs, and compiles some assets on first load. It limits input to 510 phonemes and needs longer-answer chunking. Upstream says physical v3 device validation remains outstanding and retains Core ML crash advisories. Its fast desktop stage timings exclude loading and text processing. An isolated English af_heart spike now verifies a 213,544,176-byte pinned download including notices, 406,075,811 bytes of retained logical cache files after compilation, and 1,091,207,168-byte peak Mac RSS. **Decision: foreground Mac evaluation demonstrated; mobile backend deferred and no neural backend enabled in Omni.** [Pinned Kokoro documentation](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/TTS/KokoroAne.md).

**Pocket:** `PocketTtsManager.initialize()`, `synthesize(text:)`, and `makeSession(voice:)` are available. Sessions expose `enqueue`, `finish`, `cancel`, and asynchronous PCM frames. Four Core ML stages, constants and voice data are required. The pinned documentation's original English v2 table reports 766.3 MB fp16 or 549.3 MB int8 retained assets; these are not v2.1 download-byte or resident-memory measurements. Downloader transient content can exceed retained assets. V2.1 replaces conditioning/flow assets; do not assume the old totals describe the current default. Native named voices avoid a separate voice-cloning encoder download. **Decision: evaluate only after exact default asset manifest inventory; no mobile performance claim or download now.** [Pinned Pocket documentation](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/TTS/PocketTTS.md).

The [pinned FluidAudio SDK license](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/LICENSE) is Apache 2.0. [Kokoro's model card](https://huggingface.co/hexgrad/Kokoro-82M) lists Apache 2.0; selected conversion assets and individual voice provenance still require recording. Pocket's [code license](https://github.com/kyutai-labs/pocket-tts/blob/main/LICENSE) is permissive MIT-style, while FluidAudio documents its model weights as CC-BY-4.0. Do not treat a code license as a model/voice redistribution license. Keep exact weight, conversion and voice revisions plus required notices in the eventual asset manifest.

## Harness

Run `python3 tools/voice-evaluation/evaluate.py --output /private/tmp/omni-tts-evaluation`. This creates ten fixed synthetic passages and 30 blank measurement rows. No private chats, microphone recordings, network, dependencies or models are used. The corpus covers short answers, warmth, questions, names, dates, currency, abbreviations, instructions, task status and a longer reply.

An optional `--renderer` accepts local executable arguments with `{text}` and `{output}` substitutions, without a shell. Example, with an already installed Apple voice: `--engine apple --voice Samantha --renderer /usr/bin/say -v Samantha -o '{output}' --file-format=WAVE --data-format=LEI16@24000 '{text}'`. This renders files only; it does not play audio. Renderer wall time includes process startup and must never be called first-audio latency or a warm persistent-session benchmark. Nonzero exits, absent outputs, invalid PCM WAVs or zero PCM frames fail the run.

For the physical comparison, record device model/OS, route, selected voice identifier, speaking rate, engine/tag and asset revision. Use the same speaker/headset route, normal volume and randomized concealed engine labels. Owner scores intelligibility and naturalness 1–5 and states a preference. Keep unmeasured fields blank.

Instrument engine initialization separately from synthesis: clean-cache download/compile time and bytes; cold process with cached assets; then three warm passes in the same initialized engine. Timestamp text submission, first PCM, first audible playback and queue drain with a monotonic clock. Apple's audible latency requires actual playback observation/instrumentation; file rendering is insufficient. Capture underruns, peak resident memory and retained/transient cache bytes separately. Test cancellation and a 15-minute foreground conversational soak on Mac, phone and A12Z iPad, including speaker/headset and route changes. Measure battery/thermal behavior in the same run. Do not fold Hermes/network delay into engine latency.

Adopt an optional backend only after the owner prefers it, licenses/assets are pinned, and physical measurements demonstrate acceptable startup, continuous playback, memory and soak reliability. Until then the result is **feasible to measure, not accepted to ship**.

## Measured Mac-only spike — 2026-10-10

The isolated tool in `tools/voice-evaluation/kokoro-spike` built against the existing FluidAudio v0.17.7 commit `503b4bd1bbf7220882de39fe8ae6716aae4132da`. Its temporary SDK copy changes only the cache root to `/private/tmp`; production packages are untouched. All 57 downloaded files are pinned by size and SHA-256 or Git blob hash, including English frontend assets observed at immutable revision `d93c5f3eed11847fb81bd6d6a76665e133d7ca77`. The tool enables `ModelHub.offlineMode` before initialization, so missing assets fail instead of triggering additional downloads. See the checked-in [full download manifest](../../tools/voice-evaluation/kokoro-spike/asset-manifest.json) and [result summary](../../tools/voice-evaluation/kokoro-spike/result-summary-20261010.json).

Host: **Mac14,5 / Apple M2 Max / macOS 26.6.2**. Voice: **af_heart**, English v3. Three initial synthetic passages produced nine successful renders, followed by all ten passages with three repeated renders in one manager (30 finite, nonempty 24 kHz PCM WAVs). No playback or microphone was used.

| Measurement | Result | What was measured |
|---|---|---|
| Verified download, including license notices | 213,544,176 bytes | Below the 750 MB download cap; no inference-time model download |
| First initialization with local compilation | 21,215 ms | Models already downloaded; compilation/loading only |
| Later-process initialization with compiled cache | 872 ms | Loading before text submission |
| Warm completed PCM, median and range | 197 ms; 45–410 ms | Twenty second/third renders, including text processing, varying utterance lengths |
| Peak Mac process RSS | 1,091,207,168 bytes | macOS getrusage peak; not a mobile projection |
| Retained logical cache-file bytes | 406,075,811 bytes | After compilation; transient/system cache high-water remains unmeasured |

The initial short utterance took 3,288 ms to **whole-utterance PCM**, then 55/44 ms on repetition. The first longer passage took 3,624 ms, then 159/147 ms. First-use graph costs matter. These completed-output timings are not streaming first-PCM or first-audible latency. Six of 30 renders used the fast vocoder; longer inputs used the fallback path. The **NeMo normalization trait was disabled** in this small configuration, so numbers, dates and currency pronunciation remain a known evaluation limitation; no acceptance for those passages is claimed.

The first sandboxed Apple say/Samantha attempt emitted header-only zero-frame WAVs despite a successful exit. The harness now rejects them. One unsandboxed synthetic retry produced 49,704 frames, then all ten synthetic passages rendered valid Apple WAVs (1,536,642 total frames) without playback. This compares the installed **Samantha baseline**, not the owner's selected downloaded mobile voice.

Artifacts: `/private/tmp/omni-kokoro-ten/measurements.json`, `summary.json` and WAVs; `/private/tmp/omni-apple-voice-baseline-valid` for Apple WAVs. Suggested first audition: corresponding `p02-2.wav` (Kokoro) and `p02-1.wav` (Apple), followed by p03. No engineering listening or owner preference has been recorded. **Subjective naturalness, first-audible latency, underruns, playback cancellation, route changes, a 15-minute soak, transient disk peak and all iPhone/A12Z measurements remain unmeasured.** This proves a bounded foreground Mac evaluation is feasible, not that a neural backend is ready to ship.

## Narration integration

`SpeechText.narration(from:)` projects a **completed assistant response** into narration. Full Markdown stays in chat. It removes common display syntax, fenced code, images, table rows, reference definitions and explicit tool blocks; it preserves prose/numbers and never invents a summary. It is deliberately not a full Markdown renderer. Tool events must be excluded upstream. Code/table-only replies may yield empty narration.

Do not normalize independent arbitrary token or sentence deltas: punctuation in decimals, links, abbreviations and code can split across callbacks. Accumulate assistant text to verified completion before projecting it, or introduce a separately tested stateful structural parser before incremental playback. Queue drain and agent completion remain separate session conditions.
