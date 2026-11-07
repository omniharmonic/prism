# Screenshots

The landing page loads these PNGs; while one is missing it shows a drawn placeholder in
its place. Use **sample data only** (no real names, addresses or messages), the default
dark theme, and no browser chrome around the app window.

| File | Shows | Size |
|---|---|---|
| `editor.png` | A page being edited live: a collaborator's cursor, one comment, one suggested edit | 1600×1000 (16:10), desktop |
| `database-board.png` | A database as a board grouped by status, a few properties on the cards | 1600×1000, desktop |
| `messages.png` | Messages: email and chat threads in one list, one thread open | 1600×1000, desktop |
| `mac.png` | Prism Client on a Mac: sidebar, an open page, properties under the title | 1600×1000, desktop |
| `iphone.png` | Prism on iPhone: a page with its properties, keyboard closed | 780×1688 (portrait), transparent background or a device frame |
| `web.png` | Prism in a browser (installed web app), e.g. Home or the calendar | 1600×1000, desktop |

Nice to have later: `calendar.png`, `graph.png`, `ipad.png`, light-theme variants.
Images are shown with `object-fit: cover` from the top left, so keep the important part
in the upper-left two thirds. Compress before committing (e.g. `pngquant --quality 70-90`).

The repository ignores `*.png`, so add these with `git add -f site/assets/shots/<file>.png`.
