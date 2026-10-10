# OmniVoiceKit — V0 local speech bake-off

Open Settings → Open Local Speech Benchmark. This stage does not talk to the gateway or submit actions. It compares Apple SpeechAnalyzer's on-device SpeechTranscriber with Parakeet 0.6B English through pinned FluidAudio 0.17.7.

1. Edit the static names/organisations list, then Prepare Local Models. This explicitly requests speech permission and downloads missing Apple, Parakeet, vocabulary-scoring and Silero model assets. Audio is never uploaded. Unsupported Apple hardware/locales are reported; a remaining engine may still be exercised, but missing Apple results cannot satisfy acceptance.
2. Record 20 utterances each in quiet, outdoors and AirPods/car conditions (60 total). Do not record while driving. Include repeated names and organisations. Record requests microphone permission. One AVAudioEngine uses voice processing; backgrounding or leaving the screen stops capture, as does the 120-second limit.
3. Enter the exact words spoken once as corrected ground truth. Run Both Engines replays the identical local audio sequentially at real-time pace. Both adapters receive the seeded vocabulary; Parakeet uses actual CTC-assisted vocabulary rescoring.
4. Review per-setting weighted WER, seeded name error, mean first-word latency and speech-end → final latency. Individual hypotheses remain available. Delete Recording and Transcript removes both the audio and local metadata.

Recordings reside in app-private Application Support/OmniSpeechBench, excluded from backup. iOS audio files use complete file protection. There is no export/upload path. Model caches are managed by the respective frameworks. Final reports are on the device; source tests do not claim recognition quality.

Latency excludes model preparation. First word is measured from the start of real-time replay to the first nonempty hypothesis, so leading silence remains part of the measurement. End-to-final is measured from Silero's last unpadded speech end to the completed engine output; trailing recorded silence and finalization are included. Use short, consistent silence around recordings for comparable trials. This is a V0 measurement harness, not V1 endpointing or conversation orchestration.

Acceptance remains **pending owner recording and review**: at least 60 corrected personal utterances; quiet WER ≤5%; seeded name error ≤5%; chosen engine(s) no worse than Apple in all three settings. Build success and fixture tests do not establish those thresholds. On older iPads, record the explicit engine availability result rather than assuming SpeechTranscriber support.

Logic validation: `swift test --package-path swift/OmniVoiceKit` tests edits/insertions/deletions in WER, multiword name occurrence errors and volatile/final transcript handling. No model weights or personal recordings are needed for these tests. Integration requires building the Omni Xcode target and owner-authorized microphone/model preparation on physical hardware.
