# Notices

Copyright (C) 2026 Benjamin Gleason Ross (https://github.com/omniharmonic/prism)

Prism is free software: you can redistribute it and/or modify it under the terms of the
[GNU Affero General Public License](LICENSE.md) as published by the Free Software
Foundation, version 3 (`AGPL-3.0-only`).

Prism is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

## In plain words (not a substitute for the licence)

- You may use, study, change and share Prism, including for your work and your business.
- If you share a changed copy, or **let people use a changed copy over a network** (for
  example by hosting it for them), you must offer them its complete source under the same
  licence. Prism helps with that: set `PRISM_SOURCE_URL` to where your source is, and every
  server links to it (`/api/version` and Settings → Advanced → About).

## Earlier versions

Until 2026-10-19 the README said "MIT License", but there was no licence file. Copies
obtained before that date keep whatever rights that statement gave. Versions from
2026-10-19 up to 0.9.1 were published under the PolyForm Shield License 1.0.0; copies of
those keep that licence. From 2026-11-07 on, Prism is licensed under the GNU AGPL-3.0.

Two commits from April 2026 (`12aeadf6`, `2af5bfe4`, legacy desktop vault client) were
contributed by Aaron Gabriel while the project said MIT. Those contributions are used
under the MIT licence:

> Copyright (c) 2026 Aaron Gabriel
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify,
> merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following
> conditions:
>
> The above copyright notice and this permission notice shall be included in all copies
> or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
> INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
> PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
> HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
> THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Parachute

Prism works with [Parachute](https://github.com/ParachuteComputer) (hub and vault),
which is licensed under the **GNU Affero General Public License v3.0**. Parachute is a
separate program: Prism talks to it over HTTP and runs its command-line tools. Prism
contains no Parachute code. (It used `@openparachute/scope-guard` until 2026-10-19;
Prism's own `apps/server/src/auth/hub-jwt.ts` replaced it.)

When a Prism host bundle includes Parachute, it ships the unmodified Parachute release
with its own licence and a link to the exact source of that release, as the AGPL
requires. Prism and Parachute are both under the AGPL-3.0.

## Other components

Prism's dependencies keep their own licences (mostly MIT, ISC, BSD and Apache-2.0).
Components under the file-level copyleft MPL-2.0 (`web-push`, `axe-core`, `lightningcss`,
and `dompurify`, which is used under its Apache-2.0 option) are used unmodified, and their
source is available from their upstream projects. A full list ships with each release.
The apps ship their full third-party list as `THIRD-PARTY-LICENSES.md`, inside the app (on the Mac: Help → Acknowledgements) and next to each Prism Client download.
