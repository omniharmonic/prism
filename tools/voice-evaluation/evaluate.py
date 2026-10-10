#!/usr/bin/env python3
"""Synthetic TTS corpus and offline render harness. No models or network access."""
import argparse
import csv
import json
from pathlib import Path
import subprocess
import time
import wave

PASSAGES = [
    "Yes, Benjamin. I'm here.",
    "Take your time. We can think this through together, and you can pause whenever you need to.",
    "Would you like to continue with Omni, or look at the full answer in Prism?",
    "The meeting is on October 10, 2026, at 10:30 a.m. Mountain Time.",
    "The estimate is $123.45, with a 3.5 percent adjustment and two remaining steps.",
    "First, open Prism. Then choose the note you want to review. Finally, tell Omni what you would like to change.",
    "Dr. Smith has three questions. The first is about version 2.1. The second is about the U.S. schedule. What's the third?",
    "I found the answer in the document. The detailed table and source link are available in the chat.",
    "The task is still running. I will show its progress in the conversation. Stopping my voice does not undo an action.",
    "There are several reasonable options. We can begin with the smallest change, hear how it feels, and adjust the next step. You do not need to decide everything now. If a detail needs more thought, leave it open. When you are ready, we can return to it together.",
]
FIELDS = ["passage_id", "phase", "repeat", "device", "os", "route", "engine", "voice", "revision", "rate", "render_wall_ms", "first_pcm_ms", "first_audible_ms", "underruns", "peak_ram_mb", "download_bytes", "cache_bytes", "naturalness_1_5", "intelligibility_1_5", "notes"]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--engine", default="unmeasured")
    parser.add_argument("--voice", default="unselected")
    parser.add_argument("--revision", default="unrecorded")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--renderer", nargs=argparse.REMAINDER, help="Optional local executable argv; {text} and {output} are substituted without a shell")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 20:
        parser.error("repeats must be 1 through 20")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = [{"id": f"p{i:02}", "text": text} for i, text in enumerate(PASSAGES, 1)]
    (args.output / "passages.json").write_text(json.dumps(manifest, indent=2) + "\n")
    with (args.output / "measurements.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for item in manifest:
            for repeat in range(1, args.repeats + 1):
                row = {"passage_id": item["id"], "phase": "unmeasured", "repeat": repeat, "engine": args.engine, "voice": args.voice, "revision": args.revision}
                if args.renderer:
                    audio = args.output / f'{item["id"]}-{repeat}.wav'
                    argv = [arg.replace("{text}", item["text"]).replace("{output}", str(audio)) for arg in args.renderer]
                    started = time.perf_counter()
                    subprocess.run(argv, check=True, timeout=180)
                    if not audio.is_file() or audio.stat().st_size == 0:
                        raise RuntimeError("renderer did not produce a nonempty output")
                    try:
                        with wave.open(str(audio), "rb") as rendered:
                            if rendered.getnframes() == 0 or not rendered.readframes(1):
                                raise RuntimeError("renderer produced a WAV with zero PCM frames")
                    except wave.Error as error:
                        raise RuntimeError("renderer produced an invalid PCM WAV") from error
                    row["render_wall_ms"] = round((time.perf_counter() - started) * 1000, 2)
                    row["phase"] = "process-per-render"
                    row["notes"] = "Wall time includes process startup; not first-audio or warm session latency."
                writer.writerow(row)
    print(f"Prepared {len(PASSAGES)} synthetic passages and {len(PASSAGES) * args.repeats} measurement rows in {args.output}")

if __name__ == "__main__":
    main()
