# v17 local TTS research receipt

2026-10-10. Branch docs/omni-v17-local-tts, isolated worktree /private/tmp/omni-v17-local-tts; source base fc64e1a7. Read HANDOFF-LAPTOP.md section 2 and the two voice roadmap documents. No production writes, app enablement, model downloads, inference, native builds, playback or subjective quality ratings. No compute slot consumed.

Primary-source shortlist, source links, device interpretation, current license/default/maintenance changes and bounded next experiment are in docs/roadmap/omni-tts-evaluation.md, “Additional local shortlist — v17”. Source pages were inspected through the web tool on this date; current mutable pages are discovery evidence only. Exact immutable code/model/frontend/voice revisions remain a prerequisite for execution.

Existing helpers located: tools/voice-evaluation/evaluate.py and tools/voice-evaluation/kokoro-spike. Existing /private/tmp audio/cache was left untouched. Research recommends explicit Kitten nano 0.8 int8 first, then Pocket manifest inventory, with Supertonic 3 reserved because upstream maintenance ended. Quality and all candidate memory/latency values remain unmeasured locally.

Validation: git diff --check; manual source-to-claim review. Documentation only, so no synthesis or native test run required.
