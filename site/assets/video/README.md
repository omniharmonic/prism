# Launch video files

The landing page looks for these files here. Until they exist it shows a drawn
preview of the app instead, and the "Watch the full launch video" button stays hidden.

| File | What | Notes |
|---|---|---|
| `hero-loop.mp4` | Short silent loop for the hero | H.264, 16:9 (shown at 4:3.4, centre-cropped, on phones), 8–15 s, seamless loop, no audio track, ideally under 4 MB |
| `poster.jpg` | First frame of the loop | Same aspect ratio as the loop, ~1920 px wide, under 300 KB. Also shown instead of the loop when the visitor prefers reduced motion |
| `prism-launch-16x9.mp4` | Full launch video, landscape | H.264 + AAC, 1920×1080, `+faststart` (moov atom first) so it streams |
| `prism-launch-9x16.mp4` | Full launch video, portrait | Played instead on narrow portrait screens; 1080×1920, same encoding |

Encoding tip: `ffmpeg -i in.mov -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p -movflags +faststart -an hero-loop.mp4`
(drop `-an` and add `-c:a aac -b:a 160k` for the launch videos).

Keep each file under 100 MB (GitHub's file limit); a Pages site should stay well under 1 GB.
