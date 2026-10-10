# Optional neural speech feasibility and repeatable listening protocol

Checkpoint: 2026-10-10, FluidAudio **v0.17.7**, researched without model downloads. Apple premium/enhanced remains the accepted default. No neural backend is enabled by this change. The SDK already exists for VAD; importing its TTS API does not establish that assets, mobile reliability or owner preference pass our gates.

## Pinned API and asset findings

Pinned sources were retrieved through the GitHub connector after browser tag fetches failed. Verify the same tag and asset revisions before any build spike; current `main` documentation is not an API compatibility guarantee.

**Kokoro:** `KokoroAneManager(version: .v3)`, `initialize(preloadVoices:)`, and `synthesize(text:voice:)` provide a small adapter surface. V3 requires iOS 18/macOS 15, mixes CPU/ANE/GPU, downloads pinned model dependencies and voice packs, and compiles some assets on first load. It limits input to 510 phonemes and needs longer-answer chunking. Upstream says physical v3 device validation remains outstanding and retains Core ML crash advisories. Its fast desktop stage timings exclude loading and text processing. Exact download/cache/RAM totals for the chosen English manifest remain unmeasured. **Decision: mobile backend deferred; a foreground Mac-only spike is feasible after asset inventory and an explicit download budget.** [Pinned Kokoro documentation](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/TTS/KokoroAne.md).

**Pocket:** `PocketTtsManager.initialize()`, `synthesize(text:)`, and `makeSession(voice:)` are available. Sessions expose `enqueue`, `finish`, `cancel`, and asynchronous PCM frames. Four Core ML stages, constants and voice data are required. The pinned documentation's original English v2 table reports 766.3 MB fp16 or 549.3 MB int8 retained assets; these are not v2.1 download-byte or resident-memory measurements. Downloader transient content can exceed retained assets. V2.1 replaces conditioning/flow assets; do not assume the old totals describe the current default. Native named voices avoid a separate voice-cloning encoder download. **Decision: evaluate only after exact default asset manifest inventory; no mobile performance claim or download now.** [Pinned Pocket documentation](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/Documentation/TTS/PocketTTS.md).

The [pinned FluidAudio SDK license](https://github.com/FluidInference/FluidAudio/blob/v0.17.7/LICENSE) is Apache 2.0. [Kokoro's model card](https://huggingface.co/hexgrad/Kokoro-82M) lists Apache 2.0; selected conversion assets and individual voice provenance still require recording. Pocket's [code license](https://github.com/kyutai-labs/pocket-tts/blob/main/LICENSE) is permissive MIT-style, while FluidAudio documents its model weights as CC-BY-4.0. Do not treat a code license as a model/voice redistribution license. Keep exact weight, conversion and voice revisions plus required notices in the eventual asset manifest.

## Harness

Run `python3 tools/voice-evaluation/evaluate.py --output /private/tmp/omni-tts-evaluation`. This creates ten fixed synthetic passages and 30 blank measurement rows. No private chats, microphone recordings, network, dependencies or models are used. The corpus covers short answers, warmth, questions, names, dates, currency, abbreviations, instructions, task status and a longer reply.

An optional `--renderer` accepts local executable arguments with `{text}` and `{output}` substitutions, without a shell. Example, with an already installed Apple voice: `--engine apple --voice Samantha --renderer /usr/bin/say -v Samantha -o '{output}' --file-format=WAVE --data-format=LEI16@24000 '{text}'`. This renders files only; it does not play audio. Renderer wall time includes process startup and must never be called first-audio latency or a warm persistent-session benchmark. Nonzero exits or absent outputs fail the run.

For the physical comparison, record device model/OS, route, selected voice identifier, speaking rate, engine/tag and asset revision. Use the same speaker/headset route, normal volume and randomized concealed engine labels. Owner scores intelligibility and naturalness 1–5 and states a preference. Keep unmeasured fields blank.

Instrument engine initialization separately from synthesis: clean-cache download/compile time and bytes; cold process with cached assets; then three warm passes in the same initialized engine. Timestamp text submission, first PCM, first audible playback and queue drain with a monotonic clock. Apple's audible latency requires actual playback observation/instrumentation; file rendering is insufficient. Capture underruns, peak resident memory and retained/transient cache bytes separately. Test cancellation and a 15-minute foreground conversational soak on Mac, phone and A12Z iPad, including speaker/headset and route changes. Measure battery/thermal behavior in the same run. Do not fold Hermes/network delay into engine latency.

Adopt an optional backend only after the owner prefers it, licenses/assets are pinned, and physical measurements demonstrate acceptable startup, continuous playback, memory and soak reliability. Until then the result is **feasible to measure, not accepted to ship**.

## Narration integration

`SpeechText.narration(from:)` projects a **completed assistant response** into narration. Full Markdown stays in chat. It removes common display syntax, fenced code, images, table rows, reference definitions and explicit tool blocks; it preserves prose/numbers and never invents a summary. It is deliberately not a full Markdown renderer. Tool events must be excluded upstream. Code/table-only replies may yield empty narration.

Do not normalize independent arbitrary token or sentence deltas: punctuation in decimals, links, abbreviations and code can split across callbacks. Accumulate assistant text to verified completion before projecting it, or introduce a separately tested stateful structural parser before incremental playback. Queue drain and agent completion remain separate session conditions.
