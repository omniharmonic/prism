#!/usr/bin/env python3
"""Omni's fixed Hermes Edge adapter. Input on stdin; no secrets/config loading.
The caller owns output-directory creation, deadline, process cancellation and cleanup.
"""
import asyncio
import importlib.metadata
import json
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("--check", "--synthesize"):
        raise ValueError("invalid invocation")
    root = Path(sys.argv[2]).resolve(strict=True)
    sys.path.insert(0, str(root))
    version = importlib.metadata.version("edge-tts")
    import edge_tts  # availability must verify import, not merely a dist-info record
    # Use the already installed Hermes generator with a fixed, non-secret config;
    # never invoke agent tools, arbitrary command providers or provider fallback.
    from tools.tts_tool import _generate_edge_tts
    if sys.argv[1] == "--check":
        print(json.dumps({"available": True, "version": version}))
        return
    body = json.loads(sys.stdin.buffer.read(32769))
    if set(body) != {"text", "voiceID", "output"}:
        raise ValueError("invalid payload")
    text = body["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("invalid text")
    if body["voiceID"] != "en-US-AriaNeural":
        raise ValueError("invalid voice")
    output = Path(body["output"])
    if not output.is_absolute() or output.name != "speech.mp3" or output.exists():
        raise ValueError("invalid output")
    asyncio.run(_generate_edge_tts(text, str(output), {"edge": {"voice": body["voiceID"], "speed": 1.0}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print provider exceptions (they can include spoken text or URLs).
        sys.stderr.write("voice_worker_failed\n")
        sys.exit(1)
